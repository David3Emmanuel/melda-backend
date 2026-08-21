// Request validation at every write boundary. These schemas are the runtime
// guard; the compile-time shapes are the DTOs in melda-shared/contract, and the
// two are kept deliberately in lockstep (a schema per Create*/Submit*/Record*
// request). A failed parse throws a ZodError, which Express 5 forwards to the
// error handler in server.ts and becomes a 400 - routes never see bad input.

import { z } from 'zod';

const role = z.enum(['teacher', 'student']);
const sectionKind = z.enum(['explanation', 'example', 'activity', 'check']);
const adaptationMode = z.enum([
  'simpler',
  'detailed',
  'example',
  'visual',
  'practice',
  'reexplain',
]);
const signalType = z.enum([
  'QUESTION_STRUGGLE',
  'CONCEPT_REVISIT',
  'REQUEST_SIMPLER',
  'REQUEST_ALTERNATIVE_EXPLANATION',
  'ACTIVITY_PERFORMANCE',
  'ASSIGNMENT_PERFORMANCE',
  'INCORRECT_PATTERN',
  'TIME_ON_SECTION',
  'RESOURCE_ENGAGEMENT',
  'SUBMISSION_TIMESTAMP',
]);

// --- auth --------------------------------------------------------------------

export const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  role,
});

export const signupSchema = z.object({
  email: z.email(),
  password: z.string().min(6),
  name: z.string().min(1),
  role,
});

// --- teacher CREATE ----------------------------------------------------------

export const createLessonSchema = z.object({
  topic: z.string().min(1),
  title: z.string().min(1),
  summary: z.string(),
  sections: z
    .array(z.object({ title: z.string().min(1), kind: sectionKind, body: z.string() }))
    .min(1),
  publish: z.boolean().optional(),
});

export const createAssignmentSchema = z.object({
  topic: z.string().min(1),
  title: z.string().min(1),
  lessonId: z.string().optional(),
  dueAt: z.string().min(1),
  questions: z
    .array(
      z.object({
        prompt: z.string().min(1),
        choices: z.array(z.string()).min(2),
        correctIndex: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

export const createAdaptationSchema = z.object({
  sectionId: z.string().min(1),
  conceptId: z.string().min(1),
  mode: adaptationMode,
  body: z.string().min(1),
});

// --- student EXPERIENCE ------------------------------------------------------

export const submitAssignmentSchema = z.object({
  selections: z.record(z.string(), z.number().int()),
});

export const recordSignalSchema = z.object({
  type: signalType,
  conceptId: z.string().optional(),
  lessonId: z.string().optional(),
  sectionId: z.string().optional(),
  value: z.number().optional(),
  note: z.string().optional(),
});

// --- AI proxy ----------------------------------------------------------------

export const draftLessonSchema = z.object({
  topic: z.string().min(1),
  gradeLevel: z.string().optional(),
  notes: z.string().optional(),
});

export const draftQuizSchema = z.object({
  topic: z.string().min(1),
  gradeLevel: z.string().optional(),
  count: z.number().int().min(1).max(10).optional(),
});

export const adaptSectionSchema = z.object({
  conceptName: z.string().min(1),
  sectionTitle: z.string().min(1),
  originalBody: z.string(),
  mode: adaptationMode,
  strugglePct: z.number().optional(),
});

// A student asking about a lesson they're reading. sectionId narrows the framing;
// the question is length-capped so the proxied prompt can't be used as free tokens.
export const askSchema = z.object({
  lessonId: z.string().min(1),
  sectionId: z.string().optional(),
  question: z.string().min(1).max(1000),
});
