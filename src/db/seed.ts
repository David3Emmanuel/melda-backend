import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { dataset } from 'melda-shared';
import { db, migrateDb } from './client';
import * as t from './schema';

// Ports the deterministic melda-shared `dataset` into database rows so the demo
// class exists with "32% struggled with Ionic Bonding" already true. The domain
// seed carries no auth, so we synthesise demo credentials here: one teacher, and
// every seeded student gets a login. loadDataset over these rows reproduces the
// seed exactly - that equivalence is what db/loadDataset.check.ts pins.

const HASH_COST = 10;

export const DEMO = {
  password: 'melda',
  teacher: { id: 't-demo', email: 'teacher@melda.africa', name: 'Ms. Ada Okeke' },
};

/** Demo student logins are derived from the seed id, e.g. s1 -> s1@melda.africa. */
export const studentEmail = (studentId: string) => `${studentId}@melda.africa`;

// Delete order: children before the rows they reference.
async function clearAll() {
  await db.delete(t.savedItems);
  await db.delete(t.answers);
  await db.delete(t.signals);
  await db.delete(t.submissions);
  await db.delete(t.questions);
  await db.delete(t.adaptations);
  await db.delete(t.lessonSections);
  await db.delete(t.assignments);
  await db.delete(t.lessons);
  await db.delete(t.concepts);
  await db.delete(t.classStudents);
  await db.delete(t.classTeachers);
  await db.delete(t.classes);
  await db.delete(t.students);
  await db.delete(t.teachers);
}

export async function seed() {
  await migrateDb();
  await clearAll();

  const classId = dataset.classroom.id;
  const studentHash = bcrypt.hashSync(DEMO.password, HASH_COST);
  const teacherHash = bcrypt.hashSync(DEMO.password, HASH_COST);

  // --- identity & tenancy ----------------------------------------------------
  await db.insert(t.teachers).values({
    id: DEMO.teacher.id,
    email: DEMO.teacher.email,
    passwordHash: teacherHash,
    name: DEMO.teacher.name,
  });
  await db.insert(t.students).values(
    dataset.students.map((s) => ({
      id: s.id,
      email: studentEmail(s.id),
      passwordHash: studentHash,
      name: s.name,
      initials: s.initials,
    })),
  );
  await db.insert(t.classes).values({
    id: classId,
    name: dataset.classroom.name,
    subject: dataset.classroom.subject,
    inviteCode: 'DEMO10',
  });
  await db.insert(t.classTeachers).values({ classId, teacherId: DEMO.teacher.id });
  await db
    .insert(t.classStudents)
    .values(dataset.classroom.studentIds.map((studentId) => ({ classId, studentId })));

  // --- concepts --------------------------------------------------------------
  await db.insert(t.concepts).values(
    dataset.concepts.map((c) => ({
      id: c.id,
      classId,
      name: c.name,
      blurb: c.blurb,
      position: c.order,
    })),
  );

  // --- lessons + sections + adaptations --------------------------------------
  if (dataset.lessons.length) {
    await db.insert(t.lessons).values(
      dataset.lessons.map((l) => ({
        id: l.id,
        classId,
        title: l.title,
        topic: l.topic,
        gradeLevel: l.gradeLevel,
        summary: l.summary,
        status: l.status,
        createdAt: l.createdAt,
      })),
    );
    const sectionRows = dataset.lessons.flatMap((l) =>
      l.sections.map((s, i) => ({
        id: s.id,
        lessonId: l.id,
        conceptId: s.conceptId,
        title: s.title,
        kind: s.kind,
        body: s.body,
        position: i,
      })),
    );
    if (sectionRows.length) await db.insert(t.lessonSections).values(sectionRows);

    const adaptationRows = dataset.lessons.flatMap((l) =>
      l.adaptations.map((a) => ({
        id: a.id,
        lessonId: l.id,
        sectionId: a.sectionId,
        conceptId: a.conceptId,
        mode: a.mode,
        body: a.body,
        createdAt: a.createdAt,
      })),
    );
    if (adaptationRows.length) await db.insert(t.adaptations).values(adaptationRows);
  }

  // --- assignments + questions -----------------------------------------------
  if (dataset.assignments.length) {
    await db.insert(t.assignments).values(
      dataset.assignments.map((a) => ({
        id: a.id,
        classId,
        lessonId: a.lessonId ?? null,
        title: a.title,
        dueAt: a.dueAt,
      })),
    );
    const questionRows = dataset.assignments.flatMap((a) =>
      a.questions.map((q, i) => ({
        id: q.id,
        assignmentId: a.id,
        conceptId: q.conceptId,
        prompt: q.prompt,
        kind: q.kind,
        choices: q.choices ?? null,
        correctIndex: q.correctIndex ?? null,
        position: i,
      })),
    );
    if (questionRows.length) await db.insert(t.questions).values(questionRows);
  }

  // --- submissions + answers -------------------------------------------------
  if (dataset.submissions.length) {
    await db.insert(t.submissions).values(
      dataset.submissions.map((s) => ({
        id: s.id,
        assignmentId: s.assignmentId,
        studentId: s.studentId,
        submittedAt: s.submittedAt,
      })),
    );
    const answerRows = dataset.submissions.flatMap((s) =>
      s.answers.map((a) => ({
        submissionId: s.id,
        questionId: a.questionId,
        conceptId: a.conceptId,
        correct: a.correct,
        selectedIndex: a.selectedIndex ?? null,
      })),
    );
    if (answerRows.length) await db.insert(t.answers).values(answerRows);
  }

  // --- signals ---------------------------------------------------------------
  if (dataset.signals.length) {
    await db.insert(t.signals).values(
      dataset.signals.map((s) => ({
        id: s.id,
        classId,
        studentId: s.studentId,
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

  return {
    classId,
    teacher: DEMO.teacher.email,
    sampleStudent: studentEmail(dataset.students[0].id),
  };
}

// Runnable as a script: `pnpm db:seed`.
if (require.main === module) {
  seed()
    .then((r) => {
      console.log('Seeded demo class:', r.classId);
      console.log('Teacher login:', r.teacher, '/', DEMO.password);
      console.log('Student login:', r.sampleStudent, '/', DEMO.password);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
