// The write path. loadDataset handles reads by reassembling the whole Dataset;
// writes go straight to individual tables here. Every server-created id is minted
// on this side (the clients stopped minting ids for anything that reaches the DB),
// and timestamps are stamped now, in ISO, to match the text columns.
//
// The root-cause fix for the "orphan concept" bug lives in resolveConcept: an
// authored lesson or quiz resolves its topic to a REAL concepts row (found or
// created), and every section/question links to that real concept_id. Because
// loadDataset then includes it, aggregate.ts sees it and the dashboard closes the
// loop organically - no synthetic concept that nothing can ever measure.

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  buildSubmission,
  missedTopicNames,
  type CreateAdaptationRequest,
  type CreateAssignmentRequest,
  type CreateLessonRequest,
  type RecordSignalRequest,
  type Selections,
} from 'melda-shared';
import { db } from './client';
import { loadDataset } from './loadDataset';
import * as t from './schema';

const now = (): string => new Date().toISOString();

/**
 * Find-or-create one concept per class+name. Authoring names a single concept
 * from the lesson/quiz topic (matches the old behaviour, now with a backing row).
 * Ceiling: one concept per lesson/quiz, not per-question; the upgrade path is
 * AI-tagged concepts per question.
 */
export async function resolveConcept(classId: string, name: string): Promise<string> {
  const trimmed = name.trim() || 'General';
  const existing = await db
    .select()
    .from(t.concepts)
    .where(and(eq(t.concepts.classId, classId), eq(t.concepts.name, trimmed)))
    .limit(1);
  if (existing.length) return existing[0].id;

  const rows = await db
    .select({ position: t.concepts.position })
    .from(t.concepts)
    .where(eq(t.concepts.classId, classId));
  const position = rows.reduce((m, r) => Math.max(m, r.position), 0) + 1;

  const id = `c-${randomUUID()}`;
  await db.insert(t.concepts).values({
    id,
    classId,
    name: trimmed,
    blurb: `Introduced while authoring "${trimmed}".`,
    position,
  });
  return id;
}

export async function createLesson(classId: string, req: CreateLessonRequest): Promise<string> {
  const conceptId = await resolveConcept(classId, req.topic);
  const id = `lesson-${randomUUID()}`;
  await db.insert(t.lessons).values({
    id,
    classId,
    title: req.title,
    summary: req.summary,
    status: req.publish ? 'published' : 'draft',
    createdAt: now(),
  });
  await db.insert(t.lessonSections).values(
    req.sections.map((s, i) => ({
      id: `sec-${randomUUID()}`,
      lessonId: id,
      conceptId,
      title: s.title,
      kind: s.kind,
      body: s.body,
      position: i,
    })),
  );
  return id;
}

export async function publishLesson(lessonId: string): Promise<void> {
  await db.update(t.lessons).set({ status: 'published' }).where(eq(t.lessons.id, lessonId));
}

export async function createAdaptation(
  lessonId: string,
  req: CreateAdaptationRequest,
): Promise<string> {
  const id = `adapt-${randomUUID()}`;
  await db.insert(t.adaptations).values({
    id,
    lessonId,
    sectionId: req.sectionId,
    conceptId: req.conceptId,
    mode: req.mode,
    body: req.body,
    createdAt: now(),
  });
  return id;
}

export async function createAssignment(
  classId: string,
  req: CreateAssignmentRequest,
): Promise<string> {
  const conceptId = await resolveConcept(classId, req.topic);
  const id = `assign-${randomUUID()}`;
  await db.insert(t.assignments).values({
    id,
    classId,
    lessonId: req.lessonId ?? null,
    title: req.title,
    dueAt: req.dueAt,
  });
  await db.insert(t.questions).values(
    req.questions.map((q, i) => ({
      id: `q-${randomUUID()}`,
      assignmentId: id,
      conceptId,
      prompt: q.prompt,
      // Authored questions are always MCQ (they carry choices + a key).
      kind: 'mcq' as const,
      choices: q.choices,
      correctIndex: q.correctIndex,
      position: i,
    })),
  );
  return id;
}

/**
 * Grade a student's selections server-side and persist submission + answers +
 * signals. Grading uses the UNREDACTED assignment (real correctIndex) loaded
 * here, never anything the client sent, and a re-attempt REPLACES the prior
 * submission (matching upsertSubmission) so mastery never double-counts.
 */
export async function writeSubmission(
  classId: string,
  assignmentId: string,
  studentId: string,
  selections: Selections,
): Promise<{ scorePct: number; topicsToReview: string[] }> {
  const ds = await loadDataset(classId);
  const assignment = ds.assignments.find((a) => a.id === assignmentId);
  if (!assignment) throw new Error(`assignment not found: ${assignmentId}`);

  const submittedAt = now();
  const submissionId = `sub-${randomUUID()}`;
  const { submission, signals } = buildSubmission(
    assignment,
    studentId,
    selections,
    submittedAt,
    submissionId,
  );

  // Replace any prior attempt (delete answers first - they reference the submission).
  const prior = await db
    .select({ id: t.submissions.id })
    .from(t.submissions)
    .where(
      and(eq(t.submissions.assignmentId, assignmentId), eq(t.submissions.studentId, studentId)),
    );
  if (prior.length) {
    const ids = prior.map((p) => p.id);
    await db.delete(t.answers).where(inArray(t.answers.submissionId, ids));
    await db.delete(t.submissions).where(inArray(t.submissions.id, ids));
  }

  await db.insert(t.submissions).values({
    id: submission.id,
    assignmentId,
    studentId,
    submittedAt,
  });
  await db.insert(t.answers).values(
    submission.answers.map((a) => ({
      submissionId: submission.id,
      questionId: a.questionId,
      conceptId: a.conceptId,
      correct: a.correct,
      selectedIndex: a.selectedIndex ?? null,
    })),
  );
  if (signals.length) {
    await db.insert(t.signals).values(
      signals.map((s) => ({
        id: s.id,
        classId,
        studentId,
        type: s.type,
        conceptId: s.conceptId ?? null,
        lessonId: s.lessonId ?? null,
        sectionId: s.sectionId ?? null,
        createdAt: s.createdAt,
        value: s.value ?? null,
        note: s.note ?? null,
      })),
    );
  }

  const total = submission.answers.length;
  const correct = submission.answers.filter((a) => a.correct).length;
  return {
    scorePct: total ? Math.round((correct / total) * 100) : 0,
    topicsToReview: missedTopicNames(ds.concepts, submission),
  };
}

export async function recordSignal(
  classId: string,
  studentId: string,
  req: RecordSignalRequest,
): Promise<string> {
  const id = `sig-${randomUUID()}`;
  await db.insert(t.signals).values({
    id,
    classId,
    studentId,
    type: req.type,
    conceptId: req.conceptId ?? null,
    lessonId: req.lessonId ?? null,
    sectionId: req.sectionId ?? null,
    createdAt: now(),
    value: req.value ?? null,
    note: req.note ?? null,
  });
  return id;
}

// Save a lesson for a student. onConflictDoNothing makes it idempotent against the
// (student, lesson) primary key, so tapping Save twice never errors or duplicates.
export async function saveItem(
  classId: string,
  studentId: string,
  lessonId: string,
): Promise<void> {
  await db
    .insert(t.savedItems)
    .values({ studentId, lessonId, classId, createdAt: now() })
    .onConflictDoNothing();
}

export async function unsaveItem(studentId: string, lessonId: string): Promise<void> {
  await db
    .delete(t.savedItems)
    .where(and(eq(t.savedItems.studentId, studentId), eq(t.savedItems.lessonId, lessonId)));
}
