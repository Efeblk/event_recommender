import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GoldenTransport } from '../evals/golden-cache.ts';
import {
  auditGoldenResult,
  canonicalCondition,
  sha256,
  qualitySummary,
  resultDigest,
  validateGoldenFixture,
  type GoldenLabels,
  type GoldenRow,
  type GoldenCase,
} from '../evals/golden-v1.ts';
import { recommend, validateInput } from '../lib/recommend.ts';
import { interpretSpanInput } from '../lib/span-interpreter.ts';
import { rankWithJev } from '../lib/jev.ts';
import {
  embedWithVoyage,
  voyageCacheKey,
  voyageDocumentText,
} from '../lib/voyage.ts';
import {
  emptyFilters,
  type EventRecord,
  type SearchResult,
} from '../lib/types.ts';
import type { Plan } from '../parser/contract.ts';
import { extract } from '../parser/extract.ts';
import { main, documentEstimate, loadVectors } from '../scripts/golden-run.ts';

const now = new Date('2026-10-04T06:50:27.793Z');
const config = { apiKey: 'offline-test-key', model: 'jev-1.13.0' };
const embedding = {
  apiKey: 'offline-test-key',
  model: 'voyage-4-large',
  dimensions: 1024 as const,
};
const hash = 'a'.repeat(64);
void test('oracle comparison preserves group totals while accepting equivalent individual ticket ceilings', () => {
  const ticket = {
    type: 'atom',
    atom: {
      kind: 'budget',
      comparison: 'lte',
      amount: 500,
      currency: 'TRY',
      basis: 'per_ticket',
    },
  } satisfies Plan['hard'];
  assert.equal(
    canonicalCondition(ticket),
    canonicalCondition({
      ...ticket,
      atom: { ...ticket.atom, basis: 'per_person' },
    }),
  );
  assert.notEqual(
    canonicalCondition(ticket),
    canonicalCondition({
      ...ticket,
      atom: { ...ticket.atom, basis: 'group_total' },
    }),
  );
  assert.notEqual(
    canonicalCondition(ticket),
    canonicalCondition({
      ...ticket,
      atom: { ...ticket.atom, comparison: 'lt' },
    }),
  );
});
void test('positive companion context is not an event filter; excluded companions stay visible to the oracle', () => {
  const context: Plan['hard'] = {
    type: 'atom',
    atom: { kind: 'companion', value: 'partner' },
  };
  assert.equal(
    canonicalCondition({ type: 'all', children: [plan.hard, context] }),
    canonicalCondition(plan.hard),
  );
  assert.notEqual(
    canonicalCondition({ type: 'not', child: context }),
    canonicalCondition({ type: 'all', children: [] }),
  );
});
void test('oracle comparison accepts De Morgan equivalents without discarding exclusion or OR scope', () => {
  const a: Plan['hard'] = {
    type: 'atom',
    atom: { kind: 'content', value: 'profanity' },
  };
  const b: Plan['hard'] = {
    type: 'atom',
    atom: { kind: 'content', value: 'sexual_content' },
  };
  const neither: Plan['hard'] = {
    type: 'not',
    child: { type: 'any', children: [a, b] },
  };
  assert.equal(
    canonicalCondition(neither),
    canonicalCondition({
      type: 'all',
      children: [
        { type: 'not', child: a },
        { type: 'not', child: b },
      ],
    }),
  );
  assert.notEqual(
    canonicalCondition(neither),
    canonicalCondition({
      type: 'not',
      child: { type: 'all', children: [a, b] },
    }),
  );
  assert.notEqual(
    canonicalCondition(neither),
    canonicalCondition({ type: 'any', children: [a, b] }),
  );
  assert.equal(
    canonicalCondition({ type: 'all', children: [plan.hard, neither] }),
    canonicalCondition({
      type: 'all',
      children: [
        plan.hard,
        { type: 'not', child: a },
        { type: 'not', child: b },
      ],
    }),
  );
});
void test('lowercase districts survive mixed-case currency and category text', () => {
  for (const message of [
    'bu akşam kadıköyde en fazla 500 TL stand-up',
    'kadikoy theatre under 500 TRY',
  ]) {
    assert.ok(
      extract(message, '2026-10-04').mentions.some(
        (mention) =>
          mention.kind === 'location' &&
          mention.name === 'Kadıköy' &&
          mention.precision === 'district',
      ),
    );
  }
});
void test('this weekend keeps the current Saturday and Sunday when requested on Sunday', () => {
  for (const message of ['this weekend', 'bu hafta sonu']) {
    for (const [reference, from, to] of [
      ['2026-10-03', '2026-10-03', '2026-10-04'],
      ['2026-10-04', '2026-10-03', '2026-10-04'],
      ['2026-10-05', '2026-10-10', '2026-10-11'],
    ]) {
      const date = extract(message, reference).mentions.find(
        (mention) => mention.kind === 'date',
      );
      assert.ok(date?.kind === 'date');
      assert.equal(date.from, from);
      assert.equal(date.to, to);
    }
  }
  const next = extract('next weekend', '2026-10-04').mentions.find(
    (mention) => mention.kind === 'date',
  );
  assert.ok(next?.kind === 'date');
  assert.equal(next.from, '2026-10-10');
  assert.equal(next.to, '2026-10-11');
});
const budget = {
  scope: 'phase-1' as const,
  jevCapUsd: 1,
  voyageCapUsd: null,
  approvedBy: 'synthetic-test-only',
  approvedAt: now.toISOString(),
};
const plan: Plan = {
  hard: {
    type: 'all',
    children: [{ type: 'atom', atom: { kind: 'category', value: 'concert' } }],
  },
  preferences: [],
  order: 'none',
};
const event: EventRecord = {
  id: 'concert-1',
  title: 'Concert',
  description: 'Live concert program',
  startsAt: '2026-10-10T17:00:00.000Z',
  checkedAt: now.toISOString(),
  venue: 'Concert hall',
  district: 'Kadıköy',
  city: 'İstanbul',
  address: '',
  price: 300,
  currency: 'TRY',
  url: 'https://example.test/concert',
  imageUrl: '',
  category: 'Konser',
  availability: 'available',
};
const item: GoldenCase = {
  id: 'en01',
  language: 'en',
  message: 'a concert',
  reviewSummary: 'Concert',
  expected: plan,
};
void test('scored vector loading requires complete coverage; diagnostic loading records missing vectors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-golden-vectors-'));
  try {
    const path = join(directory, 'vectors.json');
    const envelope = {
      schemaVersion: 1,
      profile: voyageCacheKey(embedding),
      dimensions: 1024,
      entries: [] as { hash: string; vector: number[] }[],
    };
    await writeFile(path, JSON.stringify(envelope));
    await assert.rejects(
      loadVectors(path, [event]),
      /Full frozen vector coverage required: 0\/1/,
    );
    const partial = await loadVectors(path, [event], true);
    assert.equal(partial.complete, false);
    assert.equal(partial.byId.size, 0);
    const vector = Array.from({ length: 1024 }, (_, index) =>
      index === 0 ? 1 : 0,
    );
    envelope.entries.push({ hash: sha256(voyageDocumentText(event)), vector });
    await writeFile(path, JSON.stringify(envelope));
    const complete = await loadVectors(path, [event]);
    assert.equal(complete.complete, true);
    assert.deepEqual(complete.byId.get(event.id), vector);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('40 reviewable requests retain language counts, corrections and valid hard plans', async () => {
  const fixture = validateGoldenFixture(
    JSON.parse(
      await readFile(
        new URL('../fixtures/golden-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  assert.equal(fixture.cases.length, 40);
  assert.deepEqual(
    fixture.cases
      .filter((c) => c.previousCaseId)
      .map((c) => [c.id, c.previousCaseId]),
    [
      ['tr25', 'tr24'],
      ['en15', 'en14'],
    ],
  );
  const broken = structuredClone(fixture);
  broken.cases[0].previousCaseId = 'en15';
  assert.throws(() => validateGoldenFixture(broken), /earlier request/);
  const directory = await mkdtemp(join(tmpdir(), 'biplan-golden-review-'));
  try {
    const path = join(directory, 'fixture.json');
    await writeFile(
      path,
      JSON.stringify({
        ...fixture,
        review: { status: 'pending', reviewer: null, reviewedAt: null },
      }),
    );
    await assert.rejects(main(['--fixture', path]), /review all 40/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('a full production parser/retrieval/Jev replay uses three cached transports and zero repeat calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-golden-'));
  try {
    let calls = 0;
    const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    const network: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(typeof init?.body, 'string');
      const body = JSON.parse(init!.body as string);
      const endpoint =
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (endpoint.includes('voyageai'))
        return Response.json({
          data: [{ index: 0, embedding: vector }],
          usage: { total_tokens: 5 },
        });
      const answers = Object.fromEntries(
        Object.entries(
          body.questions as Record<
            string,
            { type: string; criteria?: Record<string, unknown> }
          >,
        ).map(([id, q]) => {
          if (q.type === 'score')
            return [
              id,
              {
                type: 'score',
                score: 3,
                confidence: 1,
                probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 },
              },
            ];
          if (q.type === 'noul')
            return [
              id,
              { type: 'noul', noul: id.startsWith('supported_') ? 1 : 0 },
            ];
          const keys = Object.keys(q.criteria ?? {});
          const choice = id.startsWith('polarity_')
            ? 'wanted'
            : id.startsWith('link_')
              ? 'and'
              : id.startsWith('edit_')
                ? 'unchanged'
                : id === 'action'
                  ? 'continue'
                  : id === 'order'
                    ? 'unchanged'
                    : id.startsWith('hedge_')
                      ? 'none'
                      : keys[0];
          return [
            id,
            {
              type: 'choice',
              choice,
              confidence: 1,
              probabilities: Object.fromEntries(
                keys.map((k) => [k, k === choice ? 1 : 0]),
              ),
            },
          ];
        }),
      );
      return Response.json({
        model: config.model,
        answers,
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    };
    async function run(live: boolean) {
      const transport = new GoldenTransport({
        directory,
        catalogSha256: hash,
        referenceTime: now.toISOString(),
        live,
        budget,
        network,
      });
      const fetcher = transport.fetcher(item.message);
      const result = await recommend(
        validateInput({
          message: item.message,
          intentVersion: 2,
          filters: emptyFilters,
        }),
        {
          now,
          config,
          embeddingConfig: embedding,
          candidates: async () => [event],
          inputInterpreter: 'span-v2',
          vectors: async () => new Map([[event.id, vector]]),
          spanInterpret: (input, options) =>
            interpretSpanInput(input, { ...options, fetcher }),
          rank: (cfg, input, events) =>
            rankWithJev(cfg, input, events, fetcher),
          embed: (cfg, texts, type) =>
            embedWithVoyage(cfg, texts, type, fetcher),
        },
      );
      assert.equal(result.status, 'results');
      assert.equal(result.mode, 'jev');
      assert.deepEqual(transport.errors, []);
      return { result, transport };
    }
    const first = await run(true);
    assert.equal(calls, 3);
    assert.equal(first.transport.paidCalls, 3);
    const second = await run(false);
    assert.equal(calls, 3);
    assert.equal(second.transport.paidCalls, 0);
    assert.equal(second.transport.hits, 3);
    assert.deepEqual(second.result, first.result);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('cache identity includes request text, reference clock, catalog hash and exact provider body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-golden-key-'));
  try {
    const request = {
      method: 'POST',
      body: JSON.stringify({ model: config.model, state: 'concert' }),
      headers: { Authorization: 'Bearer ignored-test-key' },
    };
    const options = {
      directory,
      catalogSha256: hash,
      referenceTime: now.toISOString(),
    };
    const first = new GoldenTransport({
      ...options,
      live: true,
      budget,
      network: async () =>
        Response.json({ usage: { input_tokens: 1 }, answers: {} }),
    });
    await first.fetcher('concert')(
      'https://api.typesafe.ai/v1/systemone',
      request,
    );
    const cached = new GoldenTransport(options);
    await cached.fetcher('concert')('https://api.typesafe.ai/v1/systemone', {
      ...request,
      headers: { Authorization: 'Bearer rotated-key' },
    });
    assert.equal(cached.hits, 1);
    for (const [extra, text, body] of [
      [{}, 'new wording', request.body],
      [{ catalogSha256: 'b'.repeat(64) }, 'concert', request.body],
      [{ referenceTime: '2026-10-05T00:00:00.000Z' }, 'concert', request.body],
      [{}, 'concert', '{"model":"jev-other"}'],
    ] as const) {
      await assert.rejects(
        new GoldenTransport({ ...options, ...extra }).fetcher(text)(
          'https://api.typesafe.ai/v1/systemone',
          { ...request, body },
        ),
        /Offline cache miss/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('failed calls retain reservations and never retry, including a new process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-golden-failed-'));
  try {
    let calls = 0;
    const options = {
      directory,
      catalogSha256: hash,
      referenceTime: now.toISOString(),
      live: true,
      budget,
      network: async () => {
        calls++;
        return new Response('do not log this provider body', { status: 503 });
      },
    };
    const init = { method: 'POST', body: '{}' };
    await assert.rejects(
      new GoldenTransport(options).fetcher('concert')(
        'https://api.typesafe.ai/v1/systemone',
        init,
      ),
      /HTTP 503/,
    );
    await assert.rejects(
      new GoldenTransport(options).fetcher('concert')(
        'https://api.typesafe.ai/v1/systemone',
        init,
      ),
      /no automatic retry/,
    );
    assert.equal(calls, 1);
    const ledger = await readFile(
      join(directory, 'budget-ledger.jsonl'),
      'utf8',
    );
    assert.equal(JSON.parse(ledger.trim()).reservedUsd, 0.02);
    assert.ok(!ledger.includes('provider body'));
    const first = JSON.parse(ledger.trim());
    const retry = {
      key: first.key,
      reason: 'Inspected outage resolved',
      attemptId: 'reviewed-1',
    };
    await new GoldenTransport({
      ...options,
      reviewedRetry: retry,
      network: async () => {
        calls++;
        return Response.json({ usage: { input_tokens: 10 } });
      },
    }).fetcher('concert')('https://api.typesafe.ai/v1/systemone', init);
    const attempts = (
      await readFile(join(directory, 'budget-ledger.jsonl'), 'utf8')
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], first);
    assert.equal(attempts[1].cacheKey, first.key);
    assert.deepEqual(attempts[1].reviewedRetry, retry);
    assert.equal(calls, 2);
    await rm(join(directory, `${first.key}.json`));
    await assert.rejects(
      new GoldenTransport({ ...options, reviewedRetry: retry }).fetcher(
        'concert',
      )('https://api.typesafe.ai/v1/systemone', init),
      /no automatic retry/,
    );
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('budget refusal and offline misses happen before any network attempt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-golden-cap-'));
  try {
    let calls = 0;
    const options = {
      directory,
      catalogSha256: hash,
      referenceTime: now.toISOString(),
      network: async () => {
        calls++;
        throw Error('must not call');
      },
    };
    const init = { method: 'POST', body: '{}' };
    await assert.rejects(
      new GoldenTransport(options).fetcher('x')(
        'https://api.typesafe.ai/v1/systemone',
        init,
      ),
      /Offline cache miss/,
    );
    await assert.rejects(
      new GoldenTransport({ ...options, live: true }).fetcher('x')(
        'https://api.typesafe.ai/v1/systemone',
        init,
      ),
      /approved Phase 1 budget/,
    );
    await assert.rejects(
      new GoldenTransport({
        ...options,
        live: true,
        budget: { ...budget, jevCapUsd: 0.01 },
      }).fetcher('x')('https://api.typesafe.ai/v1/systemone', init),
      /budget reached/,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('card audit uses manually specified hard constraints and catches injected cards and duplicates', () => {
  const wrong = {
    ...event,
    id: 'wrong',
    title: 'Theatre',
    category: 'Tiyatro',
  };
  const result: SearchResult = {
    recommendations: [
      { event },
      { event: wrong },
      { event: { ...event, id: 'duplicate' } },
    ],
    status: 'results',
    filters: emptyFilters,
    mode: 'jev',
    notice: null,
    totalCandidates: 2,
  };
  const audit = auditGoldenResult(item, result, [event, wrong], now);
  assert.equal(audit.hardViolations.length, 1);
  assert.deepEqual(audit.ungrounded, ['duplicate']);
  assert.equal(audit.duplicatePairs.length, 1);
  assert.deepEqual(audit.expectedHardMatchIds, [event.id]);
  assert.equal(audit.parserHardMatches, false);
  assert.notEqual(
    canonicalCondition(plan.hard),
    canonicalCondition({ type: 'not', child: plan.hard }),
  );
});

void test('labels require provenance, every card, reviewed empties and at least ten user-reviewed requests', () => {
  const rows: GoldenRow[] = Array.from({ length: 40 }, (_, i) => ({
    caseId: `case${i}`,
    elapsedMs: 1,
    cacheHits: 0,
    paidCalls: 0,
    errors: [],
    result: {
      recommendations: [{ event }],
      status: 'results',
      filters: emptyFilters,
      mode: 'jev',
      notice: null,
      totalCandidates: 1,
    },
    top10: [
      { rank: 1, recordId: event.id, sourceRecordIds: [event.id], event },
    ],
    audit: {
      parserHardMatches: true,
      hardViolations: [],
      ungrounded: [],
      duplicatePairs: [],
      expectedHardMatchIds: [event.id],
      emptyAudit: null,
    },
  }));
  const provenance = {
    fixtureSha256: hash,
    catalogSha256: hash,
    resultSha256: resultDigest(rows),
  };
  const labels: GoldenLabels = {
    schemaVersion: 1,
    ...provenance,
    runSha256: hash,
    userReview: {
      status: 'reviewed',
      reviewedCaseIds: rows.slice(0, 10).map((r) => r.caseId),
      reviewer: 'test-user',
      reviewedAt: now.toISOString(),
    },
    cases: rows.map((r) => ({
      caseId: r.caseId,
      status: 'labelled',
      cards: [
        {
          recordId: event.id,
          label: 'relevant',
          notes: 'Source supports requested concert',
        },
      ],
      emptyReview: null,
      notes: null,
    })),
  };
  assert.equal(
    qualitySummary(rows, labels, provenance).frozenQualityPassed,
    true,
  );
  labels.userReview.reviewedCaseIds = labels.userReview.reviewedCaseIds.slice(
    0,
    9,
  );
  assert.equal(
    qualitySummary(rows, labels, provenance).frozenQualityPassed,
    false,
  );
  labels.userReview.reviewedCaseIds = rows.slice(0, 10).map((r) => r.caseId);
  labels.cases[0].cards = [];
  assert.equal(
    qualitySummary(rows, labels, provenance).relevantTop3Fraction,
    null,
  );
  assert.equal(
    qualitySummary(rows, labels, {
      ...provenance,
      resultSha256: 'b'.repeat(64),
    }).labelledRequests,
    0,
  );
  const timed = structuredClone(rows);
  timed[0].elapsedMs = 100;
  timed[0].cacheHits = 3;
  assert.equal(resultDigest(timed), resultDigest(rows));
  timed[0].top10[0].event.title = 'Changed source';
  assert.notEqual(resultDigest(timed), resultDigest(rows));
});

void test('embedding estimate deduplicates exact documents and excludes free-tier assumptions', () => {
  const estimate = documentEstimate([
    event,
    { ...event, id: 'other-session', startsAt: '2026-10-12T17:00:00.000Z' },
  ]);
  assert.equal(estimate.uniqueDocuments, 1);
  assert.equal(estimate.freeTierAssumed, false);
  assert.ok(estimate.conservativeTokenEnvelope >= estimate.estimatedTokens);
});
