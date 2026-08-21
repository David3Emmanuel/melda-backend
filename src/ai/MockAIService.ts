// Deterministic stand-in for a real language model. Same output every run, so
// demos and the runnable check are reproducible. A small artificial latency
// makes the UI's "generating..." state feel real; the check passes latencyMs: 0.
//
// This is intentionally templated, not clever: it produces coherent, on-topic
// teacher-facing prose keyed to the concept and mode. When a real
// ClaudeAIService replaces it (see ./index.ts), the interface does not change.

import type {
  AdaptationMode,
  AdaptSectionInput,
  AdaptationDraft,
  DraftLessonInput,
  DraftQuizInput,
  LessonDraft,
  NarrateInsightInput,
  QuizDraft,
  QuizDraftQuestion,
} from 'melda-shared';
import type { AnswerQuestionInput, StudentAIService } from './student';

const delay = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

const titleCase = (s: string): string =>
  s
    .trim()
    .split(/\s+/)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');

// Each mode reframes the same section a different way. The copy is generic in
// its pedagogy but always names the concept, so it reads as a real adaptation.
const MODE_PARAGRAPH: Record<AdaptationMode, (concept: string) => string> = {
  simpler: (c) =>
    `Here is ${c} with the jargon stripped out. Anchor it to one plain idea students already believe, then add nothing else until that idea is solid. If they remember a single sentence, this is the one.`,
  detailed: (c) =>
    `Go one level deeper on ${c}. Do not just state the rule - show why it has to be true, step by step, so a curious student sees the mechanism rather than a fact to memorise.`,
  example: (c) =>
    `Ground ${c} in something from the students' own day. Walk through one concrete, familiar situation end to end, name each part as it maps onto the concept, and only then generalise.`,
  visual: (c) =>
    `Put ${c} on the board as a picture. Sketch the pieces and draw arrows for what moves or changes. Students who get lost in words often unlock the idea the moment they can see it.`,
  practice: (c) =>
    `Turn ${c} into something students do, not hear. Give a short task, have them attempt it in pairs, then compare reasoning. The struggle of trying is where the understanding sticks.`,
  reexplain: (c) =>
    `Same idea, new doorway. Explain ${c} again from a different starting point than the textbook took - a story, a question, or the end result first. A second path reaches the students the first one missed.`,
};

export interface MockAIServiceOptions {
  latencyMs?: number;
}

export class MockAIService implements StudentAIService {
  private readonly latencyMs: number;

  constructor(options: MockAIServiceOptions = {}) {
    this.latencyMs = options.latencyMs ?? 0;
  }

  async draftLesson(input: DraftLessonInput): Promise<LessonDraft> {
    await delay(this.latencyMs);
    const topic = input.topic.trim() || 'a new concept';
    const title = titleCase(topic);
    const grade = input.gradeLevel ? ` for ${input.gradeLevel}` : '';
    const notes = input.notes?.trim() ? ` It keeps in mind: ${input.notes.trim()}.` : '';
    return {
      title,
      summary: `A starter lesson introducing ${topic}${grade}.${notes}`,
      sections: [
        {
          title: `What is ${topic}?`,
          kind: 'explanation',
          body: `Open by connecting ${topic} to what students already know, then give the one core idea in a single clear sentence before adding any detail.`,
        },
        {
          title: 'Worked example',
          kind: 'example',
          body: `Walk through one concrete example of ${topic} slowly, naming each step out loud so students can follow the reasoning, not just the answer.`,
        },
        {
          title: 'Guided activity',
          kind: 'activity',
          body: `Have students try a short ${topic} task in pairs while you circulate. Listen for the wrong turns - those are what the next lesson should target.`,
        },
        {
          title: 'Quick check',
          kind: 'check',
          body: `Ask one question that reveals whether students truly grasped ${topic}, not just whether they can repeat the definition.`,
        },
      ],
    };
  }

  async draftQuiz(input: DraftQuizInput): Promise<QuizDraft> {
    await delay(this.latencyMs);
    const topic = input.topic.trim() || 'this topic';
    const count = Math.max(1, Math.min(input.count ?? 4, 10));
    // Templated question stems, cycled so a quiz of any length reads varied. The
    // correct choice plainly affirms the topic; distractors are labelled
    // misconceptions. A real ClaudeAIService (see ./index.ts) writes genuine
    // questions - this only needs to be coherent and gradeable.
    const stems = [
      (t: string) => `Which statement about ${t} is correct?`,
      (t: string) => `What best defines ${t}?`,
      (t: string) => `Which is a valid example of ${t}?`,
      (t: string) => `A student describes ${t}. Which description is right?`,
      (t: string) => `Which of these is true of ${t}?`,
    ];
    const questions: QuizDraftQuestion[] = Array.from({ length: count }, (_, i) => {
      // Rotate the answer key so it is not always choice A.
      const correctIndex = i % 4;
      const choices = [0, 1, 2, 3].map((j) =>
        j === correctIndex
          ? `A correct statement about ${topic}`
          : `A common misconception about ${topic} (${j + 1})`,
      );
      return { prompt: stems[i % stems.length](topic), choices, correctIndex };
    });
    return { title: `${titleCase(topic)} Review`, questions };
  }

  async adaptSection(input: AdaptSectionInput): Promise<AdaptationDraft> {
    await delay(this.latencyMs);
    const concept = input.conceptName.toLowerCase();
    const context =
      input.strugglePct && input.strugglePct > 0
        ? `${input.strugglePct}% of the class struggled with "${input.sectionTitle}", so here is a ${input.mode} take. `
        : '';
    return {
      mode: input.mode,
      body: context + MODE_PARAGRAPH[input.mode](concept),
    };
  }

  async narrateInsight(input: NarrateInsightInput): Promise<string> {
    await delay(this.latencyMs);
    const { className, studentCount, topConceptName, topStrugglePct, avgMasteryPct } = input;
    if (topStrugglePct <= 0) {
      return `${className} is in good shape: across ${studentCount} students, average mastery is ${avgMasteryPct}% and no concept stands out as a problem yet.`;
    }
    return (
      `Across ${className}'s ${studentCount} students, average mastery sits at ${avgMasteryPct}%. ` +
      `The clear pain point is ${topConceptName}, where ${topStrugglePct}% are struggling. ` +
      `Consider re-teaching ${topConceptName} with a simpler framing or a fresh example before moving on.`
    );
  }

  // A patient, on-topic tutor reply. Deterministic (no model), so it reads as a
  // real answer keyed to the lesson and question without inventing facts: it
  // points the student back at the relevant part and models how to check
  // themselves. The real ClaudeAIService (see ./index.ts) writes a genuine answer.
  async answerQuestion(input: AnswerQuestionInput): Promise<{ answer: string }> {
    await delay(this.latencyMs);
    const q = input.question.trim().replace(/\s+/g, ' ') || 'that';
    const focus = input.sectionTitle ? `"${input.sectionTitle}"` : `"${input.lessonTitle}"`;
    return {
      answer:
        `Good question. In ${input.lessonTitle}, the part that speaks to "${q}" is ${focus}. ` +
        `Read that again and put it in your own words - name the key idea first, then one example. ` +
        `If you can explain it back without looking, you've got it; if not, tell me which step loses you.`,
    };
  }
}
