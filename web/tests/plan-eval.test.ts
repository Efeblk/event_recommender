import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  conditionSignatures,
  scoreCase,
  summarize,
  validateHardFixture,
  type HardCase,
  type HardFixture,
} from '../evals/plan-eval.ts';
import { emptyPlan, type Plan } from '../parser/contract.ts';
import {
  PlanEvalTransport,
  runPlanEval,
  sha256,
  workPath,
} from '../scripts/plan-eval.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

void test('conditionSignatures flattens nested all, normalizes any/not, strips ids, and folds Turkish diacritics', () => {
  const sigs = conditionSignatures({
    type: 'all',
    id: 'root',
    children: [
      {
        type: 'atom',
        id: 'loc1',
        atom: { kind: 'location', name: 'Üsküdar', precision: 'district' },
      },
      {
        type: 'all',
        id: 'nested',
        children: [
          {
            type: 'not',
            id: 'neg1',
            child: {
              type: 'atom',
              id: 'top1',
              atom: { kind: 'topic', value: 'pop' },
            },
          },
          {
            type: 'any',
            id: 'any1',
            children: [
              {
                type: 'atom',
                id: 'cat2',
                atom: { kind: 'category', value: 'theatre' },
              },
              {
                type: 'atom',
                id: 'cat1',
                atom: { kind: 'category', value: 'concert' },
              },
            ],
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    [...sigs],
    [
      '!{"kind":"topic","value":"pop"}',
      'any({"kind":"category","value":"concert"}|{"kind":"category","value":"theatre"})',
      '{"kind":"location","name":"uskudar","precision":"district"}',
    ],
  );

  const istanbulVariation = conditionSignatures({
    type: 'atom',
    atom: { kind: 'location', name: 'İSTANBUL Şişli Çağlayan', precision: 'district' },
  });
  assert.deepEqual(
    [...istanbulVariation],
    ['{"kind":"location","name":"istanbul sisli caglayan","precision":"district"}'],
  );
});

void test('scoreCase handles pass, fail, missing, extra, promotedPreferences, alternatives, and order', () => {
  const expectedPlan: Plan = {
    hard: {
      type: 'all',
      children: [
        {
          type: 'atom',
          atom: { kind: 'location', name: 'Kadıköy', precision: 'district' },
        },
        {
          type: 'not',
          child: {
            type: 'atom',
            atom: { kind: 'topic', value: 'pop' },
          },
        },
      ],
    },
    preferences: [
      {
        type: 'atom',
        atom: { kind: 'mood', value: 'calm' },
      },
      {
        type: 'atom',
        atom: { kind: 'experience', value: 'quiet' },
      },
    ],
    order: 'none',
  };

  const altPlan: Plan = {
    ...expectedPlan,
    hard: {
      type: 'all',
      children: [
        {
          type: 'atom',
          atom: { kind: 'location', name: 'Anadolu', precision: 'side' },
        },
        {
          type: 'not',
          child: {
            type: 'atom',
            atom: { kind: 'topic', value: 'pop' },
          },
        },
      ],
    },
  };

  const fixtureCase: HardCase = {
    id: 'c01',
    language: 'tr',
    kind: 'mood',
    message: 'Kadıköy sakin etkinlik, pop olmasın',
    outcome: 'search',
    expected: expectedPlan,
    alternatives: [altPlan],
  };

  const exactScore = scoreCase(fixtureCase, {
    outcome: 'search',
    plan: {
      hard: {
        type: 'all',
        children: [
          {
            type: 'not',
            child: { type: 'atom', atom: { kind: 'topic', value: 'pop' } },
          },
          {
            type: 'atom',
            atom: { kind: 'location', name: 'kadikoy', precision: 'district' },
          },
        ],
      },
      preferences: [],
      order: 'none',
    },
  });
  assert.equal(exactScore.pass, true);
  assert.equal(exactScore.outcomeCorrect, true);
  assert.deepEqual(exactScore.missing, []);
  assert.deepEqual(exactScore.extra, []);
  assert.deepEqual(exactScore.promotedPreferences, []);
  assert.equal(exactScore.orderCorrect, true);
  assert.deepEqual(exactScore.byKind, {
    location: { tp: 1, fp: 0, fn: 0 },
    '!topic': { tp: 1, fp: 0, fn: 0 },
  });

  const altScore = scoreCase(fixtureCase, {
    outcome: 'search',
    plan: altPlan,
  });
  assert.equal(altScore.pass, true);

  const wrongOrderScore = scoreCase(fixtureCase, {
    outcome: 'search',
    plan: { ...expectedPlan, order: 'cheapest' },
  });
  // Order is reported separately and does not fail the case.
  assert.equal(wrongOrderScore.pass, true);
  assert.equal(wrongOrderScore.orderCorrect, false);

  const promotedAndMissing = scoreCase(fixtureCase, {
    outcome: 'search',
    plan: {
      hard: {
        type: 'all',
        children: [
          {
            type: 'atom',
            atom: { kind: 'location', name: 'Kadıköy', precision: 'district' },
          },
          {
            type: 'atom',
            atom: { kind: 'mood', value: 'calm' },
          },
        ],
      },
      preferences: [],
      order: 'none',
    },
  });
  assert.equal(promotedAndMissing.pass, false);
  assert.deepEqual(promotedAndMissing.missing, [
    '!{"kind":"topic","value":"pop"}',
  ]);
  assert.deepEqual(promotedAndMissing.extra, [
    '{"kind":"mood","value":"calm"}',
  ]);
  assert.deepEqual(promotedAndMissing.promotedPreferences, [
    '{"kind":"mood","value":"calm"}',
  ]);
  assert.deepEqual(promotedAndMissing.byKind, {
    location: { tp: 1, fp: 0, fn: 0 },
    '!topic': { tp: 0, fp: 0, fn: 1 },
    mood: { tp: 0, fp: 1, fn: 0 },
  });
});

void test('scoreCase and summarize handle decline cases, discardedClearRequests, and wrongSearches', () => {
  const searchCase: HardCase = {
    id: 'c02',
    language: 'tr',
    kind: 'combined',
    message: 'Beşiktaş konser',
    outcome: 'search',
    expected: {
      hard: {
        type: 'all',
        children: [
          {
            type: 'atom',
            atom: { kind: 'location', name: 'Beşiktaş', precision: 'district' },
          },
          {
            type: 'atom',
            atom: { kind: 'category', value: 'concert' },
          },
        ],
      },
      preferences: [],
      order: 'none',
    },
  };

  const declineCase: HardCase = {
    id: 'a01',
    language: 'tr',
    kind: 'refuse',
    message: 'Ankara konser',
    outcome: 'decline',
  };

  const s1 = scoreCase(searchCase, {
    outcome: 'decline',
    reason: 'unsupported_constraint',
  });
  assert.equal(s1.pass, false);
  assert.equal(s1.outcomeCorrect, false);
  assert.equal(s1.missing.length, 2);

  const s2 = scoreCase(declineCase, {
    outcome: 'decline',
    reason: 'unsupported_location',
  });
  assert.equal(s2.pass, true);
  assert.equal(s2.outcomeCorrect, true);

  const s3 = scoreCase(declineCase, {
    outcome: 'search',
    plan: {
      hard: {
        type: 'atom',
        atom: { kind: 'category', value: 'concert' },
      },
      preferences: [],
      order: 'none',
    },
  });
  assert.equal(s3.pass, false);
  assert.equal(s3.outcomeCorrect, false);
  assert.deepEqual(s3.byKind, {
    category: { tp: 0, fp: 1, fn: 0 },
  });

  const summary = summarize([s1, s2, s3]);
  assert.equal(summary.cases, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.outcomeAccuracy, 1 / 3);
  assert.equal(summary.discardedClearRequests, 1);
  assert.equal(summary.wrongSearches, 1);
  assert.deepEqual(summary.failedIds, ['c02', 'a01']);
  assert.deepEqual(summary.byKind.category, {
    tp: 0,
    fp: 1,
    fn: 1,
    precision: 0,
    recall: 0,
  });
  assert.deepEqual(summary.byKind.location, {
    tp: 0,
    fp: 0,
    fn: 1,
    precision: 0,
    recall: 0,
  });
});

void test('PlanEvalTransport caches live responses as base64 and replays them offline without network calls', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'biplan-plan-eval-'));
  try {
    const cacheDir = join(dir, 'cache');
    const ledgerPath = join(dir, 'budget-ledger.jsonl');
    const payload = JSON.stringify({
      model: 'jev-1.13.0',
      answers: { q: 1 },
      usage: { input_tokens: 10, output_tokens: 2 },
    });

    let networkCalls = 0;
    const liveTransport = new PlanEvalTransport({
      cacheDir,
      ledgerPath,
      live: true,
      budget: {
        scope: 'phase-1r',
        jevCapUsd: 0.01,
        approvedBy: 'user',
        approvedAt: '2026-10-26T00:00:00.000Z',
      },
      network: async () => {
        networkCalls++;
        return new Response(payload, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    const url = 'https://api.typesafe.ai/v1/systemone';
    const body = '{"model":"jev-1.13.0"}';
    const first = await liveTransport.fetcher(url, { method: 'POST', body });
    assert.equal(first.status, 200);
    assert.equal(await first.text(), payload);
    assert.equal(networkCalls, 1);
    assert.equal(liveTransport.paidCalls, 1);

    const key = sha256(`${body}${url}`);
    const cachedDisk = JSON.parse(
      await readFile(join(cacheDir, `${key}.json`), 'utf8'),
    ) as { status: number; body: string; sha256: string };
    assert.equal(cachedDisk.status, 200);
    assert.equal(
      Buffer.from(cachedDisk.body, 'base64').toString('utf8'),
      payload,
    );
    assert.equal(cachedDisk.sha256, sha256(Buffer.from(payload, 'utf8')));

    const offlineTransport = new PlanEvalTransport({
      cacheDir,
      live: false,
    });
    const replay = await offlineTransport.fetcher(url, {
      method: 'POST',
      body,
    });
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), payload);
    assert.equal(offlineTransport.hits, 1);
    assert.equal(networkCalls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test('offline cache miss records case error "cache miss" and is never counted as a pass even on decline cases', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'biplan-plan-eval-miss-'));
  try {
    const fixture: HardFixture = {
      schemaVersion: 1,
      name: 'hard-v1',
      referenceTime: '2026-10-25T21:10:00.000Z',
      timezone: 'Europe/Istanbul',
      contract: 'phase-1r',
      source: 'gs://test/hard',
      cases: [
        {
          id: 'c01',
          language: 'tr',
          kind: 'refuse',
          message: 'Ankara konser',
          outcome: 'decline',
        },
        {
          id: 'c02',
          language: 'tr',
          kind: 'mood',
          message: 'Kadıköy sakin konser',
          outcome: 'search',
          expected: emptyPlan(),
        },
      ],
    };

    const outputPath = join(dir, 'out.json');
    const output = await runPlanEval({
      fixture: validateHardFixture(fixture),
      fixtureSha256: sha256(JSON.stringify(fixture)),
      cacheDir: join(dir, 'empty-cache'),
      outputPath,
      live: false,
    });

    assert.equal(output.rows.length, 2);
    for (const row of output.rows) {
      assert.equal(row.error, 'cache miss');
      assert.equal(row.actual, null);
      assert.equal(row.score.pass, false);
      assert.equal(row.score.outcomeCorrect, false);
    }
    assert.equal(output.summary.passed, 0);
    assert.deepEqual(output.summary.failedIds, ['c01', 'c02']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

void test('workPath rejects paths outside web/work', () => {
  assert.throws(() => workPath('../outside.json'));
  assert.throws(() => workPath('fixtures/hard-v1.json'));
  assert.ok(workPath('work/plan-eval/cache').endsWith(join('work', 'plan-eval', 'cache')));
});

void test('validateHardFixture accepts web/fixtures/hard-v1.json when present', async (t) => {
  const fixturePath = resolve(root, 'fixtures/hard-v1.json');
  try {
    await access(fixturePath);
  } catch {
    t.skip('web/fixtures/hard-v1.json is not present yet');
    return;
  }
  const raw = await readFile(fixturePath, 'utf8');
  const parsed = validateHardFixture(JSON.parse(raw));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.name, 'hard-v1');
  assert.ok(parsed.cases.length > 0);
});
