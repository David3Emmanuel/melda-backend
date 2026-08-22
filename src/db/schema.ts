// Drizzle schema. Two layers:
//
//   1. Identity & tenancy - teachers, students, classes, and the two M:N joins
//      (a class has many teachers and many students; there is no direct
//      student<->teacher link). This is what auth is built on.
//   2. The domain tables - one row-per-entity mirror of the in-memory `Dataset`
//      shape from melda-shared/models, every table scoped by `class_id`.
//      `loadDataset(classId)` reassembles these rows into that exact shape so the
//      pure aggregation/grading logic runs server-side unchanged.
//
// Timestamps are stored as ISO text (the domain uses string `createdAt`/`dueAt`),
// so no Date<->string marshalling leaks into loadDataset. Ordered arrays
// (sections, questions, concepts) carry an explicit `position`. Text timestamps
// mean no SQL date-range queries; move to timestamptz if a reporting query ever
// needs them.

import { pgTable, text, integer, boolean, real, jsonb, primaryKey } from 'drizzle-orm/pg-core';

// --- identity & tenancy ------------------------------------------------------

export const teachers = pgTable('teachers', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
});

export const students = pgTable('students', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  name: text('name').notNull(),
  initials: text('initials').notNull(),
});

export const classes = pgTable('classes', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  subject: text('subject').notNull(),
  // Students join by this code (POST /classes/join). Nullable only for rows
  // created before this column existed; every class the app creates sets one.
  inviteCode: text('invite_code').unique(),
});

export const classTeachers = pgTable(
  'class_teachers',
  {
    classId: text('class_id')
      .notNull()
      .references(() => classes.id),
    teacherId: text('teacher_id')
      .notNull()
      .references(() => teachers.id),
  },
  (t) => [primaryKey({ columns: [t.classId, t.teacherId] })],
);

export const classStudents = pgTable(
  'class_students',
  {
    classId: text('class_id')
      .notNull()
      .references(() => classes.id),
    studentId: text('student_id')
      .notNull()
      .references(() => students.id),
  },
  (t) => [primaryKey({ columns: [t.classId, t.studentId] })],
);

// --- domain (per class) ------------------------------------------------------

export const concepts = pgTable('concepts', {
  id: text('id').primaryKey(),
  classId: text('class_id')
    .notNull()
    .references(() => classes.id),
  name: text('name').notNull(),
  blurb: text('blurb').notNull(),
  position: integer('position').notNull(),
});

export const lessons = pgTable('lessons', {
  id: text('id').primaryKey(),
  classId: text('class_id')
    .notNull()
    .references(() => classes.id),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
});

export const lessonSections = pgTable('lesson_sections', {
  id: text('id').primaryKey(),
  lessonId: text('lesson_id')
    .notNull()
    .references(() => lessons.id),
  conceptId: text('concept_id')
    .notNull()
    .references(() => concepts.id),
  title: text('title').notNull(),
  kind: text('kind').notNull(),
  body: text('body').notNull(),
  position: integer('position').notNull(),
});

export const adaptations = pgTable('adaptations', {
  id: text('id').primaryKey(),
  lessonId: text('lesson_id')
    .notNull()
    .references(() => lessons.id),
  sectionId: text('section_id')
    .notNull()
    .references(() => lessonSections.id),
  conceptId: text('concept_id')
    .notNull()
    .references(() => concepts.id),
  mode: text('mode').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull(),
});

export const assignments = pgTable('assignments', {
  id: text('id').primaryKey(),
  classId: text('class_id')
    .notNull()
    .references(() => classes.id),
  lessonId: text('lesson_id').references(() => lessons.id),
  title: text('title').notNull(),
  dueAt: text('due_at').notNull(),
});

export const questions = pgTable('questions', {
  id: text('id').primaryKey(),
  assignmentId: text('assignment_id')
    .notNull()
    .references(() => assignments.id),
  conceptId: text('concept_id')
    .notNull()
    .references(() => concepts.id),
  prompt: text('prompt').notNull(),
  kind: text('kind').notNull(),
  choices: jsonb('choices').$type<string[]>(),
  correctIndex: integer('correct_index'),
  position: integer('position').notNull(),
});

export const submissions = pgTable('submissions', {
  id: text('id').primaryKey(),
  assignmentId: text('assignment_id')
    .notNull()
    .references(() => assignments.id),
  studentId: text('student_id')
    .notNull()
    .references(() => students.id),
  submittedAt: text('submitted_at').notNull(),
});

// Answers have no id in the domain - a submission owns its answers, keyed by
// question. concept_id is denormalised here on purpose (matches models.ts) so
// aggregation never re-joins.
export const answers = pgTable(
  'answers',
  {
    submissionId: text('submission_id')
      .notNull()
      .references(() => submissions.id),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id),
    conceptId: text('concept_id')
      .notNull()
      .references(() => concepts.id),
    correct: boolean('correct').notNull(),
    selectedIndex: integer('selected_index'),
  },
  (t) => [primaryKey({ columns: [t.submissionId, t.questionId] })],
);

// Signals carry class_id directly: unlike submissions they are not always tied
// to an assignment, so this is the only way to scope them to a class.
export const signals = pgTable('signals', {
  id: text('id').primaryKey(),
  classId: text('class_id')
    .notNull()
    .references(() => classes.id),
  studentId: text('student_id')
    .notNull()
    .references(() => students.id),
  type: text('type').notNull(),
  conceptId: text('concept_id'),
  lessonId: text('lesson_id'),
  sectionId: text('section_id'),
  createdAt: text('created_at').notNull(),
  value: real('value'),
  note: text('note'),
});

// A student's saved lessons. Composite PK (student, lesson) makes save idempotent
// - re-saving the same lesson is a no-op, not a duplicate row. class_id is carried
// so /me/saved can reload the owning class(es) without re-joining through lessons.
export const savedItems = pgTable(
  'saved_items',
  {
    studentId: text('student_id')
      .notNull()
      .references(() => students.id),
    lessonId: text('lesson_id')
      .notNull()
      .references(() => lessons.id),
    classId: text('class_id')
      .notNull()
      .references(() => classes.id),
    createdAt: text('created_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.studentId, t.lessonId] })],
);
