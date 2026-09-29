import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputCandidates } from '../lib/input-candidates.ts';
import { findInputSpellingCandidates } from '../lib/input-spelling.ts';
import { emptyIntentState } from '../lib/input-state.ts';

const now = new Date('2026-09-28T09:00:00Z');

void test('typo recovery preserves next-week qualification and complete numeric tokens', () => {
  const pool = buildInputCandidates('haftaya cmrtesi', now, emptyIntentState());
  assert.ok(pool.dates.some(({ value }) => value.dateFrom === '2026-10-10' && value.dateTo === '2026-10-10'));
  assert.ok(!pool.dates.some(({ value }) => value.dateFrom === '2026-10-03'));
  for (const message of ['1100 kişiyz', '1.100 kişiyz', '-4 kişiyz']) {
    assert.deepEqual(buildInputCandidates(message, now, emptyIntentState()).parties, [], message);
  }
});

void test('suggests bounded Turkish district and weekday corrections with source spans', () => {
  const message = 'kadkoyde cmrtesi bir şeyler bul';
  const candidates = findInputSpellingCandidates(message);
  assert.ok(candidates.some((item) =>
    item.kind === 'district' && item.normalized === 'kadikoy' &&
    item.text === 'kadkoyde' && message.slice(item.start, item.end) === item.text));
  assert.ok(candidates.some((item) =>
    item.kind === 'weekday' && item.normalized === 'cumartesi' && item.text === 'cmrtesi'));
});

void test('accepts ASCII, diacritics, abbreviations and attached district suffixes', () => {
  for (const message of ['kadikoyde', 'kadıköyde', 'kadkoyde']) {
    const pool = buildInputCandidates(message, now, emptyIntentState());
    assert.ok(pool.districts.some(({ value }) => value === 'Kadıköy'), message);
  }
  for (const message of ['cmt', 'cmrtesi']) {
    const pool = buildInputCandidates(message, now, emptyIntentState());
    assert.ok(pool.dates.some(({ value }) => value.dateFrom === '2026-10-03'), message);
  }
});

void test('builds party candidates from corrected companion words without changing text', () => {
  const pool = buildInputCandidates('3 kisii için konser', now, emptyIntentState());
  assert.ok(pool.spellingCandidates?.some((item) =>
    item.kind === 'companion' && item.normalized === 'kisi' && item.text === 'kisii'));
  assert.ok(pool.parties.some(({ text, value }) => text === '3 kisii' && value === 3));
  const plural = buildInputCandidates('4 kişiyz toplam bütçe 3200tl', now, emptyIntentState());
  assert.ok(plural.spellingCandidates?.some((item) =>
    item.kind === 'companion' && item.normalized === 'kisi' && item.text === 'kişiyz'));
  assert.ok(plural.parties.some(({ text, value }) => text === '4 kişiyz' && value === 4));
  assert.ok(plural.amounts.some(({ value }) => value === 3200));
});

void test('offers narrow category and English weekday spelling suggestions', () => {
  const candidates = findInputSpellingCandidates('konsr saturdy');
  assert.ok(candidates.some(({ text, normalized, kind }) =>
    text === 'konsr' && normalized === 'konser' && kind === 'category'));
  assert.ok(candidates.some(({ text, normalized, kind }) =>
    text === 'saturdy' && normalized === 'saturday' && kind === 'weekday'));
});

void test('does not fuzzy-change numbers, quoted titles, neighborhoods or distant words', () => {
  assert.deepEqual(findInputSpellingCandidates('900 90O'), []);
  assert.equal(findInputSpellingCandidates('"Cmrtesi Kadkoyde" konser').some(
    ({ kind }) => kind === 'weekday' || kind === 'district'), false);
  assert.equal(findInputSpellingCandidates('Taksim').some(
    ({ kind }) => kind === 'district'), false);
  assert.equal(findInputSpellingCandidates('cumhuriyet').some(
    ({ kind }) => kind === 'weekday'), false);
});

void test('keeps ambiguous bounded corrections as separate suggestions', () => {
  const suggestions = findInputSpellingCandidates('sali');
  assert.equal(suggestions.length, 0, 'valid exact parsing does not need a correction');
  const pool = buildInputCandidates('sali', now, emptyIntentState());
  assert.equal(pool.dates.length, 1);
});
