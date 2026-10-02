import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJevRequest } from '../lib/jev.ts';
import { buildInputCandidates } from '../lib/input-candidates.ts';
import { buildInputInterpreterRequest, interpretInput, parseInputInterpreterResponse } from '../lib/input-interpreter.ts';
import { emptyIntentState, type IntentState } from '../lib/input-state.ts';
import { recommend, validateInput, type Dependencies } from '../lib/recommend.ts';
import type { EventRecord } from '../lib/types.ts';

const now = new Date('2026-09-30T09:00:00Z');
const config = { apiKey: 'test-only', model: 'jev-test' };
const event = (id: string, description: string, category = 'Sergi'): EventRecord => ({
  id, title: id, description, category, startsAt: '2026-10-04T16:00:00Z',
  checkedAt: now.toISOString(), venue: 'Test Mekânı', city: 'İstanbul', district: 'Üsküdar',
  address: '', price: 400, currency: 'TRY', availability: 'available', imageUrl: '', url: `https://example.test/${id}`,
});

function structured(state: IntentState, message = 'Aynı koşullar') {
  return validateInput({ message, intentVersion: 1, intentState: state });
}

function providerAnswer(message: string, previous: IntentState, overrides: Record<string, string>, unresolvedRequest?: string) {
  const request = buildInputInterpreterRequest('jev-test', { message, previous, now, unresolvedRequest });
  const defaults: Record<string, string> = {
    action: 'search', issue: 'none', budget: 'keep', budget_basis: 'none', budget_boundary: 'none',
    party: 'keep', date: 'keep', order: 'keep', time: 'keep', district: 'keep', companion: 'keep', mood: 'keep',
    interest_clear: 'keep', topic_clear: 'keep', candidate_coverage: 'complete', genre_logic: 'keep', activity_logic: 'keep',
  };
  return { model: 'jev-test', answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const options = Object.keys(question.criteria);
    const choice = overrides[id] ?? defaults[id] ?? (id.startsWith('interest_') ? 'skip' : options.includes('keep') ? 'keep' : options[0]);
    assert.ok(options.includes(choice), `${id}: ${choice}`);
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])) }];
  })) };
}

void test('required photography is separate from optional Workshop and mock source support admits only the exhibition', async () => {
  const state = emptyIntentState();
  state.primaryTopics = ['fotoğraf'];
  state.preferences.interests = ['Workshop'];
  const exhibition = event('Fotoğraf Sergisi', 'Sanatçıların fotoğraf eserlerinden oluşan sergi programı.');
  const pottery = event('Çömlek Atölyesi', 'Katılımcılar seramik ve çömlek yapar.', 'Workshop');
  const biography = event('Fotoğrafçının Yaşamı', 'Bir fotoğrafçının yaşam öyküsünü anlatan söyleşi.', 'Söyleşi');
  let observed: Parameters<NonNullable<Dependencies['rank']>>[1] | undefined;
  const result = await recommend(structured(state), {
    inputInterpreter: 'jev-v1', now, config, interpret: async () => ({ state, action: 'search', issue: null, query: '', origin: 'jev' }),
    candidates: async () => [pottery, biography, exhibition],
    rank: async (_config, input, candidates) => {
      observed = input;
      // Disclosed deterministic mock: it represents asserted source-support outcomes, not observed Jev behavior.
      return { model: 'mock-negative-control', usage: { inputTokens: 0, outputTokens: 0 }, ranked: candidates.map((candidate) => {
        const supported = candidate.id === exhibition.id;
        return { event: candidate, score: supported ? 3 : 1, confidence: 1, probabilities: supported ? [0, 0, 0, 1] as const : [0, 1, 0, 0] as const, supportProbability: supported ? 1 : 0 };
      }) };
    },
  });
  assert.deepEqual(observed?.primaryTopics, ['fotoğraf']);
  assert.deepEqual(observed?.preferences?.interests, ['Workshop']);
  assert.deepEqual(result.recommendations.map(({ event }) => event.id), [exhibition.id]);
});

void test('Jev receives every required topic outside the bounded query and states attendee-program evidence rules', () => {
  const topics = Array.from({ length: 8 }, (_, index) => `${index}-${'uzunkonu'.repeat(18)}`.slice(0, 160));
  const body = buildJevRequest('jev-test', {
    message: 'x'.repeat(1200), history: [], filters: emptyIntentState().filters, primaryTopics: topics,
  }, [event('candidate', 'Bir etkinlik programı.')]);
  assert.deepEqual(body.state.requiredPrimaryTopics, topics);
  assert.equal(body.state.mandatoryRequirements.filter((item) => item.kind === 'primary_topic').length, 8);
  assert.match(body.state.primaryTopicEvidencePolicy ?? '', /attendee program.*specifically support every entry/i);
  assert.match(body.state.primaryTopicEvidencePolicy ?? '', /biography.*incidental photo opportunity/i);
});

void test('topic verification outages return no cards and a pinned catalog notice cannot overwrite the reason', async () => {
  const state = emptyIntentState(); state.primaryTopics = ['fotoğraf'];
  const candidate = event('Fotoğraf Sergisi', 'Fotoğraf sergisi.');
  const base = { inputInterpreter: 'jev-v1' as const, now, interpret: async () => ({ state, action: 'search' as const, issue: null, query: '', origin: 'jev' as const }), candidates: async () => [candidate] };
  const absent = await recommend(structured(state), { ...base, config: null });
  assert.equal(absent.recommendations.length, 0);
  assert.match(absent.notice ?? '', /doğrulayan değerlendirme.*kullanılamıyor/i);
  const thrown = await recommend(structured(state), { ...base, config, rank: async () => { throw new Error('mock outage'); } });
  assert.equal(thrown.recommendations.length, 0);
  assert.match(thrown.notice ?? '', /doğrulanmamış etkinlik göstermiyoruz/i);
  const pinned = await recommend(structured(state), { ...base, config: null, pinCatalog: async () => ({ publicationId: 'p1', candidates: async () => [candidate], vectors: async () => new Map(), finalize: async (events) => events, emptyResultNotice: () => 'CATALOG ABSENCE' }) });
  assert.doesNotMatch(pinned.notice ?? '', /CATALOG ABSENCE/);
  assert.match(pinned.notice ?? '', /doğrulayan değerlendirme/i);
});

void test('topic corrections, Boolean scope, follow-ups, resets, arrival and geography retain their exact consequences', async () => {
  const previous = emptyIntentState(); previous.primaryTopics = ['fotoğraf', 'müzik'];
  const correction = 'fotoğraf değil seramik';
  const request = buildInputInterpreterRequest('jev-test', { message: correction, previous, now });
  const ceramic = request.state.sourceCandidates.interests.find((item) => item.value === 'seramik')!;
  const corrected = parseInputInterpreterResponse(providerAnswer(correction, previous, { prior_topic_0: 'remove', [`interest_${ceramic.id}`]: 'primary' }), { message: correction, previous, now });
  assert.deepEqual(corrected.state.primaryTopics, ['müzik', 'seramik']);

  const scoped = buildInputCandidates('Pazar fotoğraf veya seramik olsun', now, emptyIntentState());
  assert.ok(scoped.dates.length > 0);
  assert.ok(scoped.interests.some((item) => item.value.includes('fotoğraf veya seramik')));
  const alternatives = await interpretInput({ message: 'başka seçenekler', previous: corrected.state, now }, { config: null });
  assert.deepEqual(alternatives.state.primaryTopics, corrected.state.primaryTopics);
  const reset = await interpretInput({ message: 'sıfırla', previous: corrected.state, now }, { config: null });
  assert.equal(reset.state.primaryTopics, undefined);

  const arrival = await interpretInput({ message: 'İş çıkışı olsun', previous: emptyIntentState(), now }, { config: null });
  assert.equal(arrival.issue, 'arrival_time_ambiguous');
  const reply = buildInputInterpreterRequest('jev-test', { message: '18:30', unresolvedRequest: 'İş çıkışı olsun', previous: emptyIntentState(), now });
  assert.ok(reply.state.sourceCandidates.times.some((item) => item.value.startTimeFrom === '18:30' && item.value.startTimeTo === undefined && item.value.startTimeFromExclusive === false));
  const resetPending = await interpretInput({ message: 'sıfırla, pazar seramik', unresolvedRequest: 'İş çıkışı olsun', previous: emptyIntentState(), now }, { config: null });
  assert.notEqual(resetPending.issue, 'arrival_time_ambiguous');

  const sideRequest = buildInputInterpreterRequest('jev-test', { message: 'Anadolu yakası tercihen', previous: emptyIntentState(), now });
  const sideCandidate = sideRequest.state.sourceCandidates.interests.find((item) => item.value.includes('Anadolu'));
  assert.ok(sideCandidate);
  const optionalSide = providerAnswer('Anadolu yakası tercihen', emptyIntentState(), { [`interest_${sideCandidate.id}`]: 'optional' });
  const optionalResult = parseInputInterpreterResponse(optionalSide, { message: 'Anadolu yakası tercihen', previous: emptyIntentState(), now });
  assert.equal(optionalResult.issue, null);
  assert.deepEqual(optionalResult.state.preferences.interests, [sideCandidate.value]);
  const hardSide = parseInputInterpreterResponse(providerAnswer('Anadolu yakası zorunlu, tercihen workshop', emptyIntentState(), {}), { message: 'Anadolu yakası zorunlu, tercihen workshop', previous: emptyIntentState(), now });
  assert.equal(hardSide.issue, 'unsupported_constraint');
});

void test('saved group root and precise correction preserve every hard consequence', () => {
  const rootMessage = 'Pazar 4 kişiyiz, toplam 3200 liraya komedi oyunu ya da standup bakalım; Anadolu yakası tercihimiz.';
  const rootRequest = buildInputInterpreterRequest('jev-test', { message: rootMessage, previous: emptyIntentState(), now });
  const side = rootRequest.state.sourceCandidates.interests.find((item) => item.value.includes('Anadolu'));
  assert.ok(side);
  const root = parseInputInterpreterResponse(providerAnswer(rootMessage, emptyIntentState(), {
    budget: rootRequest.state.sourceCandidates.amounts.find((item) => item.value === 3200)!.id,
    budget_basis: 'group_total', budget_boundary: 'inclusive',
    party: rootRequest.state.sourceCandidates.partySizes.find((item) => item.value === 4)!.id,
    date: rootRequest.state.sourceCandidates.dates[0].id,
    category_theatre: 'include', category_standup: 'include', req_genre_comedy: 'require',
    [`interest_${side.id}`]: 'optional',
  }), { message: rootMessage, previous: emptyIntentState(), now });
  assert.equal(root.issue, null);
  assert.equal(root.state.filters.partySize, 4);
  assert.equal(root.state.filters.totalBudget, 3200);
  assert.equal(root.state.filters.maxPrice, 800);
  assert.equal(root.state.filters.dateFrom, '2026-10-04');
  assert.deepEqual(root.state.filters.categories, ['Tiyatro', 'Stand-up']);
  assert.ok(root.state.requirements.some((item) => item.kind === 'genre' && item.value === 'comedy'));
  assert.equal(root.state.primaryTopics, undefined);
  assert.ok(root.state.preferences.interests.some((item) => item.includes('Anadolu')));
  assert.equal(side.role, undefined);
  const sideScope = rootRequest.state.sourceScopes.find((scope) => scope.id === side.scope?.context);
  assert.match(sideScope?.text ?? '', /Anadolu yakası tercihimiz/u);

  const correction = 'pardon toplam değil kişi başı 800 demek istemiştim; bir de kesin Kadıköy olsun, diğerleri aynı';
  const correctionRequest = buildInputInterpreterRequest('jev-test', { message: correction, unresolvedRequest: rootMessage, previous: root.state, now });
  const corrected = parseInputInterpreterResponse(providerAnswer(correction, root.state, {
    budget: correctionRequest.state.sourceCandidates.amounts.find((item) => item.value === 800)!.id,
    budget_basis: 'per_person', budget_boundary: 'inclusive',
    party: 'keep', date: 'keep', district: correctionRequest.state.sourceCandidates.districts.find((item) => item.value === 'Kadıköy')!.id,
  }, rootMessage), { message: correction, unresolvedRequest: rootMessage, previous: root.state, now });
  assert.equal(corrected.issue, null);
  assert.equal(corrected.state.filters.maxPrice, 800);
  assert.equal(corrected.state.filters.totalBudget, undefined);
  assert.equal(corrected.state.filters.partySize, 4);
  assert.equal(corrected.state.filters.district, 'Kadıköy');
  assert.deepEqual(corrected.state.filters.categories, ['Tiyatro', 'Stand-up']);
  assert.ok(corrected.state.requirements.some((item) => item.kind === 'genre' && item.value === 'comedy'));
  assert.equal(corrected.state.primaryTopics, undefined);
  assert.deepEqual(corrected.state.preferences.interests, root.state.preferences.interests);
});
