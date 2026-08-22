// Endpoint smoke test: spins the real Express app on an ephemeral port over an
// in-memory PGlite, then drives the whole loop across HTTP the way the two apps
// will - a teacher logs in and sees "32% struggled with Ionic Bonding", a student
// logs in and gets a paper with the answer key stripped, submits it, and the
// teacher's numbers move (32% -> 28%). Also pins the two authz guards (no token
// -> 401, wrong role -> 403). Offline: no key -> the mock AI narrates.
// `pnpm check:api` (tsx).

import type { AddressInfo } from 'node:net';

process.env.DATABASE_URL = ''; // force the in-process PGlite branch
process.env.PGLITE_DIR = 'memory://'; // fresh, isolated, nothing persisted
process.env.ANTHROPIC_API_KEY = ''; // force MockAIService - the check stays offline

let passed = 0;
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error('FAIL: ' + msg);
  passed++;
  console.log('  ok -', msg);
}
function eq<T>(actual: T, expected: T, msg: string) {
  ok(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );
}

async function main() {
  const { app, ready } = await import('../server.js');
  const { DEMO, studentEmail } = await import('../db/seed.js');
  const { loadDataset } = await import('../db/loadDataset.js');

  console.log('endpoint smoke');

  // migrate + seed the in-memory demo class, then listen on an ephemeral port
  await ready();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;

  async function api(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }

  try {
    // --- authz: a read requires a token -------------------------------------
    eq((await api('GET', '/me/classes')).status, 401, 'no token is 401');

    // --- teacher logs in and reads the headline -----------------------------
    const login = await api('POST', '/auth/login', {
      body: { email: DEMO.teacher.email, password: DEMO.password, role: 'teacher' },
    });
    eq(login.status, 200, 'teacher login succeeds');
    const teacherToken: string = login.json.token;
    ok(!!teacherToken, 'teacher login returns a token');

    const classes = await api('GET', '/me/classes', { token: teacherToken });
    eq(classes.status, 200, 'teacher lists classes');
    ok(Array.isArray(classes.json) && classes.json.length >= 1, 'teacher has at least one class');
    const classId: string = classes.json[0].id;

    const insights1 = await api('GET', `/classes/${classId}/insights`, { token: teacherToken });
    eq(insights1.status, 200, 'teacher reads insights');
    eq(insights1.json.summary.topStruggle.name, 'Ionic Bonding', 'top struggle is Ionic Bonding');
    ok(
      typeof insights1.json.narration === 'string' && insights1.json.narration.length > 0,
      'insights carry AI narration',
    );
    ok(
      typeof insights1.json.avgMasteryPct === 'number',
      'insights carry the server-computed avg mastery',
    );
    const ionic1 = insights1.json.concepts.find((c: any) => c.name === 'Ionic Bonding');
    ok(!!ionic1, 'Ionic Bonding is in the concept curve');
    eq(ionic1.strugglePct, 32, 'Ionic Bonding starts at 32%');
    eq(ionic1.strugglers, 8, '8 strugglers to start');

    // --- pick a real struggler to move (via the teacher concept-detail read) --
    const ionicId: string = ionic1.conceptId;
    const detail = await api('GET', `/classes/${classId}/concepts/${ionicId}`, {
      token: teacherToken,
    });
    eq(detail.status, 200, 'teacher reads a concept detail');
    eq(detail.json.strugglingStudents.length, 8, 'concept detail lists the 8 strugglers');
    const victimId: string = detail.json.strugglingStudents[0].id;

    // --- student logs in; wrong role can't read the teacher dashboard --------
    const sLogin = await api('POST', '/auth/login', {
      body: { email: studentEmail(victimId), password: DEMO.password, role: 'student' },
    });
    eq(sLogin.status, 200, 'student login succeeds');
    const studentToken: string = sLogin.json.token;
    eq(
      (await api('GET', `/classes/${classId}/insights`, { token: studentToken })).status,
      403,
      'a student is forbidden from teacher insights',
    );

    // --- the student's paper has the answer key stripped --------------------
    const ds = await loadDataset(classId);
    const ionicAssignments = ds.assignments.filter((a) =>
      a.questions.some((q) => q.conceptId === ionicId),
    );
    ok(ionicAssignments.length >= 1, 'at least one assignment covers Ionic Bonding');
    const paper = await api('GET', `/assignments/${ionicAssignments[0].id}`, {
      token: studentToken,
    });
    eq(paper.status, 200, 'student opens their assignment');
    ok(
      paper.json.assignment.questions.every((q: any) => q.correctIndex === undefined),
      'the answer key is stripped from the student paper',
    );
    ok(
      paper.json.assignment.questions.every((q: any) => Array.isArray(q.choices)),
      'the student still gets the choices to answer',
    );

    // --- a wrong paper grades 0 and names its topics, without leaking the key --
    const wrongSel: Record<string, number> = {};
    for (const q of ionicAssignments[0].questions) {
      if (typeof q.correctIndex === 'number') {
        wrongSel[q.id] = (q.correctIndex + 1) % (q.choices?.length ?? 1); // guaranteed wrong
      }
    }
    const wrong = await api('POST', `/assignments/${ionicAssignments[0].id}/submissions`, {
      token: studentToken,
      body: { selections: wrongSel },
    });
    eq(wrong.status, 201, 'an all-wrong paper still submits');
    eq(wrong.json.scorePct, 0, 'all-wrong scores 0');
    ok(
      Array.isArray(wrong.json.topicsToReview) && wrong.json.topicsToReview.length >= 1,
      'wrong answers come back with topics to review',
    );
    ok(
      wrong.json.topicsToReview.every(
        (t: any) =>
          typeof t === 'string' &&
          !ionicAssignments[0].questions.some(
            (q: any) => q.prompt === t || q.choices?.includes(t),
          ),
      ),
      'topics are concept names only - no prompt or choice text leaks',
    );
    const paper2 = await api('GET', `/assignments/${ionicAssignments[0].id}`, {
      token: studentToken,
    });
    eq(paper2.json.submitted, true, 'the stored paper knows it is submitted');
    ok(
      Array.isArray(paper2.json.topicsToReview) && paper2.json.topicsToReview.length >= 1,
      'the stored paper carries its topics to review',
    );

    // --- student submits every assignment all-correct (key read out-of-band) --
    for (const a of ds.assignments) {
      const selections: Record<string, number> = {};
      for (const q of a.questions) {
        if (typeof q.correctIndex === 'number') selections[q.id] = q.correctIndex;
      }
      const sub = await api('POST', `/assignments/${a.id}/submissions`, {
        token: studentToken,
        body: { selections },
      });
      eq(sub.status, 201, `student submits ${a.id}`);
      eq(sub.json.scorePct, 100, `all-correct scores 100 on ${a.id}`);
    }

    // --- the write moved the teacher's view: the loop is closed -------------
    const perfectPaper = await api('GET', `/assignments/${ionicAssignments[0].id}`, {
      token: studentToken,
    });
    ok(
      Array.isArray(perfectPaper.json.topicsToReview) &&
        perfectPaper.json.topicsToReview.length === 0,
      'an all-correct paper has no topics to review',
    );

    const student = await api('GET', `/classes/${classId}/students/${victimId}`, {
      token: teacherToken,
    });
    eq(student.status, 200, 'teacher reads the student detail');
    const ionicMastery = student.json.perConcept.find((p: any) => p.name === 'Ionic Bonding');
    eq(ionicMastery.masteryPct, 100, 'the student now has 100% on Ionic Bonding');
    eq(ionicMastery.struggling, false, 'the student no longer struggles with Ionic Bonding');

    const insights2 = await api('GET', `/classes/${classId}/insights`, { token: teacherToken });
    const ionic2 = insights2.json.concepts.find((c: any) => c.name === 'Ionic Bonding');
    eq(ionic2.strugglers, 7, 'one fewer struggler after the submission');
    eq(ionic2.strugglePct, 28, 'Ionic Bonding dropped 32% -> 28%');

    // --- student: study with MELDA (the ask) --------------------------------
    const publishedLesson = ds.lessons.find((l) => l.status === 'published');
    ok(!!publishedLesson, 'the seed has a published lesson for the student to open');
    const lessonId = publishedLesson!.id;

    const ask = await api('POST', '/ai/ask', {
      token: studentToken,
      body: { lessonId, question: 'Can you explain this more simply?' },
    });
    eq(ask.status, 200, 'student can ask about a published lesson');
    ok(
      typeof ask.json.answer === 'string' && ask.json.answer.length > 0,
      'the ask returns a non-empty answer',
    );
    eq(
      (
        await api('POST', '/ai/ask', {
          token: studentToken,
          body: { lessonId: 'lesson-nope', question: 'hi' },
        })
      ).status,
      404,
      'asking about an unknown lesson is 404',
    );
    eq(
      (await api('POST', '/ai/ask', { token: teacherToken, body: { lessonId, question: 'hi' } }))
        .status,
      403,
      'a teacher cannot use the student ask route',
    );

    // --- student: save materials --------------------------------------------
    const lessonBefore = await api('GET', `/lessons/${lessonId}`, { token: studentToken });
    eq(lessonBefore.json.saved, false, 'the student lesson read reports not saved yet');
    const teacherLesson = await api('GET', `/lessons/${lessonId}`, { token: teacherToken });
    eq(
      'saved' in teacherLesson.json,
      false,
      'the teacher lesson read carries no saved flag',
    );

    eq(
      (await api('POST', `/lessons/${lessonId}/save`, { token: studentToken })).status,
      201,
      'student saves a lesson',
    );
    eq(
      (await api('POST', `/lessons/${lessonId}/save`, { token: studentToken })).status,
      201,
      'saving the same lesson twice is idempotent (still 201, one row)',
    );
    eq(
      (await api('POST', `/lessons/${lessonId}/save`, { token: teacherToken })).status,
      403,
      'a teacher cannot save a lesson',
    );

    const saved1 = await api('GET', '/me/saved', { token: studentToken });
    eq(saved1.status, 200, 'student lists saved lessons');
    ok(
      Array.isArray(saved1.json) && saved1.json.some((l: any) => l.id === lessonId),
      'the saved lesson is listed',
    );
    ok(
      saved1.json.every((l: any) => l.status === 'published'),
      'only published lessons are listed',
    );

    const lessonAfterSave = await api('GET', `/lessons/${lessonId}`, { token: studentToken });
    eq(lessonAfterSave.json.saved, true, 'the lesson read now reports saved');

    eq(
      (await api('DELETE', `/lessons/${lessonId}/save`, { token: studentToken })).status,
      200,
      'student unsaves the lesson',
    );
    const saved2 = await api('GET', '/me/saved', { token: studentToken });
    ok(!saved2.json.some((l: any) => l.id === lessonId), 'the unsaved lesson drops off the list');

    const lessonAfterUnsave = await api('GET', `/lessons/${lessonId}`, { token: studentToken });
    eq(lessonAfterUnsave.json.saved, false, 'the lesson read reports unsaved again');

    console.log(`\nAll ${passed} assertions passed.`);
  } finally {
    server.close();
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
