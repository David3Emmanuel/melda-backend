// Every REST endpoint, mounted on one router. The shape of the API mirrors the
// old store's actions + the 4 AI methods + the screens' reads:
//   - reads reassemble the Dataset via loadDataset and run the SAME pure
//     functions the app used to call in-process (classSummary, conceptDetail,
//     assignmentProgress, ...), so the numbers can't drift from the checks;
//   - writes go through db/mutations (which mint ids and resolve real concepts);
//   - narrateInsight is NOT a public route - it runs inside GET insights, after
//     aggregation, so "the AI only narrates numbers it didn't invent" holds here.
//
// Tenancy is enforced per route: requireAuth -> requireRole -> class membership.
// The student never receives another student's data, and never the answer key
// (redactAssignment strips correctIndex before a paper reaches a student).

import { Router, type Request, type Response } from 'express';
import { and, eq, inArray } from 'drizzle-orm';
import {
  assignmentProgress,
  classSummary,
  conceptDetail,
  conceptInsights,
  missedTopicNames,
  studentDetail,
  studentsByNeed,
  type Assignment,
  type AuthResponse,
  type AuthUser,
  type ClassCard,
  type Dataset,
  type InsightsResponse,
  type Lesson,
  type StudentAssignment,
  type StudentLesson,
  type Subject,
} from 'melda-shared';
import { ai } from '../ai/index';
import { db } from '../db/client';
import { loadDataset } from '../db/loadDataset';
import * as t from '../db/schema';
import {
  createAdaptation,
  createAssignment,
  createLesson,
  publishLesson,
  recordSignal,
  saveItem,
  unsaveItem,
  writeSubmission,
} from '../db/mutations';
import { seed } from '../db/seed';
import {
  hashPassword,
  pathParam,
  requireAuth,
  requireClassAccess,
  requireRole,
  signToken,
  userInClass,
  verifyPassword,
} from './auth';
import {
  adaptSectionSchema,
  askSchema,
  createAdaptationSchema,
  createAssignmentSchema,
  createLessonSchema,
  draftLessonSchema,
  draftQuizSchema,
  loginSchema,
  recordSignalSchema,
  signupSchema,
  submitAssignmentSchema,
} from './schemas';

export const router = Router();

// --- small helpers -----------------------------------------------------------

const initialsFrom = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

/** Strip the answer key before a paper is sent to a student. */
const redactAssignment = (a: Assignment): Assignment => ({
  ...a,
  questions: a.questions.map(({ correctIndex, ...q }) => q),
});

function ownStatus(ds: Dataset, assignment: Assignment, studentId: string): StudentAssignment {
  const sub = ds.submissions.find(
    (s) => s.assignmentId === assignment.id && s.studentId === studentId,
  );
  const scorePct =
    sub && sub.answers.length
      ? Math.round((sub.answers.filter((a) => a.correct).length / sub.answers.length) * 100)
      : sub
        ? 0
        : null;
  return {
    assignment: redactAssignment(assignment),
    submitted: !!sub,
    scorePct,
    // The "topics to review" hint: concepts answered wrong, by name only - the
    // key itself never leaves the server (redactAssignment already stripped it).
    topicsToReview: sub ? missedTopicNames(ds.concepts, sub) : undefined,
  };
}

/** Resolve the class that owns a lesson, or null if the lesson doesn't exist. */
async function lessonClassId(lessonId: string): Promise<string | null> {
  const [row] = await db
    .select({ classId: t.lessons.classId })
    .from(t.lessons)
    .where(eq(t.lessons.id, lessonId));
  return row?.classId ?? null;
}

/**
 * Resolve a lesson the caller is allowed to read, or null. Enforces class
 * membership and hides unpublished lessons from students - the shared guard behind
 * GET /lessons/:id, POST /ai/ask and POST /lessons/:id/save, so all three answer
 * an inaccessible lesson identically (404) and can't be used to probe existence.
 */
async function accessibleLesson(
  user: AuthUser,
  lessonId: string,
): Promise<{ classId: string; lesson: Lesson } | null> {
  const classId = await lessonClassId(lessonId);
  if (!classId || !(await userInClass(user, classId))) return null;
  const ds = await loadDataset(classId);
  const lesson = ds.lessons.find((l) => l.id === lessonId);
  if (!lesson || (user.role === 'student' && lesson.status !== 'published')) return null;
  return { classId, lesson };
}

async function assignmentClassId(assignmentId: string): Promise<string | null> {
  const [row] = await db
    .select({ classId: t.assignments.classId })
    .from(t.assignments)
    .where(eq(t.assignments.id, assignmentId));
  return row?.classId ?? null;
}

// --- auth --------------------------------------------------------------------

router.post('/auth/signup', async (req: Request, res: Response) => {
  const body = signupSchema.parse(req.body);
  const table = body.role === 'teacher' ? t.teachers : t.students;
  const existing = await db.select().from(table).where(eq(table.email, body.email)).limit(1);
  if (existing.length) {
    res.status(409).json({ error: 'email already registered' });
    return;
  }
  const id = `${body.role === 'teacher' ? 't' : 's'}-${Date.now().toString(36)}`;
  const passwordHash = await hashPassword(body.password);
  if (body.role === 'teacher') {
    await db.insert(t.teachers).values({ id, email: body.email, passwordHash, name: body.name });
  } else {
    await db.insert(t.students).values({
      id,
      email: body.email,
      passwordHash,
      name: body.name,
      initials: initialsFrom(body.name),
    });
  }
  const user: AuthUser = { id, role: body.role, name: body.name, email: body.email };
  const out: AuthResponse = { token: signToken(user), user };
  res.status(201).json(out);
});

router.post('/auth/login', async (req: Request, res: Response) => {
  const body = loginSchema.parse(req.body);
  const table = body.role === 'teacher' ? t.teachers : t.students;
  const [row] = await db.select().from(table).where(eq(table.email, body.email)).limit(1);
  // Verify against a found hash, or a dummy compare either way to blunt user
  // enumeration by timing. Same generic error on any failure.
  const okPassword = row
    ? await verifyPassword(body.password, row.passwordHash)
    : await verifyPassword(body.password, '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!row || !okPassword) {
    res.status(401).json({ error: 'invalid email or password' });
    return;
  }
  const user: AuthUser = { id: row.id, role: body.role, name: row.name, email: row.email };
  const out: AuthResponse = { token: signToken(user), user };
  res.json(out);
});

// Everything past here needs a valid token.
router.use(requireAuth);

// --- classes -----------------------------------------------------------------

router.get('/me/classes', async (req: Request, res: Response) => {
  const user = req.user!;
  const memberships =
    user.role === 'teacher'
      ? await db
          .select({ classId: t.classTeachers.classId })
          .from(t.classTeachers)
          .where(eq(t.classTeachers.teacherId, user.id))
      : await db
          .select({ classId: t.classStudents.classId })
          .from(t.classStudents)
          .where(eq(t.classStudents.studentId, user.id));
  const classIds = memberships.map((m) => m.classId);
  if (classIds.length === 0) {
    res.json([] satisfies ClassCard[]);
    return;
  }
  const classRows = await db.select().from(t.classes).where(inArray(t.classes.id, classIds));
  const rosters = await db
    .select()
    .from(t.classStudents)
    .where(inArray(t.classStudents.classId, classIds));
  const cards: ClassCard[] = classRows.map((c) => ({
    id: c.id,
    name: c.name,
    subject: c.subject as Subject,
    studentCount: rosters.filter((r) => r.classId === c.id).length,
  }));
  res.json(cards);
});

// --- teacher UNDERSTAND (reads) ----------------------------------------------

router.get(
  '/classes/:id/insights',
  requireRole('teacher'),
  requireClassAccess(),
  async (req: Request, res: Response) => {
    const ds = await loadDataset(pathParam(req, 'id'));
    const summary = classSummary(ds);
    const concepts = conceptInsights(ds);
    const needs = studentsByNeed(ds);
    const masteries = needs.map((n) => n.overallMasteryPct).filter((m): m is number => m !== null);
    const avgMasteryPct = masteries.length
      ? Math.round(masteries.reduce((s, m) => s + m, 0) / masteries.length)
      : 0;
    const narration = await ai.narrateInsight({
      className: summary.className,
      studentCount: summary.studentCount,
      topConceptName: summary.topStruggle?.name ?? '',
      topStrugglePct: summary.topStruggle?.strugglePct ?? 0,
      avgMasteryPct,
    });
    const out: InsightsResponse = { summary, concepts, studentsByNeed: needs, avgMasteryPct, narration };
    res.json(out);
  },
);

router.get(
  '/classes/:id/concepts/:conceptId',
  requireRole('teacher'),
  requireClassAccess(),
  async (req: Request, res: Response) => {
    const ds = await loadDataset(pathParam(req, 'id'));
    const detail = conceptDetail(ds, pathParam(req, 'conceptId'));
    if (!detail) {
      res.status(404).json({ error: 'concept not found' });
      return;
    }
    res.json(detail);
  },
);

router.get(
  '/classes/:id/students/:studentId',
  requireRole('teacher'),
  requireClassAccess(),
  async (req: Request, res: Response) => {
    const ds = await loadDataset(pathParam(req, 'id'));
    const detail = studentDetail(ds, pathParam(req, 'studentId'));
    if (!detail) {
      res.status(404).json({ error: 'student not found' });
      return;
    }
    res.json(detail);
  },
);

// --- lessons (teacher: all; student: published only) -------------------------

router.get('/classes/:id/lessons', requireClassAccess(), async (req: Request, res: Response) => {
  const ds = await loadDataset(pathParam(req, 'id'));
  const lessons =
    req.user!.role === 'student' ? ds.lessons.filter((l) => l.status === 'published') : ds.lessons;
  res.json(lessons);
});

router.get('/lessons/:id', async (req: Request, res: Response) => {
  const found = await accessibleLesson(req.user!, pathParam(req, 'id'));
  if (!found) {
    res.status(404).json({ error: 'lesson not found' });
    return;
  }
  // The student reader wants the lesson plus its own saved-state in one call
  // (so opening a lesson doesn't fetch the whole saved list); teachers don't
  // need the flag, so only the student response carries it.
  if (req.user!.role === 'student') {
    const [row] = await db
      .select({ lessonId: t.savedItems.lessonId })
      .from(t.savedItems)
      .where(
        and(
          eq(t.savedItems.studentId, req.user!.id),
          eq(t.savedItems.lessonId, pathParam(req, 'id')),
        ),
      )
      .limit(1);
    res.json({ ...found.lesson, saved: !!row } satisfies StudentLesson);
    return;
  }
  res.json(found.lesson);
});

// --- assignments (teacher: live progress; student: own paper + status) -------

router.get(
  '/classes/:id/assignments',
  requireClassAccess(),
  async (req: Request, res: Response) => {
    const ds = await loadDataset(pathParam(req, 'id'));
    if (req.user!.role === 'teacher') {
      res.json(ds.assignments.map((a) => assignmentProgress(ds, a.id)));
      return;
    }
    const out: StudentAssignment[] = ds.assignments.map((a) => ownStatus(ds, a, req.user!.id));
    res.json(out);
  },
);

router.get('/assignments/:id', async (req: Request, res: Response) => {
  const classId = await assignmentClassId(pathParam(req, 'id'));
  if (!classId || !(await userInClass(req.user!, classId))) {
    res.status(404).json({ error: 'assignment not found' });
    return;
  }
  const ds = await loadDataset(classId);
  if (req.user!.role === 'teacher') {
    res.json(assignmentProgress(ds, pathParam(req, 'id')));
    return;
  }
  const assignment = ds.assignments.find((a) => a.id === pathParam(req, 'id'));
  if (!assignment) {
    res.status(404).json({ error: 'assignment not found' });
    return;
  }
  res.json(ownStatus(ds, assignment, req.user!.id));
});

// --- teacher CREATE ----------------------------------------------------------

router.post(
  '/classes/:id/lessons',
  requireRole('teacher'),
  requireClassAccess(),
  async (req: Request, res: Response) => {
    const id = await createLesson(pathParam(req, 'id'), createLessonSchema.parse(req.body));
    res.status(201).json({ id });
  },
);

router.post(
  '/lessons/:id/adaptations',
  requireRole('teacher'),
  async (req: Request, res: Response) => {
    const classId = await lessonClassId(pathParam(req, 'id'));
    if (!classId || !(await userInClass(req.user!, classId))) {
      res.status(404).json({ error: 'lesson not found' });
      return;
    }
    const id = await createAdaptation(pathParam(req, 'id'), createAdaptationSchema.parse(req.body));
    res.status(201).json({ id });
  },
);

router.post('/lessons/:id/publish', requireRole('teacher'), async (req: Request, res: Response) => {
  const classId = await lessonClassId(pathParam(req, 'id'));
  if (!classId || !(await userInClass(req.user!, classId))) {
    res.status(404).json({ error: 'lesson not found' });
    return;
  }
  await publishLesson(pathParam(req, 'id'));
  res.json({ ok: true });
});

router.post(
  '/classes/:id/assignments',
  requireRole('teacher'),
  requireClassAccess(),
  async (req: Request, res: Response) => {
    const id = await createAssignment(pathParam(req, 'id'), createAssignmentSchema.parse(req.body));
    res.status(201).json({ id });
  },
);

// --- student EXPERIENCE (writes) ---------------------------------------------

router.post(
  '/assignments/:id/submissions',
  requireRole('student'),
  async (req: Request, res: Response) => {
    const classId = await assignmentClassId(pathParam(req, 'id'));
    if (!classId || !(await userInClass(req.user!, classId))) {
      res.status(404).json({ error: 'assignment not found' });
      return;
    }
    const { selections } = submitAssignmentSchema.parse(req.body);
    const { scorePct, topicsToReview } = await writeSubmission(
      classId,
      pathParam(req, 'id'),
      req.user!.id,
      selections,
    );
    res.status(201).json({ submitted: true, scorePct, topicsToReview });
  },
);

router.post('/signals', requireRole('student'), async (req: Request, res: Response) => {
  const body = recordSignalSchema.parse(req.body);
  // The demo student belongs to one class; scope the signal to it. Upgrade path:
  // carry the class id on the wire when a student can be in several classes.
  const [membership] = await db
    .select({ classId: t.classStudents.classId })
    .from(t.classStudents)
    .where(eq(t.classStudents.studentId, req.user!.id))
    .limit(1);
  if (!membership) {
    res.status(403).json({ error: 'not enrolled in any class' });
    return;
  }
  const id = await recordSignal(membership.classId, req.user!.id, body);
  res.status(201).json({ id });
});

// --- student SAVED lessons ---------------------------------------------------

router.post('/lessons/:id/save', requireRole('student'), async (req: Request, res: Response) => {
  const lessonId = pathParam(req, 'id');
  const found = await accessibleLesson(req.user!, lessonId);
  if (!found) {
    res.status(404).json({ error: 'lesson not found' });
    return;
  }
  await saveItem(found.classId, req.user!.id, lessonId);
  res.status(201).json({ ok: true });
});

router.delete('/lessons/:id/save', requireRole('student'), async (req: Request, res: Response) => {
  // Unsaving only removes the student's own row, so a lighter guard than save:
  // membership in the owning class, no published check - a student can always
  // clear a save even if the lesson was later unpublished.
  const lessonId = pathParam(req, 'id');
  const classId = await lessonClassId(lessonId);
  if (!classId || !(await userInClass(req.user!, classId))) {
    res.status(404).json({ error: 'lesson not found' });
    return;
  }
  await unsaveItem(req.user!.id, lessonId);
  res.json({ ok: true });
});

router.get('/me/saved', requireRole('student'), async (req: Request, res: Response) => {
  const rows = await db.select().from(t.savedItems).where(eq(t.savedItems.studentId, req.user!.id));
  if (rows.length === 0) {
    res.json([] satisfies Lesson[]);
    return;
  }
  // Reassemble each owning class once, then keep the saved + still-published
  // lessons, newest save first. Filtering on published means an unpublished lesson
  // drops out of Saved without deleting the row.
  const savedAt = new Map(rows.map((r) => [r.lessonId, r.createdAt]));
  const classIds = [...new Set(rows.map((r) => r.classId))];
  const datasets = await Promise.all(classIds.map((c) => loadDataset(c)));
  const lessons = datasets
    .flatMap((ds) => ds.lessons)
    .filter((l) => savedAt.has(l.id) && l.status === 'published')
    .sort((a, b) => (savedAt.get(b.id)! < savedAt.get(a.id)! ? -1 : 1));
  res.json(lessons satisfies Lesson[]);
});

// --- demo reset (dev only) ---------------------------------------------------

router.post(
  '/classes/:id/reset',
  requireRole('teacher'),
  requireClassAccess(),
  async (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'reset is disabled in production' });
      return;
    }
    const result = await seed();
    res.json({ ok: true, classId: result.classId });
  },
);

// --- AI proxy (the key lives here, never in an app) --------------------------
// Teachers draft; students ask about a lesson they're reading. Every route sits
// behind the /ai rate limiter (server.ts) so the paid model surface can't be spun.

router.post('/ai/draft-lesson', requireRole('teacher'), async (req: Request, res: Response) => {
  res.json(await ai.draftLesson(draftLessonSchema.parse(req.body)));
});

router.post('/ai/draft-quiz', requireRole('teacher'), async (req: Request, res: Response) => {
  res.json(await ai.draftQuiz(draftQuizSchema.parse(req.body)));
});

router.post('/ai/adapt-section', requireRole('teacher'), async (req: Request, res: Response) => {
  res.json(await ai.adaptSection(adaptSectionSchema.parse(req.body)));
});

// The student ask: grounded in the lesson they're reading, stateless server-side
// (the app keeps its own on-device transcript). Same lesson guard as GET /lessons/:id.
router.post('/ai/ask', requireRole('student'), async (req: Request, res: Response) => {
  const body = askSchema.parse(req.body);
  const found = await accessibleLesson(req.user!, body.lessonId);
  if (!found) {
    res.status(404).json({ error: 'lesson not found' });
    return;
  }
  const { lesson } = found;
  const section = body.sectionId ? lesson.sections.find((s) => s.id === body.sectionId) : undefined;
  const context = [
    lesson.summary,
    ...(section
      ? [`${section.title}: ${section.body}`]
      : lesson.sections.map((s) => `${s.title}: ${s.body}`)),
  ].join('\n\n');
  const { answer } = await ai.answerQuestion({
    question: body.question,
    lessonTitle: lesson.title,
    sectionTitle: section?.title,
    context,
  });
  res.json({ answer });
});
