import test from 'node:test';
import assert from 'node:assert/strict';
import { eventDateLabel } from '../lib/event-date.ts';
import { isEligible } from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';

const now = new Date('2026-09-29T09:00:00.000Z');
const event: EventRecord = { id: 'admission', title: 'Müze Girişi', description: '',
  startsAt: '2026-09-30T14:00:00.000Z', checkedAt: now.toISOString(), venue: 'Müze',
  city: 'İstanbul', district: '', address: '', price: 280, currency: 'TRY', url: '', imageUrl: '',
  category: 'Müze', availability: 'available', attendanceTiming: { kind: 'admission_window',
    evidence: 'provider_flexible_window', validFrom: '2026-09-01T07:00:00.000Z', validThrough: '2026-09-30T14:00:00.000Z' } };

await test('validity end is neither displayed nor filtered as an appointment time', () => {
  assert.equal(isEligible(event, emptyFilters, now), true);
  assert.equal(isEligible(event, { ...emptyFilters, startTimeFrom: '17:00' }, now), false);
  const label = eventDateLabel(event);
  assert.match(label, /1 Eylül 2026.*30 Eylül 2026/);
  assert.doesNotMatch(label, /17:00|10:00/);
  assert.match(label, /Ziyaret saatlerini kontrol edin/);
});
await test('unknown and legacy attendance cannot satisfy clock bounds while explicit timed sessions can', () => {
  const unknown = { ...event, attendanceTiming: { kind: 'unknown' as const, evidence: 'insufficient_source_evidence' as const } };
  assert.equal(isEligible(unknown, { ...emptyFilters, startTimeTo: '18:00' }, now), false);
  assert.doesNotMatch(eventDateLabel(unknown), /17:00/);
  for (const attendanceTiming of [undefined, { kind: 'timed_session' as const, evidence: 'provider_sessions_and_source_text' as const }]) {
    const timed = { ...event, attendanceTiming };
    assert.equal(isEligible(timed, { ...emptyFilters, startTimeFrom: '17:00' }, now), attendanceTiming?.kind === 'timed_session');
    assert.match(eventDateLabel(timed), /17:00/);
  }
});
