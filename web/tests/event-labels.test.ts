import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLabelRequest,
  composeLabels,
  labelHash,
  unknownLabels,
  validLabels,
  type EventLabels,
} from '../lib/event-labels.ts';
import { labelEventBatch, LABEL_TOKENS_PER_CALL } from '../lib/event-label-index.ts';
import { evaluatePlan } from '../lib/plan-evidence.ts';
import type { ControlStore, ControlTransaction, HighLevelStore } from '../lib/storage-contract.ts';
import type { EventRecord } from '../lib/types.ts';
import type { Plan } from '../parser/contract.ts';
import type { JevResponse, Question } from '../parser/parse-core.ts';

function event(id: string, changes: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    title: `Event ${id}`,
    description: 'Etkinlik 7–11 yaş aralığındaki çocuklar için uygundur. Atölyede herkes kendi eserini yapar.',
    startsAt: '2026-11-01T11:00:00.000Z',
    venue: 'Arter',
    city: 'İstanbul',
    district: 'Beyoğlu',
    address: 'Dolapdere Cd. No:27, Beyoğlu/İstanbul',
    price: 300,
    currency: 'TRY',
    url: `https://example.com/${id}`,
    imageUrl: '',
    category: 'Workshop',
    availability: 'available',
    checkedAt: '2026-10-27T00:00:00.000Z',
    ...changes,
  };
}

/** A valid Jev response that picks `picks[id]` (or the first option) for each question. */
function respond(questions: Record<string, Question>, picks: Record<string, string | number> = {}): JevResponse {
  const answers: JevResponse['answers'] = {};
  for (const [id, question] of Object.entries(questions)) {
    if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: typeof picks[id] === 'number' ? (picks[id] as number) : 0.1 };
      continue;
    }
    const keys = Object.keys(question.criteria);
    const chosen = typeof picks[id] === 'string' ? (picks[id] as string) : keys[0];
    assert.ok(keys.includes(chosen), `${id} has option ${chosen}`);
    answers[id] = {
      type: 'choice',
      choice: chosen,
      confidence: 0.9,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === chosen ? 0.9 : 0.1 / (keys.length - 1 || 1)])),
    };
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 3000, output_tokens: 600 } };
}

const plan = (...children: Plan['hard'][]): Plan => ({
  hard: { type: 'all', children },
  preferences: [],
  order: [],
}) as unknown as Plan;
const atom = (value: Record<string, unknown>) => ({ type: 'atom', atom: value }) as unknown as Plan['hard'];

function labels(changes: Partial<EventLabels> = {}): EventLabels {
  return { ...unknownLabels(), audience: 'general', childSuitable: 0.5, place: 'istanbul', ...changes };
}

await test('label requests offer code candidates and compose confident labels', () => {
  const built = buildLabelRequest(event('a'));
  const n7 = built.numbers.findIndex((n) => n.value === 7);
  const n11 = built.numbers.findIndex((n) => n.value === 11);
  assert.ok(n7 >= 0 && n11 >= 0);
  // Only the district named in the listing is offered.
  const districts = Object.keys(built.questions.place.type === 'choice' ? built.questions.place.criteria : {})
    .filter((key) => /^d\d+$/u.test(key));
  assert.equal(districts.length, 1);
  const composed = composeLabels(
    built,
    respond(built.questions, {
      audience: 'children',
      child_suitable: 0.9,
      min_age: `n${n7}`,
      max_age: `n${n11}`,
      audience_evidence: 's0',
      place: districts[0],
      category: 'Workshop',
      hands_on: 0.95,
    }),
  );
  assert.ok(composed && validLabels(composed));
  assert.equal(composed.audience, 'children');
  assert.equal(composed.minAge, 7);
  assert.equal(composed.maxAge, 11);
  assert.equal(composed.district, 'Beyoğlu');
  assert.equal(composed.category, 'Workshop');
  assert.match(composed.evidence.audience ?? '', /7–11 yaş/u);
  assert.match(composed.evidence.age ?? '', /7–11/u);
});

await test('unconfident or invalid answers do not become labels', () => {
  const built = buildLabelRequest(event('a'));
  const response = respond(built.questions, { audience: 'children' });
  response.answers.audience = {
    type: 'choice',
    choice: 'children',
    confidence: 0.5,
    probabilities: { general: 0.4, adult_only: 0, family: 0.1, children: 0.5 },
  };
  assert.equal(composeLabels(built, response)?.audience, 'unknown');
  const broken = respond(built.questions);
  delete broken.answers.seated;
  assert.equal(composeLabels(built, broken), null);
});

await test('label hashes follow the label input', async () => {
  // Session identity and links are not label input.
  assert.equal(await labelHash(event('a')), await labelHash({ ...event('a'), id: 'x', url: 'https://example.com/x', startsAt: '2026-11-02T11:00:00.000Z' }));
  assert.notEqual(await labelHash(event('a')), await labelHash(event('a', { address: 'Kadıköy' })));
});

await test('children companions need a child-suitable labeled event', () => {
  const children = plan(atom({ kind: 'companion', value: 'children' }));
  const status = (l?: EventLabels) => evaluatePlan(event('a', { labels: l }), children).status;
  assert.equal(status(labels({ audience: 'children' })), 'supported');
  assert.equal(status(labels({ minAge: 6 })), 'supported');
  assert.equal(status(labels({ childSuitable: 0.8 })), 'supported');
  assert.equal(status(labels({ audience: 'adult_only' })), 'contradicted');
  assert.equal(status(labels({ minAge: 18 })), 'contradicted');
  assert.equal(status(labels({ childSuitable: 0.1 })), 'contradicted');
  assert.equal(status(labels()), 'unknown');
  const friends = plan(atom({ kind: 'companion', value: 'friends' }));
  assert.equal(evaluatePlan(event('a', { labels: labels({ audience: 'adult_only' }) }), friends).status, 'supported');
});

await test('attendee ages use labeled age rules before text rules', () => {
  const age = (years: number) => plan(atom({ kind: 'age', years }));
  const labeled = event('a', { labels: labels({ minAge: 7, maxAge: 11, evidence: { age: '7–11 yaş' } }) });
  assert.equal(evaluatePlan(labeled, age(9)).status, 'supported');
  assert.equal(evaluatePlan(labeled, age(14)).status, 'contradicted');
  const noRule = event('b', { description: 'Bir konser.', labels: labels({ childSuitable: 0.9 }) });
  assert.equal(evaluatePlan(noRule, age(8)).status, 'supported');
  assert.equal(evaluatePlan(noRule, age(30)).status, 'supported');
  const adults = event('c', { description: 'Bir parti.', labels: labels({ audience: 'adult_only' }) });
  assert.equal(evaluatePlan(adults, age(12)).status, 'contradicted');
});

await test('labels decide place, category and format when the provider is silent', () => {
  const district = plan(atom({ kind: 'location', name: 'Kadıköy', precision: 'district' }));
  const noDistrict = { district: '', address: 'Moda Sahnesi' };
  assert.equal(evaluatePlan(event('a', { ...noDistrict, labels: labels({ district: 'Kadıköy' }) }), district).status, 'supported');
  assert.equal(evaluatePlan(event('a', { ...noDistrict, labels: labels({ district: 'Şişli' }) }), district).status, 'contradicted');
  // An activity outside Istanbul never matches.
  const anything = plan(atom({ kind: 'category', value: 'workshop' }));
  assert.equal(evaluatePlan(event('a', { labels: labels({ place: 'other_city' }) }), anything).status, 'contradicted');
  const other = event('b', { category: 'Diğer', labels: labels({ category: 'Workshop' }) });
  assert.equal(evaluatePlan(other, anything).status, 'supported');
  const outdoors = plan(atom({ kind: 'experience', value: 'outdoors' }));
  assert.equal(evaluatePlan(event('c', { labels: labels({ formats: { handsOn: 0, outdoor: 0.9, seated: 0 } }) }), outdoors).status, 'supported');
  assert.equal(evaluatePlan(event('c', { labels: labels() }), outdoors).status, 'unknown');
});

class MemoryControl implements ControlStore {
  documents = new Map<string, Record<string, unknown>>();
  async get<T>(path: string) {
    return structuredClone(this.documents.get(path) ?? null) as T | null;
  }
  async list<T>() {
    return [] as { id: string; data: T }[];
  }
  async transaction<T>(callback: (tx: ControlTransaction) => Promise<T>) {
    const pending = new Map<string, Record<string, unknown>>();
    const result = await callback({
      get: (path) => this.get(path),
      set: (path, data) => void pending.set(path, structuredClone(data)),
      delete: (path) => void this.documents.delete(path),
    });
    for (const [path, data] of pending) this.documents.set(path, data);
    return result;
  }
}

function labelFixture(events: EventRecord[]) {
  const saved = new Map<string, EventLabels>();
  const store = {
    embeddingCandidates: async () => events,
    eventLabelsByHash: async (hashes: string[]) =>
      new Map(hashes.filter((hash) => saved.has(hash)).map((hash) => [hash, saved.get(hash)!])),
    saveEventLabels: async (entries: { hash: string; labels: EventLabels }[]) => {
      for (const entry of entries) saved.set(entry.hash, entry.labels);
    },
  } as unknown as HighLevelStore;
  const control = new MemoryControl();
  const lease = { key: 'label_index_lock', token: 't', expiresAt: Date.now() + 300_000 };
  const config = { apiKey: 'test-key', model: 'jev-1.13.0' };
  return { saved, store, control, lease, config, ledger: () => control.documents.get('biplan/staging/eventLabels/ledger') as Record<string, number | boolean> };
}

await test('label batches reserve, settle and skip labeled documents', async () => {
  const f = labelFixture([event('a'), event('b', { title: 'Other' })]);
  let calls = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(init.body as string);
    return new Response(JSON.stringify(respond(body.questions, { audience: 'children' })));
  }) as typeof fetch;
  const first = await labelEventBatch(f.config, { tokenCap: 1_000_000, maxCalls: 10 }, f.lease, {
    store: f.store, control: f.control, namespace: 'staging', fetcher,
  });
  assert.equal(first.outcome, 'complete');
  assert.equal(first.saved, 2);
  assert.equal(calls, 2);
  assert.equal(f.ledger().calls, 2);
  assert.equal(f.ledger().inputTokens, 6000);
  assert.equal(f.ledger().chargedTokens, 0);
  const second = await labelEventBatch(f.config, { tokenCap: 1_000_000, maxCalls: 10 }, f.lease, {
    store: f.store, control: f.control, namespace: 'staging', fetcher,
  });
  assert.equal(second.outcome, 'complete');
  assert.equal(calls, 2);
});

await test('the durable token cap stops labeling before a paid call', async () => {
  const f = labelFixture([event('a')]);
  let calls = 0;
  const result = await labelEventBatch(f.config, { tokenCap: LABEL_TOKENS_PER_CALL - 1, maxCalls: 10 }, f.lease, {
    store: f.store, control: f.control, namespace: 'staging',
    fetcher: (async () => { calls++; return new Response('{}'); }) as typeof fetch,
  });
  assert.equal(result.outcome, 'bounded-stop');
  assert.equal(result.reason, 'budget');
  assert.equal(calls, 0);
});

await test('a provider failure halts labeling, keeps the charge and is not retried', async () => {
  const f = labelFixture([event('a')]);
  let calls = 0;
  const failing = (async () => { calls++; return new Response('no', { status: 500 }); }) as typeof fetch;
  const deps = { store: f.store, control: f.control, namespace: 'staging', fetcher: failing };
  const result = await labelEventBatch(f.config, { tokenCap: 1_000_000, maxCalls: 10 }, f.lease, deps);
  assert.equal(result.reason, 'provider');
  assert.equal(f.ledger().halted, true);
  assert.equal(f.ledger().chargedTokens, LABEL_TOKENS_PER_CALL);
  const again = await labelEventBatch(f.config, { tokenCap: 1_000_000, maxCalls: 10 }, f.lease, deps);
  assert.equal(again.reason, 'halted');
  assert.equal(calls, 1);
});

await test('invalid answers are stored as unknown labels and not paid for again', async () => {
  const f = labelFixture([event('a')]);
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: { input_tokens: 10, output_tokens: 1 } }));
  }) as typeof fetch;
  const deps = { store: f.store, control: f.control, namespace: 'staging', fetcher };
  const result = await labelEventBatch(f.config, { tokenCap: 1_000_000, maxCalls: 10 }, f.lease, deps);
  assert.equal(result.invalid, 1);
  assert.equal([...f.saved.values()][0].audience, 'unknown');
  await labelEventBatch(f.config, { tokenCap: 1_000_000, maxCalls: 10 }, f.lease, deps);
  assert.equal(calls, 1);
});
