// Runnable check for the real Claude service, with the network stubbed so it
// runs offline and deterministically. It guards the two things that matter:
// (1) a well-formed API reply is parsed into the app's shapes - including JSON
// buried in prose/fences, a bad section kind, and an out-of-range answer index;
// (2) ANY failure falls back to the mock rather than throwing. Run with
// `pnpm check:claude` (tsx).

import { ClaudeAIService } from './ClaudeAIService';

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

// A fetch that answers each method with a canned Messages API response, chosen
// by inspecting the system prompt. The lesson reply is deliberately wrapped in
// prose + a ```json fence, carries an invalid kind ("nonsense"), and the quiz
// reply has an out-of-range correctIndex - all of which the parser must handle.
const reply = (text: string) =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ type: 'text', text }] }),
  }) as Response;

const stubFetch = (async (_url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const system: string = body.system ?? '';
  if (system.includes('multiple-choice')) {
    return reply(
      JSON.stringify({
        title: 'Photosynthesis Review',
        questions: [
          {
            prompt: 'What does photosynthesis produce?',
            choices: ['Glucose', 'Rust', 'Salt', 'Ash'],
            correctIndex: 0,
          },
          // correctIndex 9 is out of range and must be clamped to the last choice.
          { prompt: 'Where does it happen?', choices: ['Nucleus', 'Chloroplast'], correctIndex: 9 },
        ],
      }),
    );
  }
  if (system.includes('four-part lesson')) {
    return reply(
      'Sure, here is a draft:\n```json\n' +
        JSON.stringify({
          title: 'Photosynthesis',
          summary: 'How plants make food from light.',
          sections: [
            { title: 'What is it?', kind: 'explanation', body: 'Plants turn light into sugar.' },
            { title: 'A day in a leaf', kind: 'nonsense', body: 'Follow one photon.' },
          ],
        }) +
        '\n```',
    );
  }
  if (system.includes('re-explain')) return reply('   A simpler take on ionic bonding.   ');
  return reply('Grade 10 Chemistry is doing well; ionic bonding is the one to watch.');
}) as unknown as typeof fetch;

// A fetch that always errors, to exercise the fallback-to-mock path.
const failFetch = (async () =>
  ({ ok: false, status: 503, json: async () => ({}) }) as Response) as unknown as typeof fetch;

async function main(): Promise<void> {
  const ai = new ClaudeAIService({ apiKey: 'test-key', fetchImpl: stubFetch });

  await check('draftLesson parses JSON out of fenced prose and coerces a bad kind', async () => {
    const draft = await ai.draftLesson({ topic: 'photosynthesis' });
    eq(draft.title, 'Photosynthesis');
    eq(draft.sections.length, 2, 'both sections survive');
    eq(draft.sections[0].kind, 'explanation', 'valid kind kept');
    eq(draft.sections[1].kind, 'explanation', 'invalid kind coerced to explanation');
  });

  await check('draftQuiz maps questions and clamps an out-of-range answer index', async () => {
    const quiz = await ai.draftQuiz({ topic: 'photosynthesis', count: 2 });
    eq(quiz.questions.length, 2);
    eq(quiz.questions[0].correctIndex, 0);
    // choices=['Nucleus','Chloroplast'], so index 9 clamps to 1.
    eq(quiz.questions[1].correctIndex, 1, 'clamped to last valid choice');
  });

  await check('adaptSection returns trimmed prose with the mode preserved', async () => {
    const out = await ai.adaptSection({
      conceptName: 'Ionic Bonding',
      sectionTitle: 'What is an ionic bond?',
      originalBody: 'One atom gives an electron to another.',
      mode: 'simpler',
    });
    eq(out.mode, 'simpler');
    eq(out.body, 'A simpler take on ionic bonding.', 'leading/trailing space trimmed');
  });

  await check('narrateInsight returns the model prose', async () => {
    const text = await ai.narrateInsight({
      className: 'Grade 10 Chemistry',
      studentCount: 25,
      topConceptName: 'Ionic Bonding',
      topStrugglePct: 32,
      avgMasteryPct: 74,
    });
    ok(text.includes('ionic bonding'), 'narration came back');
  });

  const failing = new ClaudeAIService({ apiKey: 'test-key', fetchImpl: failFetch });

  await check('a failed API call falls back to the deterministic mock', async () => {
    // Mock draftLesson always returns exactly four sections; the stub gave two,
    // so four proves we fell through to the mock.
    const draft = await failing.draftLesson({ topic: 'photosynthesis' });
    eq(draft.sections.length, 4, 'mock lesson shape');
    // Mock narrateInsight echoes the real struggle percentage.
    const text = await failing.narrateInsight({
      className: 'Grade 10 Chemistry',
      studentCount: 25,
      topConceptName: 'Ionic Bonding',
      topStrugglePct: 32,
      avgMasteryPct: 74,
    });
    ok(text.includes('32%'), 'mock narration used the given number');
  });

  console.log(`\n${checks} Claude-service checks passed.`);
}

void main();
