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
  studentDetail,
  studentsByNeed,
  type Assignment,
  type AuthResponse,
  type AuthUser,
  type ClassCard,
  type Dataset,
  type InsightsResponse,
  type StudentAssignment,
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
  return { assignment: redactAssignment(assignment), submitted: !!sub, scorePct };
}

/** Resolve the class that owns a lesson, or null if the lesson doesn't exist. */
async function lessonClassId(lessonId: string): Promise<string | null> {
  const [row] = await db
    .select({ classId: t.lessons.classId })
    .from(t.lessons)
    .where(eq(t.lessons.id, lessonId));
  return row?.classId ?? null;
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
    const out: InsightsResponse = { summary, concepts, studentsByNeed: needs, narration };
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
  const classId = await lessonClassId(pathParam(req, 'id'));
  if (!classId || !(await userInClass(req.user!, classId))) {
    res.status(404).json({ error: 'lesson not found' });
    return;
  }
  const ds = await loadDataset(classId);
  const lesson = ds.lessons.find((l) => l.id === pathParam(req, 'id'));
  if (!lesson || (req.user!.role === 'student' && lesson.status !== 'published')) {
    res.status(404).json({ error: 'lesson not found' });
    return;
  }
  res.json(lesson);
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
    const { scorePct } = await writeSubmission(
      classId,
      pathParam(req, 'id'),
      req.user!.id,
      selections,
    );
    res.status(201).json({ submitted: true, scorePct });
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

// --- AI proxy (teacher-only drafting; the key lives here, never in an app) ----

router.post('/ai/draft-lesson', requireRole('teacher'), async (req: Request, res: Response) => {
  res.json(await ai.draftLesson(draftLessonSchema.parse(req.body)));
});

router.post('/ai/draft-quiz', requireRole('teacher'), async (req: Request, res: Response) => {
  res.json(await ai.draftQuiz(draftQuizSchema.parse(req.body)));
});

router.post('/ai/adapt-section', requireRole('teacher'), async (req: Request, res: Response) => {
  res.json(await ai.adaptSection(adaptSectionSchema.parse(req.body)));
});
