// Runnable check for the DeepSeek service with the network stubbed. It guards the
// two things specific to the DeepSeek transport (the OpenAI-style
// /chat/completions call with Bearer auth + system/user messages, and the
// choices[0].message.content parse) plus the shared fallback-to-mock. The prompt
// building and JSON parsing are inherited from ClaudeAIService and already
// covered by claude.check.ts. Run with `pnpm check:deepseek` (tsx).

import { DeepSeekAIService } from './DeepSeekAIService';

function ok(value: unknown, msg?: string): asserts value {
  if (!value) throw new Error(msg ?? 'assertion failed');
}
function eq<T>(actual: T, expected: T, msg?: string): void {
  if (actual !== expected) {
    throw new Error(`${msg ?? 'not equal'}: got ${String(actual)}, want ${String(expected)}`);
  }
}

let checks = 0;
const check = async (label: string, fn: () => Promise<void>): Promise<void> => {
  await fn();
  checks++;
  console.log(`  ok  ${label}`);
};

let lastUrl = '';
let lastHeaders: Record<string, string> = {};
let lastBody: Record<string, unknown> = {};

const reply = (text: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: text } }] }),
  }) as Response;

const stubFetch = (async (url: string, init?: RequestInit) => {
  lastUrl = String(url);
  lastHeaders = (init?.headers ?? {}) as Record<string, string>;
  lastBody = JSON.parse(String(init?.body ?? '{}'));
  const system = String((lastBody.messages as Array<{ content: string }>)?.[0]?.content ?? '');
  if (system.includes('four-part lesson')) {
    return reply(
      JSON.stringify({
        title: 'Acids and Bases',
        summary: 'How acids and bases differ.',
        sections: [{ title: 'What is a base?', kind: 'explanation', body: 'A base accepts protons.' }],
      }),
    );
  }
  return reply('hello from deepseek');
}) as unknown as typeof fetch;

const failFetch = (async () =>
  ({ ok: false, status: 503, json: async () => ({}) }) as Response) as unknown as typeof fetch;

async function main(): Promise<void> {
  const ai = new DeepSeekAIService({ apiKey: 'test-key', fetchImpl: stubFetch });

  await check('deepseek speaks /chat/completions with Bearer auth and system+user messages', async () => {
    const draft = await ai.draftLesson({ topic: 'acids and bases' });
    eq(draft.title, 'Acids and Bases', 'lesson parsed from choices[0].message.content');
    ok(lastUrl.endsWith('/chat/completions'), 'hits the OpenAI-style endpoint');
    eq(lastHeaders.authorization, 'Bearer test-key', 'uses Bearer auth');
    eq(lastBody.model, 'deepseek-chat', 'defaults to the cheap non-reasoning model');
    const messages = lastBody.messages as Array<{ role: string }>;
    eq(messages.length, 2, 'system + user messages');
    eq(messages[0].role, 'system');
    eq(messages[1].role, 'user');
  });

  const failing = new DeepSeekAIService({ apiKey: 'test-key', fetchImpl: failFetch });

  await check('a failed deepseek call falls back to the deterministic mock', async () => {
    const draft = await failing.draftLesson({ topic: 'acids and bases' });
    eq(draft.sections.length, 4, 'mock lesson shape');
  });

  console.log(`\n${checks} DeepSeek-service checks passed.`);
}

void main();
