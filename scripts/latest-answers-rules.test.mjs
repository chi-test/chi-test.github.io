/**
 * Local Firestore emulator checks for latestAnswers read policy.
 * Not part of `npm test` (GitHub Pages CI has no emulator).
 *
 *   firebase emulators:exec --only firestore --project demo-wenyan-rules \
 *     "node scripts/latest-answers-rules.test.mjs"
 */
import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where,
} from 'firebase/firestore';

const TEACHER_EMAIL = 't44@wbss.edu.hk';
const PORT = Number(process.env.FIRESTORE_EMULATOR_PORT || 8080);

function payload(uid, extras = {}) {
  return {
    uid,
    displayName: '學生甲',
    quizId: 'lianpo',
    score: 1,
    total: 65,
    durationMs: 1000,
    finishedAt: serverTimestamp(),
    answers: { '束｜而束君歸趙矣': '綁住' },
    ...extras,
  };
}

const testEnv = await initializeTestEnvironment({
  projectId: 'demo-wenyan-rules',
  firestore: {
    rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8'),
    host: '127.0.0.1',
    port: PORT,
  },
});

const studentA = testEnv.authenticatedContext('student-a', {
  email: 'student-a@example.com',
  email_verified: true,
});
const studentB = testEnv.authenticatedContext('student-b', {
  email: 'student-b@example.com',
  email_verified: true,
});
const teacherUnverified = testEnv.authenticatedContext('teacher-unverified', {
  email: TEACHER_EMAIL,
  email_verified: false,
});
const teacherVerified = testEnv.authenticatedContext('teacher-verified', {
  email: TEACHER_EMAIL,
  email_verified: true,
});
const otherVerified = testEnv.authenticatedContext('other-staff', {
  email: 'noodlenocup@gmail.com',
  email_verified: true,
});
const anon = testEnv.unauthenticatedContext();

const aDoc = (ctx) => doc(ctx.firestore(), 'latestAnswers', 'student-a_lianpo');
const bDoc = (ctx) => doc(ctx.firestore(), 'latestAnswers', 'student-b_lianpo');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  await check('owner can create their latestAnswers doc', async () => {
    await assertSucceeds(setDoc(aDoc(studentA), payload('student-a')));
  });

  await check('other account cannot create a doc under someone else uid/id', async () => {
    await assertFails(setDoc(aDoc(studentB), payload('student-a')));
  });

  await check('anonymous cannot create', async () => {
    await assertFails(setDoc(bDoc(anon), payload('student-b')));
  });

  await check('second student can create their own doc', async () => {
    await assertSucceeds(setDoc(bDoc(studentB), payload('student-b', { displayName: '學生乙' })));
  });

  await check('anonymous cannot read another user script', async () => {
    await assertFails(getDoc(aDoc(anon)));
  });

  await check('unverified teacher cannot read another user script', async () => {
    await assertFails(getDoc(aDoc(teacherUnverified)));
  });

  await check('other verified account cannot read another user script', async () => {
    await assertFails(getDoc(aDoc(otherVerified)));
  });

  await check('other student cannot read another user script', async () => {
    await assertFails(getDoc(aDoc(studentB)));
  });

  await check('owner can read their own script', async () => {
    const snap = await assertSucceeds(getDoc(aDoc(studentA)));
    if (!snap.exists() || snap.data()?.answers?.['束｜而束君歸趙矣'] !== '綁住') {
      throw new Error('owner read did not return the stored answers');
    }
  });

  await check('verified teacher can read another user script', async () => {
    const snap = await assertSucceeds(getDoc(aDoc(teacherVerified)));
    if (!snap.exists() || snap.data()?.uid !== 'student-a') {
      throw new Error('teacher read did not return the student document');
    }
  });

  await check('unfiltered latestAnswers list is denied for a student', async () => {
    await assertFails(getDocs(collection(studentA.firestore(), 'latestAnswers')));
  });

  await check('student list constrained to own uid is allowed', async () => {
    const snap = await assertSucceeds(
      getDocs(query(collection(studentA.firestore(), 'latestAnswers'), where('uid', '==', 'student-a'))),
    );
    if (snap.size !== 1) throw new Error(`expected 1 own doc, got ${snap.size}`);
  });

  await check('verified teacher can list the collection', async () => {
    const snap = await assertSucceeds(getDocs(collection(teacherVerified.firestore(), 'latestAnswers')));
    if (snap.size < 2) throw new Error(`teacher list expected >=2 docs, got ${snap.size}`);
  });

  await check('unverified teacher cannot list the collection', async () => {
    await assertFails(getDocs(collection(teacherUnverified.firestore(), 'latestAnswers')));
  });

  await check('other student cannot update someone else script', async () => {
    await assertFails(setDoc(aDoc(studentB), payload('student-a', { score: 2 })));
  });

  await check('verified teacher cannot update a student script', async () => {
    await assertFails(setDoc(aDoc(teacherVerified), payload('student-a', { score: 2 })));
  });

  await check('owner cannot change uid on update', async () => {
    await assertFails(setDoc(aDoc(studentA), payload('student-b')));
  });

  await check('owner can update their own script', async () => {
    await assertSucceeds(setDoc(aDoc(studentA), payload('student-a', { score: 2, displayName: '學生甲改' })));
  });

  await check('signed-in student can still list attempts for the leaderboard', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'attempts', 'att-a'), {
        uid: 'student-a',
        displayName: '學生甲',
        quizId: 'lianpo',
        score: 1,
        total: 65,
        hitRate: 0,
        durationMs: 1000,
        finishedAt: serverTimestamp(),
      });
    });
    const snap = await assertSucceeds(
      getDocs(query(collection(studentB.firestore(), 'attempts'), where('quizId', '==', 'lianpo'))),
    );
    if (snap.size < 1) throw new Error('leaderboard query returned no attempts');
  });

  await check('anonymous cannot list attempts', async () => {
    await assertFails(getDocs(query(collection(anon.firestore(), 'attempts'), where('quizId', '==', 'lianpo'))));
  });
} finally {
  await testEnv.cleanup();
}

const failed = results.filter((line) => line.startsWith('FAIL'));
for (const line of results) console.log(line);
if (failed.length) {
  console.error(`\n${failed.length} failed / ${results.length} total`);
  process.exit(1);
}
console.log(`\n${results.length} passed`);
