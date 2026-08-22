// A real Claude-backed AIService. It implements the exact same interface as
// MockAIService, so ai/index.ts swaps to it with a single line and nothing else
// in the app changes.
//
// It talks to the Anthropic Messages API directly over fetch - no SDK
// dependency - and on ANY failure (no key, network down, malformed reply) it
// falls back to the mock, so the app never breaks in front of a class. As with
// the mock, MELDA only asks the model to write prose and questions; the real
// class numbers are always computed in melda-shared/insights and passed in here
// purely to be narrated, never invented by the model.
//
// Security: this runs on the backend, so the API key lives in the server's
// environment (ANTHROPIC_API_KEY) and is never shipped to either app. The apps
// call the backend's /ai/* proxy; the key never leaves the server.

import type {
  SectionKind,
  AdaptSectionInput,
  AdaptationDraft,
  DraftLessonInput,
  DraftQuizInput,
  LessonDraft,
  NarrateInsightInput,
  QuizDraft,
} from 'melda-shared';
import type { AnswerQuestionInput, StudentAIService } from './student';
import { MockAIService } from './MockAIService';

const ANTHROPIC_BASE = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
const API_URL = `${ANTHROPIC_BASE}/v1/messages`;
const SECTION_KINDS: SectionKind[] = ['explanation', 'example', 'activity', 'check'];

export interface ClaudeAIServiceOptions {
  apiKey: string;
  /** Defaults to the latest general-purpose Claude. */
  model?: string;
  /** Injectable so the runnable check can stub the network. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class ClaudeAIService implements StudentAIService {
  protected readonly apiKey: string;
  protected readonly model: string;
  protected readonly fetchImpl: typeof fetch;
  // Every method delegates here when the model call fails, so the UI degrades to
  // deterministic-but-coherent output instead of an error.
  protected readonly fallback = new MockAIService({ latencyMs: 0 });

  constructor(options: ClaudeAIServiceOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model?.trim() || 'claude-sonnet-5';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async draftLesson(input: DraftLessonInput): Promise<LessonDraft> {
    try {
      const grade = input.gradeLevel ? ` for ${input.gradeLevel}` : '';
      const notes = input.notes?.trim() ? ` Keep in mind: ${input.notes.trim()}.` : '';
      const draft = await this.json<LessonDraft>(
        'You are MELDA, a teaching assistant. Draft a short four-part lesson. Respond with ONLY JSON of the form ' +
          '{"title":"","summary":"","sections":[{"title":"","kind":"","body":""}]}. ' +
          'kind is one of: explanation, example, activity, check.',
        `Topic: ${input.topic}${grade}.${notes}`,
        1200,
      );
      const sections = (draft.sections ?? []).map((s) => ({
        title: String(s.title),
        kind: SECTION_KINDS.includes(s.kind) ? s.kind : 'explanation',
        body: String(s.body),
      }));
      if (!draft.title || sections.length === 0) throw new Error('empty lesson');
      return { title: String(draft.title), summary: String(draft.summary ?? ''), sections };
    } catch {
      return this.fallback.draftLesson(input);
    }
  }

  async draftQuiz(input: DraftQuizInput): Promise<QuizDraft> {
    try {
      const count = Math.max(1, Math.min(input.count ?? 4, 10));
      const grade = input.gradeLevel ? ` for ${input.gradeLevel}` : '';
      const draft = await this.json<QuizDraft>(
        `You are MELDA. Write ${count} multiple-choice questions, each with exactly four choices and one correct answer. ` +
          'Respond with ONLY JSON of the form {"title":"","questions":[{"prompt":"","choices":["","","",""],"correctIndex":0}]}.',
        `Topic: ${input.topic}${grade}.`,
        1600,
      );
      const questions = (draft.questions ?? [])
        .filter((q) => Array.isArray(q.choices) && q.choices.length >= 2)
        .map((q) => ({
          prompt: String(q.prompt),
          choices: q.choices.map(String),
          // Clamp into range so a bad index can never crash grading.
          correctIndex: Math.max(0, Math.min(Number(q.correctIndex) || 0, q.choices.length - 1)),
        }));
      if (questions.length === 0) throw new Error('no questions');
      return { title: String(draft.title || `${input.topic} Review`), questions };
    } catch {
      return this.fallback.draftQuiz(input);
    }
  }

  async adaptSection(input: AdaptSectionInput): Promise<AdaptationDraft> {
    try {
      const ctx =
        input.strugglePct && input.strugglePct > 0
          ? ` About ${input.strugglePct}% of the class struggled with this section.`
          : '';
      const body = await this.text(
        `You are MELDA, helping a teacher re-explain a concept for students who did not get it. ` +
          `Rewrite the section in a "${input.mode}" style. Reply with the rewritten explanation only - ` +
          `two to four sentences, no preamble.`,
        `Concept: ${input.conceptName}. Section: "${input.sectionTitle}". Original: ${input.originalBody}.${ctx}`,
        400,
      );
      return { mode: input.mode, body: body.trim() };
    } catch {
      return this.fallback.adaptSection(input);
    }
  }

  async narrateInsight(input: NarrateInsightInput): Promise<string> {
    try {
      const text = await this.text(
        'You are MELDA, summarising class performance for a teacher. Use ONLY the numbers given - ' +
          'never invent figures. Two to three sentences, warm and practical.',
        `Class ${input.className}, ${input.studentCount} students. Average mastery ${input.avgMasteryPct}%. ` +
          `Biggest gap: ${input.topConceptName} at ${input.topStrugglePct}% struggling.`,
        300,
      );
      return text.trim();
    } catch {
      return this.fallback.narrateInsight(input);
    }
  }

  async answerQuestion(input: AnswerQuestionInput): Promise<{ answer: string }> {
    try {
      const where = input.sectionTitle
        ? ` They asked from the section "${input.sectionTitle}".`
        : '';
      const answer = await this.text(
        `You are MELDA, a patient tutor helping a student understand the lesson they are reading. ` +
          `Answer their question at their level using ONLY the lesson content provided - if it does not ` +
          `cover the answer, say so and point them to what it does cover. Two to four sentences, warm and ` +
          `plain, no preamble.`,
        `Lesson: "${input.lessonTitle}".${where}\nLesson content:\n${input.context}\n\nStudent question: ${input.question}`,
        400,
      );
      return { answer: answer.trim() };
    } catch {
      return this.fallback.answerQuestion(input);
    }
  }

  // --- transport ---------------------------------------------------------------

  protected async text(system: string, user: string, maxTokens: number): Promise<string> {
    const res = await this.fetchImpl(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    const text = data?.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error('no text in response');
    return text;
  }

  private async json<T>(system: string, user: string, maxTokens: number): Promise<T> {
    const raw = await this.text(system, user, maxTokens);
    // Models sometimes wrap JSON in prose or ```fences```; take the outermost object.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('no JSON object in response');
    return JSON.parse(raw.slice(start, end + 1)) as T;
  }
}
