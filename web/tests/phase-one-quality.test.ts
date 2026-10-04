import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRequest,
  compose,
  type JevResponse,
} from '../parser/parse-core.ts';
import type { ParserInput, Plan } from '../parser/contract.ts';
import { canonicalCondition } from '../evals/golden-v1.ts';
import { validateSearchPlan } from '../lib/plan-evidence.ts';
import { recommend, validateInput } from '../lib/recommend.ts';
import { shortlistEvents } from '../lib/retrieval.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';

void test('a child-show request admits age-supported theatre before ranking and rejects unknown or excluded formats', async () => {
  const now = new Date('2026-10-04T06:50:27.793Z');
  const event: EventRecord = {
    id: 'age-supported-play',
    title: 'Süper Patates ve Kaçak Bezelye - Süper Köpüklü Bir Macera',
    description: 'Etkinlik 2 yaş ve üzeri için uygundur.',
    startsAt: '2026-10-10T10:00:00.000Z',
    checkedAt: now.toISOString(),
    venue: 'Akasya Kültür Sanat',
    city: 'İstanbul',
    district: 'Üsküdar',
    address: '',
    price: 300,
    currency: 'TRY',
    url: 'https://example.test/child-play',
    imageUrl: '',
    category: 'Tiyatro',
    availability: 'available',
  };
  const records: EventRecord[] = [
    event,
    {
      ...event,
      id: 'unknown-age',
      title: 'Çocuk Oyunu',
      description: 'Çocuklar için tiyatro.',
    },
    {
      ...event,
      id: 'older-audience',
      title: 'Sekiz Yaş ve Üzeri',
      description: 'Yaş sınırı: 8+',
    },
    { ...event, id: 'concert', title: 'Konser', category: 'Konser' },
  ];
  const plan: Plan = {
    hard: {
      type: 'all',
      children: [
        { type: 'atom', atom: { kind: 'category', value: 'show' } },
        { type: 'atom', atom: { kind: 'age', years: 6 } },
      ],
    },
    preferences: [],
    order: 'none',
  };
  for (const message of [
    '6 yaşındaki çocuğum için uygun bir gösteri',
    'A show suitable for my 6-year-old child',
  ]) {
    const result = await recommend(
      validateInput({ message, intentVersion: 2, filters: emptyFilters }),
      {
        now,
        config: { apiKey: 'offline-test-key', model: 'jev-1.13.0' },
        inputInterpreter: 'span-v2',
        candidates: async () => records,
        spanInterpret: async () => ({
          status: 'accepted',
          operations: [],
          resultingPlan: plan,
          debug: { mentions: [], answers: {} },
        }),
        rank: async (_config, _input, candidates) => {
          assert.deepEqual(
            candidates.map((candidate) => candidate.id),
            [event.id],
          );
          return {
            model: 'synthetic-offline-test',
            usage: { inputTokens: 0, outputTokens: 0 },
            ranked: candidates.map((candidate) => ({
              event: candidate,
              score: 3,
              confidence: 1,
              probabilities: [0, 0, 0, 1] as const,
              supportProbability: 1,
            })),
          };
        },
      },
    );
    assert.equal(result.status, 'results');
    assert.deepEqual(
      result.recommendations.map((card) => card.event.id),
      [event.id],
    );
  }
});

function parse(
  message: string,
  choices: Record<string, string> = {},
  judgments: Record<string, number> = {},
  previousState: ParserInput['previousState'] = null,
) {
  const input: ParserInput = {
    utterance: message,
    language: 'tr',
    referenceDate: '2026-10-04',
    timezone: 'Europe/Istanbul',
    previousState,
  };
  const built = buildRequest(input);
  const answers: JevResponse['answers'] = {};
  for (const [id, question] of Object.entries(built.questions)) {
    if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: judgments[id] ?? 0 };
      continue;
    }
    const options = Object.keys(question.criteria);
    const selected =
      choices[id] ??
      (id.startsWith('polarity_')
        ? 'wanted'
        : id.startsWith('link_')
          ? 'and'
          : id.startsWith('hedge_')
            ? 'none'
            : id.startsWith('edit_')
              ? 'unchanged'
              : id === 'action'
                ? 'continue'
                : id === 'order'
                  ? 'unchanged'
                  : options[0]);
    assert.ok(options.includes(selected));
    answers[id] = {
      type: 'choice',
      choice: selected,
      confidence: 1,
      probabilities: Object.fromEntries(
        options.map((option) => [option, option === selected ? 1 : 0]),
      ),
    };
  }
  const result = compose(input, built, {
    model: 'synthetic-offline-test',
    answers,
    usage: { input_tokens: 0, output_tokens: 0 },
  });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') throw Error('Expected accepted plan');
  return result.resultingPlan;
}

void test('district correction consumes the rejected old district and retains date, category and budget semantics', () => {
  const previous: Plan = {
    hard: {
      type: 'all',
      children: [
        {
          type: 'atom',
          id: 'h0',
          atom: { kind: 'date', from: '2026-10-05', to: '2026-10-05' },
        },
        {
          type: 'atom',
          id: 'h1',
          atom: { kind: 'location', name: 'Beşiktaş', precision: 'district' },
        },
        {
          type: 'atom',
          id: 'h2',
          atom: { kind: 'category', value: 'concert' },
        },
        {
          type: 'atom',
          id: 'h3',
          atom: {
            kind: 'budget',
            amount: 700,
            comparison: 'lte',
            basis: 'per_ticket',
            currency: 'TRY',
          },
        },
      ],
    },
    preferences: [],
    order: 'none',
  };
  const changed = parse(
    'Beşiktaş değil Kadıköy olsun, bütçeyi de 1000 TL yap',
    {
      polarity_m0: 'unwanted',
      edit_h1: 'replace',
      edit_h3: 'replace',
      cmp_m2: 'unchanged',
      basis_m2: 'unstated',
    },
    {},
    { revision: 1, plan: previous, evidence: [] },
  );
  const expected = structuredClone(previous);
  if (expected.hard.type !== 'all') throw Error('Expected conjunction');
  expected.hard.children[1] = {
    type: 'atom',
    atom: { kind: 'location', name: 'Kadıköy', precision: 'district' },
  };
  expected.hard.children[3] = {
    type: 'atom',
    atom: {
      kind: 'budget',
      amount: 1000,
      comparison: 'lte',
      basis: 'per_ticket',
      currency: 'TRY',
    },
  };
  assert.equal(
    canonicalCondition(changed.hard),
    canonicalCondition(expected.hard),
  );
});

void test('accepted category alternatives stay positive beside a separate excluded category', () => {
  for (const message of [
    'tiyatro veya stand-up, konser olmasın',
    'Theatre or stand-up, but no concerts',
  ]) {
    const plan = parse(message, { polarity_m2: 'unwanted', link_m0_m1: 'or' });
    const expected: Plan['hard'] = {
      type: 'all',
      children: [
        {
          type: 'any',
          children: [
            { type: 'atom', atom: { kind: 'category', value: 'theatre' } },
            { type: 'atom', atom: { kind: 'category', value: 'standup' } },
          ],
        },
        {
          type: 'not',
          child: { type: 'atom', atom: { kind: 'category', value: 'concert' } },
        },
      ],
    };
    assert.equal(canonicalCondition(plan.hard), canonicalCondition(expected));
  }
});

void test('attendee dancing is a retrieval preference; watching ballet retains its format constraint', () => {
  const activity = parse(
    'arkadaşlarla dans etmek istiyoruz',
    {},
    { attendee_activity_m1: 1 },
  );
  assert.equal(canonicalCondition(activity.hard), 'all()');
  assert.ok(
    activity.preferences.some(
      (condition) =>
        condition.type === 'atom' &&
        condition.atom.kind === 'topic' &&
        condition.atom.value === 'dancing',
    ),
  );
  const watching = parse('bale izlemek istiyorum');
  assert.equal(
    canonicalCondition(watching.hard),
    canonicalCondition({
      type: 'atom',
      atom: { kind: 'category', value: 'dance' },
    }),
  );
});

void test('ordinary beginner wishes remain usable; explicit source guarantees still fail closed', () => {
  const ordinary = parse('A pottery workshop for beginners');
  validateSearchPlan(ordinary);
  assert.ok(
    ordinary.preferences.some(
      (condition) =>
        condition.type === 'atom' &&
        condition.atom.kind === 'experience' &&
        condition.atom.value === 'beginner_friendly',
    ),
  );
  const mandatory = parse(
    'A pottery workshop must explicitly confirm that no prior experience is required for beginners',
    {},
    { mandatory_beginner_m2: 1 },
  );
  assert.throws(
    () => validateSearchPlan(mandatory),
    /experience evidence is unsupported/,
  );
});

void test('span-v2 reserves sourced calm programs after hard admission and before the 16-candidate judge', async () => {
  const now = new Date('2026-10-04T06:50:27.793Z');
  const make = (
    id: string,
    description: string,
    startsAt = '2026-10-10T17:00:00.000Z',
  ): EventRecord => ({
    id,
    title: id,
    description,
    startsAt,
    checkedAt: now.toISOString(),
    venue: 'Example hall',
    city: 'İstanbul',
    district: 'Kadıköy',
    address: '',
    price: 300,
    currency: 'TRY',
    url: `https://example.test/${id}`,
    imageUrl: '',
    category: 'Konser',
    availability: 'available',
  });
  const nightlife = Array.from({ length: 20 }, (_, index) =>
    make(`nightlife-${index}`, 'Enerjik DJ dans partisi'),
  );
  const calm = [
    make('acoustic', 'Akustik gitar ve kontrbas performansı'),
    make('strings', 'Üç viyolonsel için hazırlanmış konser programı'),
    make('candle', 'Binlerce mum ışığında canlı müzik programı'),
  ];
  const wrongTime = make(
    'morning-acoustic',
    'Akustik konser',
    '2026-10-10T06:00:00.000Z',
  );
  const records = [...nightlife, ...calm, wrongTime];
  const semantic = {
    queryVector: [1, 0],
    vectors: new Map(
      records.map((event) => [
        event.id,
        event.id.startsWith('nightlife') ? [1, 0] : [0, 1],
      ]),
    ),
  };
  // Old request text must not restore a removed preference in the committed plan.
  const removed = shortlistEvents(
    records.filter((event) => event !== wrongTime),
    'sakin bir akşam',
    [],
    16,
    semantic,
    undefined,
    { query: 'evening', order: 'none', calmOptionalMood: false },
  );
  assert.ok(removed.every((event) => event.id.startsWith('nightlife')));
  const plan: Plan = {
    hard: {
      type: 'all',
      children: [
        { type: 'atom', atom: { kind: 'time', from: '18:00', to: '23:59' } },
      ],
    },
    preferences: [{ type: 'atom', atom: { kind: 'mood', value: 'calm' } }],
    order: 'none',
  };
  const result = await recommend(
    validateInput({
      message: 'sakin bir akşam',
      intentVersion: 2,
      filters: emptyFilters,
    }),
    {
      now,
      config: { apiKey: 'offline-test-key', model: 'jev-1.13.0' },
      inputInterpreter: 'span-v2',
      candidates: async () => records,
      embeddingConfig: {
        apiKey: 'offline-test-key',
        model: 'voyage-4-large',
        dimensions: 1024,
      },
      embed: async () => [[1, 0]],
      vectors: async () =>
        new Map(
          records.map((event) => [
            event.id,
            event.id.startsWith('nightlife') ? [1, 0] : [0, 1],
          ]),
        ),
      spanInterpret: async () => ({
        status: 'accepted',
        operations: [],
        resultingPlan: plan,
        debug: { mentions: [], answers: {} },
      }),
      rank: async (_config, _input, candidates) => {
        assert.equal(candidates.length, 16);
        assert.ok(!candidates.some((event) => event.id === wrongTime.id));
        for (const event of calm)
          assert.ok(candidates.some((candidate) => candidate.id === event.id));
        return {
          model: 'synthetic-offline-test',
          usage: { inputTokens: 0, outputTokens: 0 },
          ranked: candidates.map((event) => ({
            event,
            score: calm.includes(event) ? 3 : 0,
            confidence: 1,
            probabilities: [0, 0, 0, 1] as const,
            supportProbability: calm.includes(event) ? 1 : 0,
            programFitProbability: calm.includes(event) ? 1 : 0,
          })),
        };
      },
    },
  );
  assert.equal(result.status, 'results', JSON.stringify(result));
  assert.deepEqual(
    new Set(result.recommendations.map((card) => card.event.id)),
    new Set(calm.map((event) => event.id)),
  );
});
