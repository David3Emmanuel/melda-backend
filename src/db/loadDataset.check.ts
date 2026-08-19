// Proves the DB round-trip: seed the melda-shared dataset into an in-memory
// Postgres (PGlite), read it back through loadDataset, and assert the aggregates
// are byte-identical to computing them over the in-memory seed. If loadDataset
// drops a field or reorders answers in a way that matters, "32%" moves and this
// fails. No framework - assert + tsx.

process.env.DATABASE_URL = ''; // force the PGlite branch
process.env.PGLITE_DIR = 'memory://'; // fresh, isolated, nothing persisted

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
function deepEq<T>(actual: T, expected: T, msg: string) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), msg);
}

async function main() {
  const { dataset, classSummary, conceptInsights } = await import('melda-shared');
  const { seed } = await import('../db/seed.js');
  const { loadDataset } = await import('../db/loadDataset.js');

  console.log('loadDataset adapter');

  const { classId } = await seed();
  const ds = await loadDataset(classId);

  // 1. every entity survived the round-trip in the right count
  eq(ds.students.length, dataset.students.length, 'students count round-trips');
  eq(ds.concepts.length, dataset.concepts.length, 'concepts count round-trips');
  eq(ds.lessons.length, dataset.lessons.length, 'lessons count round-trips');
  eq(ds.assignments.length, dataset.assignments.length, 'assignments count round-trips');
  eq(ds.submissions.length, dataset.submissions.length, 'submissions count round-trips');
  eq(ds.signals.length, dataset.signals.length, 'signals count round-trips');

  // 2. the headline the whole product is built on
  const sum = classSummary(ds);
  eq(sum.topStruggle?.name, 'Ionic Bonding', 'top struggle is Ionic Bonding');
  eq(sum.topStruggle?.strugglePct, 32, 'top struggle is 32%');
  eq(sum.topStruggle?.strugglers, 8, '8 strugglers');
  eq(sum.topStruggle?.attempted, 25, '25 attempted');

  // 3. the full descending curve is identical computed from DB vs from the seed
  deepEq(
    conceptInsights(ds),
    conceptInsights(dataset),
    'concept insight curve round-trips exactly',
  );

  // 4. the signal taxonomy survived (denormalised answer.conceptId included)
  const byType = new Map(sum.signalCounts.map((s) => [s.type, s.count]));
  eq(byType.get('QUESTION_STRUGGLE'), 25, 'QUESTION_STRUGGLE count round-trips');
  eq(byType.get('ASSIGNMENT_PERFORMANCE'), 150, 'ASSIGNMENT_PERFORMANCE count round-trips');
  ok(
    ds.submissions.every((s) => s.answers.every((a) => a.conceptId.length > 0)),
    'every answer carries its denormalised conceptId',
  );

  // 5. a lesson reassembled its sections and derived conceptIds
  const seedLesson = dataset.lessons[0];
  const loadedLesson = ds.lessons.find((l) => l.id === seedLesson.id)!;
  ok(!!loadedLesson, 'first seed lesson round-trips');
  eq(loadedLesson.sections.length, seedLesson.sections.length, 'lesson sections round-trip');
  deepEq(loadedLesson.conceptIds, seedLesson.conceptIds, 'lesson conceptIds derived correctly');

  console.log(`\nAll ${passed} assertions passed.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
