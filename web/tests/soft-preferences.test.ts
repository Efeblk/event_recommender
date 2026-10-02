import assert from 'node:assert/strict';
import test from 'node:test';
import type { Condition, Plan } from '../parser/contract.ts';
import { resolveEventLocation } from '../lib/istanbul-location.ts';
import { emptyPlanState } from '../lib/plan-state.ts';
import { recommend, validateInput } from '../lib/recommend.ts';
import { shortlistEvents } from '../lib/retrieval.ts';
import {
  applySoftPreferences,
  MAX_SOFT_ADJUSTMENT,
  softPreferenceSignal,
  softPreferencesFor,
} from '../lib/soft-preferences.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';

const now = new Date('2026-10-02T09:00:00Z');
const event = (id: string, overrides: Partial<EventRecord> = {}): EventRecord => ({
  id, title: `Event ${id}`, description: 'Verified event information.', startsAt: '2026-10-03T18:00:00Z',
  checkedAt: now.toISOString(), venue: 'Salon', city: 'İstanbul', district: '', address: '',
  price: 300, currency: 'TRY', category: 'Konser', availability: 'available', imageUrl: '', url: `https://example.test/${id}`,
  attendanceTiming: { kind: 'timed_session', evidence: 'provider_sessions_and_source_text' }, ...overrides,
});
const plan = (preferences: Condition[], hard: Condition[] = []): Plan => ({ hard: { type: 'all', children: hard }, preferences, order: 'none' });
const near = (name: string, precision: 'district' | 'neighborhood' = 'district'): Condition =>
  ({ type: 'atom', atom: { kind: 'location', name, precision } });
const under = (amount: number, basis: 'per_person' | 'group_total' = 'per_person'): Condition =>
  ({ type: 'atom', atom: { kind: 'budget', comparison: 'lte', amount, currency: 'TRY', basis } });

void test('event location keeps explicit precision and never guesses through conflicts', () => {
  const at = (district: string, address = '') => resolveEventLocation(event('x', { district, address }));
  assert.deepEqual(at('KADIKÖY'), { district: 'kadikoy', side: 'asia', precision: 'district' });
  assert.deepEqual(at('', 'Osmanağa, Leylak Sk. 24/A, 34000 Kadıköy/İstanbul'), { district: 'kadikoy', side: 'asia', precision: 'district' });
  // A neighborhood that is also a district name is not the address district.
  assert.equal(at('', 'Fatih, Evliya Çelebi Sk. No:3, 34500 Büyükçekmece/İstanbul').district, 'buyukcekmece');
  assert.deepEqual(at('MECİDİYEKÖY'), { district: 'sisli', side: 'europe', precision: 'district' });
  assert.deepEqual(at('', 'Bağdat Cd. No: 8 BOSTANCI / İstanbul'), { district: 'kadikoy', side: 'asia', precision: 'district' });
  assert.deepEqual(at('İstanbul Anadolu'), { district: null, side: 'asia', precision: 'side' });
  assert.deepEqual(at('MALTEPE/KARTAL'), { district: null, side: 'asia', precision: 'side' });
  // A side label is upgraded only by agreeing district evidence.
  assert.deepEqual(at('İstanbul Anadolu', 'Caferağa, Moda Cd. No: 1, Kadıköy/İstanbul'), { district: 'kadikoy', side: 'asia', precision: 'district' });
  assert.equal(at('İstanbul Avrupa', 'Caferağa, Moda Cd. No: 1, Kadıköy/İstanbul').precision, 'unknown');
  assert.equal(at('BEYOĞLU', 'Levazım Mah. 34340 Beşiktaş/İstanbul').precision, 'unknown');
  assert.equal(at('', 'İstiklal Caddesi No: 171 İSTANBUL 34433').precision, 'unknown');
});

void test('location signal rewards matches, discounts the other side and treats unknown as neutral', () => {
  const soft = softPreferencesFor(plan([near('Kadıköy')]))!;
  const signal = (district: string, address = '') => softPreferenceSignal(event('x', { district, address }), soft);
  assert.equal(signal('Kadıköy'), 1);
  assert.equal(signal('Üsküdar'), 0.25);
  assert.equal(signal('İstanbul Anadolu'), 0.25);
  assert.equal(signal('Beşiktaş'), -0.5);
  assert.equal(signal(''), 0);
  const moda = softPreferencesFor(plan([near('Moda', 'neighborhood')]))!;
  assert.equal(softPreferenceSignal(event('x', { district: 'Kadıköy' }), moda), 0.75);
  // Unrecognized place names are not scored at all.
  assert.equal(softPreferenceSignal(event('x', { district: 'Kadıköy' }), softPreferencesFor(plan([near('Atlantis')]))!), 0);
});

void test('budget signal is graded, uses the plan party for group totals and keeps unknown prices neutral', () => {
  const soft = softPreferencesFor(plan([under(500)]))!;
  assert.equal(softPreferenceSignal(event('x', { price: 450 }), soft), 1);
  assert.ok(Math.abs(softPreferenceSignal(event('x', { price: 600 }), soft) + 0.4) < 1e-9);
  assert.equal(softPreferenceSignal(event('x', { price: 2000 }), soft), -1);
  assert.equal(softPreferenceSignal(event('x', { price: null }), soft), 0);
  assert.equal(softPreferenceSignal(event('x', { price: 450, currency: 'EUR' }), soft), 0);
  const party = (count: number): Condition => ({ type: 'atom', atom: { kind: 'party', count } });
  const group = softPreferencesFor(plan([under(1000, 'group_total')], [party(3)]))!;
  assert.equal(softPreferenceSignal(event('x', { price: 300 }), group), 1);
  assert.ok(softPreferenceSignal(event('x', { price: 400 }), group) < 0);
  assert.equal(softPreferenceSignal(event('x', { price: 300 }), softPreferencesFor(plan([under(1000, 'group_total')]))!), 0);
});

void test('soft preferences are bounded nudges and absent preferences change nothing', () => {
  assert.equal(softPreferencesFor(plan([])), undefined);
  assert.equal(softPreferencesFor(plan([{ type: 'atom', atom: { kind: 'topic', value: 'jazz' } }])), undefined);
  const ranked = Array.from({ length: 40 }, (_, i) => event(`e${i}`));
  assert.deepEqual(applySoftPreferences(ranked, undefined), ranked);
  ranked[30] = event('far-match', { district: 'Kadıköy' });
  ranked[5] = event('near-match', { district: 'Kadıköy' });
  const soft = softPreferencesFor(plan([near('Kadıköy')]))!;
  const result = applySoftPreferences(ranked, soft).map((item) => item.id);
  assert.equal(result[0], 'near-match');
  // A full match at rank 30 scores 1.25/91, passing only ranks whose 1/(61+r)
  // is lower: it lands after near-match and e0–e11 (minus e5), at index 12.
  assert.equal(MAX_SOFT_ADJUSTMENT, 0.25);
  assert.equal(result.indexOf('far-match'), 12);
  assert.equal(new Set(result).size, ranked.length);
  // Equal signals keep relevance order.
  assert.deepEqual(result.filter((id) => id.startsWith('e')), ranked.map((item) => item.id).filter((id) => id.startsWith('e')));
});

void test('composite preferences take the best alternative and ignore negations', () => {
  const either: Condition = { type: 'any', children: [near('Kadıköy'), near('Beşiktaş')] };
  const soft = softPreferencesFor(plan([either]))!;
  assert.equal(softPreferenceSignal(event('x', { district: 'Beşiktaş' }), soft), 1);
  assert.equal(softPreferencesFor(plan([{ type: 'not', child: near('Kadıköy') }])), undefined);
});

void test('the resolved plan path shortlists preferred locations first without removing others', () => {
  const events = [event('besiktas', { district: 'Beşiktaş' }), event('unknown'), event('kadikoy', { district: 'Kadıköy' })];
  const resolved = { query: 'konser', order: 'none' as const, softPreferences: softPreferencesFor(plan([near('Kadıköy')])) };
  const ids = shortlistEvents(events, 'konser', [], 16, undefined, undefined, resolved).map((item) => item.id);
  assert.equal(ids[0], 'kadikoy');
  assert.deepEqual(new Set(ids), new Set(['besiktas', 'unknown', 'kadikoy']));
});

void test('span-v2 recommendations apply plan location preferences to fallback ranking', async () => {
  const events = [event('besiktas', { district: 'Beşiktaş' }), event('kadikoy', { district: 'Kadıköy' })];
  const resultingPlan = plan([near('Kadıköy')], [{ type: 'atom', atom: { kind: 'category', value: 'concert' } }]);
  const result = await recommend(validateInput({ message: 'konser, Kadıköy olursa iyi olur', intentVersion: 2, planState: emptyPlanState(), filters: emptyFilters }), {
    now, config: null, inputInterpreter: 'span-v2', candidates: async () => events,
    spanInterpret: async () => ({ status: 'accepted', operations: [], resultingPlan, debug: { mentions: [], answers: {} } }),
  });
  assert.deepEqual(result.recommendations.map((item) => item.event.id), ['kadikoy', 'besiktas']);
});

void test('side preferences and requirements use resolved venue sides', async () => {
  const side = (name: string): Condition => ({ type: 'atom', atom: { kind: 'location', name, precision: 'side' } });
  const soft = softPreferencesFor(plan([side('Anadolu yakası')]))!;
  assert.equal(softPreferenceSignal(event('x', { district: 'Üsküdar' }), soft), 1);
  assert.equal(softPreferenceSignal(event('x', { district: 'İstanbul Anadolu' }), soft), 1);
  assert.equal(softPreferenceSignal(event('x', { district: 'Şişli' }), soft), -0.5);
  assert.equal(softPreferenceSignal(event('x'), soft), 0);
  const { evaluatePlan, validateSearchPlan } = await import('../lib/plan-evidence.ts');
  const { validatePlan } = await import('../parser/state.ts');
  const required = plan([], [side('Avrupa yakası')]);
  validateSearchPlan(required);
  validatePlan(required);
  assert.throws(() => validatePlan(plan([], [side('Kuzey yakası')])), /invalid Istanbul side/);
  assert.throws(() => validateSearchPlan(plan([], [{ type: 'atom', atom: { kind: 'location', name: 'Kuzey yakası', precision: 'side' } }])));
  const status = (overrides: Partial<EventRecord>) => evaluatePlan(event('x', overrides), required, now).status;
  assert.equal(status({ district: 'Beşiktaş' }), 'supported');
  assert.equal(status({ district: 'İstanbul Avrupa' }), 'supported');
  assert.equal(status({ district: 'Kadıköy' }), 'contradicted');
  assert.equal(status({}), 'unknown');
  assert.equal(status({ district: 'İstanbul Avrupa', address: 'Moda Cd. No: 1, Kadıköy/İstanbul' }), 'unknown');
});

void test('requests read the publication-time location and recompute only other profiles', async () => {
  const { eventLocation } = await import('../lib/istanbul-location.ts');
  const { buildSearchCatalog } = await import('../lib/materialized-catalog.ts');
  const catalog = buildSearchCatalog([event('k', { district: '', address: 'Moda Cd. No: 1, Kadıköy/İstanbul' })], now);
  const [published] = catalog.groups[0].versions[0].events;
  assert.deepEqual(published.preparedSearch?.location, { profile: 'istanbul-location-v1', district: 'kadikoy', side: 'asia', precision: 'district' });
  // The stored value is authoritative for its profile; raw fields are not re-parsed.
  const stored = { ...published, district: 'Beşiktaş', address: '' };
  assert.equal(eventLocation(stored).district, 'kadikoy');
  const otherProfile = { ...stored, preparedSearch: { ...stored.preparedSearch!, location: { ...stored.preparedSearch!.location!, profile: 'old' as 'istanbul-location-v1' } } };
  assert.equal(eventLocation(otherProfile).district, 'besiktas');
});
