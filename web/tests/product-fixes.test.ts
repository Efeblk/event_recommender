import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { checkAgeEvidence } from '../lib/age-evidence.ts';
import { isStandaloneAlternativesRequest } from '../lib/intent.ts';
import { buildJevRequest, parseJevRanking, rankWithJev } from '../lib/jev.ts';
import { evaluatePlan } from '../lib/plan-evidence.ts';
import { emptyPlanState } from '../lib/plan-state.ts';
import { recommend, validateInput, type Dependencies } from '../lib/recommend.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
import type { Atom, Condition, ParserInput, Plan } from '../parser/contract.ts';
import { extract } from '../parser/extract.ts';
import { buildRequest, compose, type JevResponse } from '../parser/parse-core.ts';

// These are preserved source cards and independent expected family labels.
// Provider answers below are synthetic: this verifies wiring, not calibration.
const fixture = JSON.parse(await readFile(new URL('../fixtures/staging-mood-2026-10-03.json', import.meta.url), 'utf8')) as {
  now: string; message: string; cards: { label: string; event: EventRecord }[];
};
const now = new Date(fixture.now);
const config = { apiKey: 'mock-only', model: 'jev-1.13.0' };
const atom = (value: Atom): Condition => ({ type: 'atom', atom: value });
const plan = (hard: Condition[] = [], preferences: Condition[] = []): Plan => ({ hard: { type: 'all', children: hard }, preferences, order: 'none' });
const atoms = (condition: Condition): Atom[] => condition.type === 'atom' ? [condition.atom]
  : condition.type === 'not' ? atoms(condition.child) : condition.children.flatMap(atoms);
const parserInput = (utterance: string): ParserInput => ({ utterance, language: 'tr', referenceDate: '2026-10-03', timezone: 'Europe/Istanbul', previousState: null });

function interpret(input: ParserInput, mandatoryMood = false) {
  const built = buildRequest(input);
  const answers = Object.fromEntries(Object.entries(built.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: mandatoryMood && id.startsWith('mandatory_mood_') ? 1 : 0 }];
    const keys = Object.keys(question.criteria);
    const choice = id.startsWith('polarity_') ? 'wanted' : id.startsWith('link_') ? 'and'
      : id.startsWith('edit_') ? 'unchanged' : id.startsWith('hedge_') ? 'none'
        : id.startsWith('clock_') ? 'at' : id === 'action' ? 'continue'
          : id === 'order' ? 'unchanged' : keys[0];
    assert.ok(keys.includes(choice), `${id}: ${choice}`);
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
  }));
  return compose(input, built, { model: config.model, answers, usage: { input_tokens: 0, output_tokens: 0 } } as JevResponse);
}
const request = (message: string) => validateInput({ message, intentVersion: 2, filters: emptyFilters });
const events = fixture.cards.map(card => card.event);
const expected = ['f08f53854f736981036894f7', 'session-7ff4c741d9278e13c9cce38b6a65336a'];
const eveningIds = [...expected, 'session-56323a041e257cbadbf822819f5dfe09'];

void test('Turkish type indifference never invents a tour; real tour counterexamples remain', () => {
  for (const message of ['tür fark etmez', 'Tür fark etmez', 'tur fark etmez', 'tür önemli değil']) {
    assert.ok(!extract(message, '2026-10-03').mentions.some(m => m.kind === 'category' && m.value === 'tour'), message);
  }
  for (const message of ['tur istiyorum', 'gezi turu', 'guided tour']) {
    assert.ok(extract(message, '2026-10-03').mentions.some(m => m.kind === 'category' && m.value === 'tour'), message);
  }
});

void test('original live request represents its exact dates, evening, partner and optional moods', () => {
  const result = interpret(parserInput(fixture.message));
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') return;
  const hard = atoms(result.resultingPlan.hard);
  assert.ok(hard.some(a => a.kind === 'date' && a.from === '2026-10-04' && a.to === '2026-10-11'));
  assert.ok(hard.some(a => a.kind === 'time' && a.from === '18:00' && a.to === '23:59'));
  assert.ok(hard.some(a => a.kind === 'companion' && a.value === 'partner'));
  assert.ok(!hard.some(a => a.kind === 'category' || a.kind === 'mood' || (a.kind === 'experience' && a.value === 'quiet')));
  assert.deepEqual(result.resultingPlan.preferences.flatMap(atoms).filter(a => a.kind === 'mood'), [{ kind: 'mood', value: 'calm' }, { kind: 'mood', value: 'intimate' }]);
  assert.deepEqual(events.filter(e => evaluatePlan(e, result.resultingPlan, now).status === 'supported').map(e => e.id), eveningIds);
});

void test('English evenings and Turkish tonight retain local clock bounds; explicit clocks win', () => {
  for (const message of ['a calm intimate evening with my partner', 'bu akşam sakin bir etkinlik', 'tonight, a calm event']) {
    const result = interpret(parserInput(message));
    assert.equal(result.status, 'accepted', message);
    if (result.status === 'accepted') assert.ok(atoms(result.resultingPlan.hard).some(a => a.kind === 'time' && a.from === '18:00' && a.to === '23:59'), message);
  }
  const mentions = extract('akşam 7 konser', '2026-10-03').mentions.filter(m => m.kind === 'time');
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0].clock, '19:00');
});

void test('mandatory calm remains an evidence rule and mandatory intimacy is unsupported', () => {
  const calm = interpret(parserInput('Kesinlikle sakin ortam şart'), true);
  assert.equal(calm.status, 'accepted');
  if (calm.status === 'accepted') {
    assert.ok(atoms(calm.resultingPlan.hard).some(a => a.kind === 'experience' && a.value === 'quiet'));
    assert.notEqual(evaluatePlan(events[0], calm.resultingPlan, now).status, 'supported');
    for (const description of ['Sessiz bir ortam değildir.', 'Not a quiet venue.', 'Sakin ortam olmayan bir mekandır.'])
      assert.notEqual(evaluatePlan({ ...events[0], description }, calm.resultingPlan, now).status, 'supported', description);
  }
  assert.equal(interpret(parserInput('Kesinlikle samimi ortam şart'), true).status, 'unsupported');
});

void test('attendee ages survive Turkish digits, words and English extraction/composition', () => {
  for (const message of ['6 yaşındaki çocuğumla gideceğim', 'altı yaşındaki çocuğumla', 'with my 6-year-old child', 'with my six year old child']) {
    const result = interpret(parserInput(message));
    assert.equal(result.status, 'accepted', message);
    if (result.status === 'accepted') assert.ok(atoms(result.resultingPlan.hard).some(a => a.kind === 'age' && a.years === 6), message);
  }
});

void test('age admission uses explicit source rules and preserves unknown/conflicting/negated evidence', () => {
  const cases: [string, string][] = [
    ['Yaş sınırı: 6+', 'supported'], ['Yaş aralığı: 4–8', 'supported'], ['4-8 yaş arası çocuklara yöneliktir.', 'supported'],
    ['Suitable for children aged 6+', 'supported'], ['All ages', 'supported'], ['Her yaş için uygundur.', 'supported'],
    ['Yaş sınırı: 8+', 'contradicted'], ['+13 yaş sınırı vardır.', 'contradicted'], ['Adults only', 'contradicted'],
    ['Yaş sınırı: 6+. Yaş sınırı: 18+', 'unknown'], ['Not suitable for all ages.', 'unknown'], ['Her yaş için uygundur ifadesi geçerli değil.', 'unknown'],
    ['6+ çocuklara uygun değildir.', 'unknown'], ['Yaş sınırı: 6+ değildir.', 'unknown'], ['Sanatçı 4-8 yaş arası çocuklarla bir okula gitti.', 'unknown'], ['Her music fascinates all ages.', 'unknown'],
    ['Sanatçı 6 yaşında piyano öğrenmeye başladı.', 'unknown'], ['Çocuklar için eğlenceli gösteri', 'unknown'], ['', 'unknown'],
  ];
  for (const [description, status] of cases) assert.equal(checkAgeEvidence({ ...events[0], description }, 6).status, status, description);
});

function rankingResponse(candidates: EventRecord[], fit: (id: string) => number) {
  return { model: config.model, usage: { input_tokens: 0, output_tokens: 0 }, answers: Object.fromEntries(candidates.flatMap((event, index) => [
    [`candidate_${index}`, { type: 'score', score: 3, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 } }],
    [`program_fit_${index}`, { type: 'noul', noul: fit(event.id) }],
  ])) };
}
const deps = (extra: Partial<Dependencies> = {}): Dependencies => ({ now, config, inputInterpreter: 'span-v2', candidates: async () => events, spanInterpret: async input => interpret(input), ...extra });

void test('preserved staging family: evening checks precede one batched program-fit ranking call', async () => {
  let calls = 0;
  const result = await recommend(request(fixture.message), deps({ rank: async (configuration, input, candidates) => {
    assert.deepEqual(candidates.map(e => e.id).sort(), [...eveningIds].sort());
    return rankWithJev(configuration, input, candidates, async (_url, init) => {
      calls++;
      assert.equal(typeof init?.body, 'string');
      const body = JSON.parse(init!.body as string);
      assert.equal(Object.values(body.questions).filter((q: unknown) => (q as { type: string }).type === 'noul').length, 3);
      return Response.json(rankingResponse(candidates, id => expected.includes(id) ? 0.95 : 0.1));
    });
  } }));
  assert.equal(calls, 1);
  assert.equal(result.status, 'results');
  assert.deepEqual(result.recommendations.map(card => card.event.id).sort(), [...expected].sort());
  assert.equal(new Set(result.recommendations.map(card => card.event.id)).size, 2);
});

void test('missing, malformed and weak program-fit judgments cannot become mood matches or fallback filler', async () => {
  const missing = rankingResponse([events[0]], () => 1);
  delete (missing.answers as Record<string, unknown>).program_fit_0;
  assert.throws(() => parseJevRanking(missing, [events[0]], true));
  assert.throws(() => parseJevRanking(rankingResponse([events[0]], () => 2), [events[0]], true));
  for (const rank of [
    async () => { throw new Error('mock outage'); },
    async (_c: unknown, _i: unknown, candidates: EventRecord[]) => parseJevRanking(rankingResponse(candidates, () => 0.5), candidates, true),
    async (_c: unknown, _i: unknown, candidates: EventRecord[]) => parseJevRanking(rankingResponse(candidates, () => 1), candidates),
  ]) {
    const result = await recommend(request(fixture.message), deps({ rank }));
    assert.equal(result.recommendations.length, 0);
  }
  assert.equal((await recommend(request(fixture.message), deps({ config: null }))).recommendations.length, 0);
});

void test('age checks also apply to unranked fallback and cannot be overridden by high AI scores', async () => {
  const records = [
    { ...events[0], id: 'known-age', description: 'Yaş sınırı: 6+', category: 'Gösteri' },
    { ...events[0], id: 'unknown-age', description: 'Çocuk gösterisi', category: 'Gösteri' },
    { ...events[0], id: 'too-young', description: 'Yaş sınırı: 8+', category: 'Gösteri' },
  ];
  const agePlan = plan([atom({ kind: 'age', years: 6 })]);
  for (const ai of [false, true]) {
    const result = await recommend(request('6 yaşındaki çocuğumla'), deps({ config: ai ? config : null, candidates: async () => records,
      spanInterpret: async () => ({ status: 'accepted', operations: [], resultingPlan: agePlan, debug: { mentions: [], answers: {} } }),
      rank: async (_c, _i, candidates) => { assert.deepEqual(candidates.map(e => e.id), ['known-age']); return parseJevRanking(rankingResponse(candidates, () => 1), candidates); },
    }));
    assert.deepEqual(result.recommendations.map(card => card.event.id), ['known-age']);
  }
});

void test('standalone alternatives preserve the complete plan without interpretation; mixed constraints do not bypass', async () => {
  for (const message of ['Bunları beğenmedim, başka seçenekler var mı?', 'anything else?', 'show me alternatives']) assert.equal(isStandaloneAlternativesRequest(message), true);
  for (const message of ['başka seçenekler ama 500 TL altında', 'other options tomorrow', 'anything else without concerts']) assert.equal(isStandaloneAlternativesRequest(message), false);
  const previous = { ...emptyPlanState(), revision: 1, plan: plan([atom({ kind: 'age', years: 6 }), atom({ kind: 'time', from: '18:00', to: '23:59' })], [atom({ kind: 'mood', value: 'calm' })]), requests: ['original request'] };
  let interpretations = 0;
  const result = await recommend(validateInput({ message: 'Bunları beğenmedim, başka seçenekler var mı?', intentVersion: 2, planState: previous, filters: emptyFilters }), deps({
    candidates: async () => [], spanInterpret: async () => { interpretations++; throw new Error('must not interpret pure alternatives'); },
  }));
  assert.equal(interpretations, 0);
  assert.deepEqual(result.planState?.plan, previous.plan);
  const mixed = await recommend(validateInput({ message: 'other options tomorrow', intentVersion: 2, planState: previous, filters: emptyFilters }), deps({
    candidates: async () => [], spanInterpret: async input => { interpretations++; return interpret(input); },
  }));
  assert.equal(interpretations, 1);
  assert.ok(mixed.planState && atoms(mixed.planState.plan.hard).some(a => a.kind === 'date'));
});

void test('full 16-candidate mood ranking retains the bounded serialized request', () => {
  const body = buildJevRequest(config.model, { message: fixture.message, filters: emptyFilters, history: [], plan: plan([], [atom({ kind: 'mood', value: 'calm' }), atom({ kind: 'mood', value: 'intimate' })]) },
    Array.from({ length: 16 }, (_, index) => ({ ...events[0], id: `candidate-${index}`, description: 'ü'.repeat(5000) })));
  assert.equal(Object.keys(body.questions).length, 32);
  assert.ok(new TextEncoder().encode(JSON.stringify(body)).length <= 100000);
});

void test('an excluded event type is a supported condition, not an unsupported clause', () => {
  const input = parserInput('yarın iki kişilik sevgilimle taksim civarı konser olmayan etkinlik');
  const built = buildRequest(input);
  const question = built.questions.unsupported_s0;
  assert.equal(question?.type, 'noul');
  assert.match(JSON.stringify(question), /excluding a supported event type, topic or genre \(\\"konser olmayan\\"/u);
  const concert = built.mentions.find(m => m.kind === 'category' && m.value === 'concert');
  assert.ok(concert);
  const answers = Object.fromEntries(Object.entries(built.questions).map(([id, q]) => {
    if (q.type === 'noul') return [id, { type: 'noul', noul: 0 }];
    const keys = Object.keys(q.criteria);
    const choice = id === `polarity_${concert.id}` ? 'unwanted' : id.startsWith('polarity_') ? 'wanted'
      : id.startsWith('hedge_') ? 'none' : id === 'action' ? 'continue' : id === 'order' ? 'unchanged' : keys[0];
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(key => [key, key === choice ? 1 : 0])) }];
  }));
  const result = compose(input, built, { model: config.model, answers, usage: { input_tokens: 0, output_tokens: 0 } } as JevResponse);
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') return;
  const hard = atoms(result.resultingPlan.hard);
  assert.ok(hard.some(a => a.kind === 'date' && a.from === '2026-10-04' && a.to === '2026-10-04'));
  assert.ok(hard.some(a => a.kind === 'party' && a.count === 2));
  assert.ok(hard.some(a => a.kind === 'companion' && a.value === 'partner'));
  assert.ok(hard.some(a => a.kind === 'location' && a.name === 'Beyoğlu'));
  assert.ok(result.resultingPlan.preferences.flatMap(atoms).some(a => a.kind === 'location' && a.name === 'Taksim'));
  assert.ok((result.resultingPlan.hard.type === 'all' ? result.resultingPlan.hard.children : []).some(c => c.type === 'not' && c.child.type === 'atom' && c.child.atom.kind === 'category' && c.child.atom.value === 'concert'));
});
