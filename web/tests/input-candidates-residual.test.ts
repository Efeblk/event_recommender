import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputCandidates } from '../lib/input-candidates.ts';
import { emptyIntentState } from '../lib/input-state.ts';

const now = new Date('2026-09-28T09:00:00Z');
const interests = (message: string) =>
  buildInputCandidates(message, now, emptyIntentState()).interests.map(
    ({ value }) => value,
  );

void test('grounds a residual topic independently from date, district and budget', () => {
  const pool = buildInputCandidates(
    'yarın kadıköyde indie konser bakıyom, kişi başı en fazla 900tl; çok geç başlamasın mümkünse',
    now,
    emptyIntentState(),
  );
  assert.ok(pool.dates.length > 0);
  assert.ok(pool.districts.length > 0);
  assert.ok(pool.amounts.some(({ value }) => value === 900));
  assert.ok(pool.interests.some(({ value }) => value === 'indie'));
  assert.ok(!pool.interests.some(({ value }) => /yarın|kadıköy|900|başlamasın/iu.test(value)));
});

void test('preserves an optional time-context phrase as a selectable interest', () => {
  assert.ok(interests('iş çıkışı indie konser bakıyorum').includes('iş çıkışı indie'));
});

void test('does not weaken negation or unsupported mandatory conditions into interests', () => {
  for (const message of [
    'indie olmasın',
    'tekerlekli sandalye erişimi şart',
    'konser gece bitmesin',
  ])
    assert.ok(
      !interests(message).some((value) =>
        /indie|tekerlekli|erişim|gece|bitmesin/iu.test(value),
      ),
      message,
    );
});

void test('keeps literal quoted titles intact without residual fragments', () => {
  const values = interests('yarın "Konser Değil" adlı oyunu bul');
  assert.ok(values.includes('Konser Değil'));
  assert.ok(!values.some((value) => value !== 'Konser Değil' && /Konser Değil/u.test(value)));
});

void test('grounds a colloquial suffixed per-ticket upper bound', () => {
  const pool = buildInputCandidates(
    'cmt beşiktaşta caz dinlemek istiyoz, elektronik olmasın. 2 kişi, bilet başı 1100e kadar ok',
    now,
    emptyIntentState(),
  );
  assert.ok(pool.amounts.some(({ value }) => value === 1100));
  assert.ok(pool.dates.some(({ value }) => value.dateFrom === '2026-10-03'));
  assert.ok(pool.interests.some(({ value }) => value === 'caz'));
  assert.ok(!pool.interests.some(({ value }) => value === 'ok'));
});

void test('grounds distinctive standalone Turkish weekday abbreviations', () => {
  const expected = new Map([
    ['pzt', '2026-09-28'], ['cmt', '2026-10-03'],
  ]);
  for (const [message, date] of expected)
    assert.ok(buildInputCandidates(message, now, emptyIntentState()).dates.some(
      ({ value }) => value.dateFrom === date && value.dateTo === date,
    ), message);
});

void test('weekday abbreviations require boundaries and stay out of quoted titles', () => {
  assert.equal(buildInputCandidates('Cuma', now, emptyIntentState()).dates.length, 1);
  assert.equal(buildInputCandidates('Cumartesi', now, emptyIntentState()).dates.length, 1);
  assert.equal(buildInputCandidates('cumhuriyet sergisi', now, emptyIntentState()).dates.length, 0);
  const quoted = buildInputCandidates('"Cmt Jazz" konserini bul', now, emptyIntentState());
  assert.equal(quoted.dates.length, 0);
  assert.ok(quoted.interests.some(({ value }) => value === 'Cmt Jazz'));
});

void test('ambiguous short words are not treated as weekdays', () => {
  for (const message of ['per person 900 TL', 'car museum', 'sal atölyesi', 'cumhuriyet sergisi'])
    assert.equal(buildInputCandidates(message, now, emptyIntentState()).dates.length, 0, message);
});
