import { eq, inArray, asc } from 'drizzle-orm';
import type {
  Adaptation,
  Assignment,
  Concept,
  Dataset,
  LearningSignal,
  LearningSignalType,
  Lesson,
  LessonSection,
  LessonStatus,
  Question,
  QuestionKind,
  SectionKind,
  Student,
  Subject,
  Submission,
  AdaptationMode,
} from 'melda-shared';
import { db } from './client';
import * as t from './schema';

// The load-bearing adapter: read every row for a class and reassemble the exact
// in-memory `Dataset` shape the pure functions in melda-shared already expect, so
// `classSummary(await loadDataset(id))` runs the same code the checks pin. Writes
// never round-trip this - they insert into individual tables.

/** Runs a query only when there are ids to match; drizzle's empty-`inArray` is version-fragile. */
async function byIds<T>(fetch: (ids: string[]) => Promise<T[]>, ids: string[]): Promise<T[]> {
  return ids.length ? fetch(ids) : [];
}

function groupBy<T, K extends string>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    (map.get(k) ?? map.set(k, []).get(k)!).push(row);
  }
  return map;
}

export async function loadDataset(classId: string): Promise<Dataset> {
  const [cls] = await db.select().from(t.classes).where(eq(t.classes.id, classId));
  if (!cls) throw new Error(`loadDataset: class not found: ${classId}`);

  // --- students (roster) -----------------------------------------------------
  const memberRows = await db
    .select()
    .from(t.classStudents)
    .where(eq(t.classStudents.classId, classId));
  const memberIds = memberRows.map((r) => r.studentId);
  const studentRows = await byIds(
    (ids) => db.select().from(t.students).where(inArray(t.students.id, ids)),
    memberIds,
  );
  const students: Student[] = studentRows
    .map((s) => ({ id: s.id, name: s.name, initials: s.initials }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // --- concepts (teaching order) ---------------------------------------------
  const conceptRows = await db
    .select()
    .from(t.concepts)
    .where(eq(t.concepts.classId, classId))
    .orderBy(asc(t.concepts.position));
  const concepts: Concept[] = conceptRows.map((c) => ({
    id: c.id,
    name: c.name,
    blurb: c.blurb,
    order: c.position,
  }));

  // --- lessons + sections + adaptations --------------------------------------
  const lessonRows = await db
    .select()
    .from(t.lessons)
    .where(eq(t.lessons.classId, classId))
    .orderBy(asc(t.lessons.createdAt));
  const lessonIds = lessonRows.map((l) => l.id);

  const sectionRows = await byIds(
    (ids) =>
      db
        .select()
        .from(t.lessonSections)
        .where(inArray(t.lessonSections.lessonId, ids))
        .orderBy(asc(t.lessonSections.position)),
    lessonIds,
  );
  const sectionsByLesson = groupBy(sectionRows, (s) => s.lessonId);

  const adaptationRows = await byIds(
    (ids) =>
      db
        .select()
        .from(t.adaptations)
        .where(inArray(t.adaptations.lessonId, ids))
        .orderBy(asc(t.adaptations.createdAt)),
    lessonIds,
  );
  const adaptationsByLesson = groupBy(adaptationRows, (a) => a.lessonId);

  const lessons: Lesson[] = lessonRows.map((l) => {
    const sections: LessonSection[] = (sectionsByLesson.get(l.id) ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      kind: s.kind as SectionKind,
      body: s.body,
      conceptId: s.conceptId,
    }));
    const adaptations: Adaptation[] = (adaptationsByLesson.get(l.id) ?? []).map((a) => ({
      id: a.id,
      sectionId: a.sectionId,
      conceptId: a.conceptId,
      mode: a.mode as AdaptationMode,
      body: a.body,
      createdAt: a.createdAt,
    }));
    // conceptIds is derived from the sections' distinct concepts (first-seen order):
    // every lesson concept is taught by at least one section, so no column is needed.
    const conceptIds = [...new Set(sections.map((s) => s.conceptId))];
    return {
      id: l.id,
      title: l.title,
      topic: l.topic ?? undefined,
      gradeLevel: l.gradeLevel ?? undefined,
      summary: l.summary,
      conceptIds,
      sections,
      status: l.status as LessonStatus,
      createdAt: l.createdAt,
      adaptations,
    };
  });

  // --- assignments + questions -----------------------------------------------
  const assignmentRows = await db
    .select()
    .from(t.assignments)
    .where(eq(t.assignments.classId, classId))
    .orderBy(asc(t.assignments.dueAt), asc(t.assignments.id));
  const assignmentIds = assignmentRows.map((a) => a.id);

  const questionRows = await byIds(
    (ids) =>
      db
        .select()
        .from(t.questions)
        .where(inArray(t.questions.assignmentId, ids))
        .orderBy(asc(t.questions.position)),
    assignmentIds,
  );
  const questionsByAssignment = groupBy(questionRows, (q) => q.assignmentId);
  // question -> position, so a submission's answers can be returned in paper order.
  const questionPosition = new Map(questionRows.map((q) => [q.id, q.position]));

  const assignments: Assignment[] = assignmentRows.map((a) => ({
    id: a.id,
    lessonId: a.lessonId ?? undefined,
    title: a.title,
    dueAt: a.dueAt,
    questions: (questionsByAssignment.get(a.id) ?? []).map((q): Question => ({
      id: q.id,
      conceptId: q.conceptId,
      prompt: q.prompt,
      kind: q.kind as QuestionKind,
      choices: q.choices ?? undefined,
      correctIndex: q.correctIndex ?? undefined,
    })),
  }));

  // --- submissions + answers -------------------------------------------------
  const submissionRows = await byIds(
    (ids) =>
      db
        .select()
        .from(t.submissions)
        .where(inArray(t.submissions.assignmentId, ids))
        .orderBy(asc(t.submissions.submittedAt)),
    assignmentIds,
  );
  const submissionIds = submissionRows.map((s) => s.id);
  const answerRows = await byIds(
    (ids) => db.select().from(t.answers).where(inArray(t.answers.submissionId, ids)),
    submissionIds,
  );
  const answersBySubmission = groupBy(answerRows, (a) => a.submissionId);

  const submissions: Submission[] = submissionRows.map((s) => ({
    id: s.id,
    assignmentId: s.assignmentId,
    studentId: s.studentId,
    submittedAt: s.submittedAt,
    answers: (answersBySubmission.get(s.id) ?? [])
      .map((a) => ({
        questionId: a.questionId,
        conceptId: a.conceptId,
        correct: a.correct,
        selectedIndex: a.selectedIndex ?? undefined,
      }))
      .sort(
        (x, y) =>
          (questionPosition.get(x.questionId) ?? 0) - (questionPosition.get(y.questionId) ?? 0),
      ),
  }));

  // --- signals ---------------------------------------------------------------
  const signalRows = await db
    .select()
    .from(t.signals)
    .where(eq(t.signals.classId, classId))
    .orderBy(asc(t.signals.createdAt));
  const signals: LearningSignal[] = signalRows.map((s) => ({
    id: s.id,
    studentId: s.studentId,
    type: s.type as LearningSignalType,
    conceptId: s.conceptId ?? undefined,
    lessonId: s.lessonId ?? undefined,
    sectionId: s.sectionId ?? undefined,
    createdAt: s.createdAt,
    value: s.value ?? undefined,
    note: s.note ?? undefined,
  }));

  return {
    classroom: {
      id: cls.id,
      name: cls.name,
      subject: cls.subject as Subject,
      studentIds: students.map((s) => s.id),
    },
    students,
    concepts,
    lessons,
    assignments,
    submissions,
    signals,
  };
}
