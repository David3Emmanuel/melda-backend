// Runnable check for the mock AI. Guards the two things that would silently
// break the CREATE flow if the templating drifted: every adaptation mode must
// produce distinct, on-topic copy, and the drafts/narration must actually
// mention what they were asked about. Run with `pnpm check:ai` (tsx).

import type { AdaptationMode } from 'melda-shared';
import { MockAIService } from './MockAIService';

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

const ai = new MockAIService({ latencyMs: 0 });

async function main(): Promise<void> {
  await check('draftLesson names the topic in every section', async () => {
    const draft = await ai.draftLesson({ topic: 'photosynthesis' });
    eq(draft.title, 'Photosynthesis');
    eq(draft.sections.length, 4);
    for (const s of draft.sections) ok(s.body.toLowerCase().includes('photosynthesis'), s.title);
    const kinds = draft.sections.map((s) => s.kind);
    ok(kinds.includes('explanation') && kinds.includes('check'));
  });

  await check(
    'draftQuiz returns the asked-for count with in-range, topic-named questions',
    async () => {
      const quiz = await ai.draftQuiz({ topic: 'acids and bases', count: 5 });
      ok(quiz.title.toLowerCase().includes('acids and bases'), 'title names the topic');
      eq(quiz.questions.length, 5, 'one question per requested count');
      for (const q of quiz.questions) {
        eq(q.choices.length, 4, 'four choices');
        ok(q.correctIndex >= 0 && q.correctIndex < q.choices.length, 'correct index is in range');
        ok(q.prompt.toLowerCase().includes('acids and bases'), 'prompt names the topic');
        ok(
          q.choices[q.correctIndex].toLowerCase().includes('correct'),
          'the key points at a real answer',
        );
      }
      // Answer key must vary, not sit on choice A every time.
      ok(
        new Set(quiz.questions.map((q) => q.correctIndex)).size > 1,
        'the answer key is not constant',
      );
    },
  );

  await check('adaptSection produces distinct, concept-named copy for all six modes', async () => {
    const modes: AdaptationMode[] = [
      'simpler',
      'detailed',
      'example',
      'visual',
      'practice',
      'reexplain',
    ];
    const bodies = new Set<string>();
    for (const mode of modes) {
      const out = await ai.adaptSection({
        conceptName: 'Ionic Bonding',
        sectionTitle: 'What is an ionic bond?',
        originalBody: 'One atom gives an electron to another.',
        mode,
      });
      eq(out.mode, mode);
      ok(out.body.includes('ionic bonding'), `${mode} names the concept`);
      bodies.add(out.body);
    }
    eq(bodies.size, modes.length, 'each mode is different');
  });

  await check('adaptSection folds in the struggle percentage when given', async () => {
    const out = await ai.adaptSection({
      conceptName: 'Ionic Bonding',
      sectionTitle: 'What is an ionic bond?',
      originalBody: 'One atom gives an electron to another.',
      mode: 'simpler',
      strugglePct: 32,
    });
    ok(out.body.startsWith('32%'));
  });

  await check('adaptSection honours the teacher instruction for custom mode', async () => {
    const out = await ai.adaptSection({
      conceptName: 'Ionic Bonding',
      sectionTitle: 'What is an ionic bond?',
      originalBody: 'One atom gives an electron to another.',
      mode: 'custom',
      customInstruction: 'use a basketball pass as the analogy',
    });
    eq(out.mode, 'custom');
    ok(out.body.includes('basketball'), 'custom copy follows the teacher instruction');
  });

  await check(
    'narrateInsight reports the real number, and has a healthy-class branch',
    async () => {
      const hot = await ai.narrateInsight({
        className: 'Grade 10 Chemistry',
        studentCount: 25,
        topConceptName: 'Ionic Bonding',
        topStrugglePct: 32,
        avgMasteryPct: 74,
      });
      ok(hot.includes('32%') && hot.includes('Ionic Bonding'));
      const calm = await ai.narrateInsight({
        className: 'Grade 10 Chemistry',
        studentCount: 25,
        topConceptName: 'Ionic Bonding',
        topStrugglePct: 0,
        avgMasteryPct: 95,
      });
      ok(calm.includes('good shape'));
    },
  );

  console.log(`\n${checks} AI checks passed.`);
}

void main();
