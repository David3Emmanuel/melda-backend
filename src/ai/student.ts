// The student-facing slice of the AI. The teacher methods live in melda-shared's
// AIService (draftLesson/draftQuiz/adaptSection/narrateInsight); this adds the one
// method a student needs - ask a question about the lesson they're reading - as a
// backend-local extension so the shared contract doesn't have to be republished
// just for it. Both MockAIService and ClaudeAIService implement this wider
// interface, so ai/index.ts can type the singleton as a StudentAIService.
//
// The ask is stateless: the lesson context is passed in per call and no history is
// stored server-side (the student app keeps its own on-device transcript).

import type { AIService } from 'melda-shared';

export interface AnswerQuestionInput {
  /** The student's question, verbatim. */
  question: string;
  /** The lesson they're reading, for grounding the answer. */
  lessonTitle: string;
  /** The section they asked from, if any (narrows the framing). */
  sectionTitle?: string;
  /** Lesson text the model may draw on - summary + section bodies. */
  context: string;
}

export interface StudentAIService extends AIService {
  answerQuestion(input: AnswerQuestionInput): Promise<{ answer: string }>;
}
