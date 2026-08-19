// The server: assembly, hardening, and startup. Kept thin - all behaviour is in
// the router; this file wires cross-cutting concerns (CORS locked to the app
// origins, a small JSON body cap, rate limits on the two abusable surfaces) and
// owns the lifecycle (run migrations, seed the demo class if the DB is empty,
// listen). It exports `app` + `ready` so api.check.ts can drive it on an
// ephemeral port without a live Postgres or a fixed port.

import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { migrateDb, usingPglite } from './db/client';
import { db } from './db/client';
import * as t from './db/schema';
import { seed } from './db/seed';
import { router } from './http/routes';

const PORT = Number(process.env.PORT) || 4000;
const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:8081,http://localhost:19006'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const app = express();

app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json({ limit: '100kb' }));

// Rate-limit the two surfaces worth abusing: credential stuffing on /auth and
// the (paid, model-backed) /ai proxy. Everything else is cheap DB reads.
app.use('/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 50 }));
app.use('/ai', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40 }));

app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.use(router);

// Error handler (Express 5 forwards async rejections here). A failed zod parse is
// the client's fault -> 400 with the issues; anything else is ours -> 500 with a
// generic message, never the stack or a DB detail.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'invalid request', issues: err.issues });
    return;
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

/** Run migrations and seed the demo class if the database is empty. Idempotent. */
export async function ready(): Promise<void> {
  await migrateDb();
  const [existing] = await db.select().from(t.classes).limit(1);
  if (!existing) {
    const result = await seed();
    console.log(`Seeded demo class ${result.classId} (${result.teacher} / see db/seed.ts).`);
  }
}

if (require.main === module) {
  ready()
    .then(() => {
      app.listen(PORT, () => {
        const driver = usingPglite ? 'PGlite (in-process)' : 'Postgres (DATABASE_URL)';
        console.log(`MELDA backend on http://localhost:${PORT} using ${driver}`);
      });
    })
    .catch((err) => {
      console.error('Failed to start:', err);
      process.exit(1);
    });
}
