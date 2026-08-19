// Runnable check for the auth seam that replaced "pick any name": a password
// hashes and verifies (and a wrong password is rejected), and a JWT minted by
// signToken verifies back to the same principal while a tampered token is
// rejected. Pure crypto - no DB rows, no network. `pnpm check:auth` (tsx).

import type { AuthUser } from 'melda-shared';

process.env.DATABASE_URL = ''; // importing db/client (via auth) must not hit Postgres
process.env.PGLITE_DIR = 'memory://'; // ...nor create a file-backed PGlite dir

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  passed++;
  console.log('  ok -', msg);
}
function eq<T>(actual: T, expected: T, msg: string) {
  ok(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}
async function rejects(fn: () => unknown, msg: string) {
  try {
    await fn();
  } catch {
    passed++;
    console.log('  ok -', msg);
    return;
  }
  throw new Error('FAIL: expected a throw - ' + msg);
}

async function main() {
  const { hashPassword, verifyPassword, signToken, verifyToken } = await import('./auth.js');

  console.log('auth primitives');

  // 1. hashing round-trips and rejects the wrong password
  const secret = 'correct horse battery staple';
  const hash = await hashPassword(secret);
  ok(hash !== secret, 'the hash is not the plaintext');
  ok(await verifyPassword(secret, hash), 'the correct password verifies');
  ok(!(await verifyPassword(secret + '!', hash)), 'a wrong password is rejected');

  // 2. a signed token verifies back to the exact principal
  const user: AuthUser = {
    id: 't-demo',
    role: 'teacher',
    name: 'Ms. Ada Okeke',
    email: 'teacher@melda.africa',
  };
  const token = signToken(user);
  const decoded = verifyToken(token);
  eq(decoded.id, user.id, 'subject round-trips as the id');
  eq(decoded.role, user.role, 'role round-trips');
  eq(decoded.name, user.name, 'name round-trips');
  eq(decoded.email, user.email, 'email round-trips');

  // 3. tampering is rejected - any single-char change breaks the HMAC signature
  const tampered = token.slice(0, -1) + (token.slice(-1) === 'A' ? 'B' : 'A');
  await rejects(() => verifyToken(tampered), 'a tampered token is rejected');
  await rejects(() => verifyToken('not.a.jwt'), 'a malformed token is rejected');

  console.log(`\nAll ${passed} assertions passed.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
