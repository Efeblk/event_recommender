import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputCandidates } from '../lib/input-candidates.ts';
import { emptyIntentState } from '../lib/input-state.ts';

const now = new Date('2026-09-28T09:00:00Z');
const interests = (message: string) =>
  buildInputCandidates(message, now, emptyIntentState()).interests;

void test('separates a required subject from an optional workshop and preserves role context', () => {
  for (const [message, required] of [
    ['Fotoğrafla ilgili bir etkinlik arıyorum; workshop olsa güzel olur ama şart değil.', 'Fotoğraf'],
    ['I want a photography-related event. A workshop would be nice, but it is not required.', 'photography-related'],
  ] as const) {
    const candidates = interests(message);
    const main = candidates.find(({ value }) => value === required);
    const workshop = candidates.find(({ value }) => value.toLocaleLowerCase('tr-TR') === 'workshop');
    assert.ok(main, message);
    assert.ok(workshop, message);
    assert.match(workshop.scope?.context.text ?? '', /(?:şart değil|not required)/iu);
    assert.doesNotMatch(main.scope?.context.text ?? '', /workshop/iu);
  }
});

void test('grounds every subject in exact UTF-16 input coordinates', () => {
  const message = '😀 İ\u0307stanbul’da fotoğraf veya seramik olsun; workshop olsa iyi olur ama şart değil.';
  for (const candidate of interests(message)) {
    assert.equal(candidate.scope?.coordinateSpace, 'input');
    assert.equal(candidate.sourceSpans?.length, 1);
    const [{ start, end }] = candidate.sourceSpans!;
    assert.equal(message.slice(start, end), candidate.value);
    assert.equal(message.slice(candidate.scope!.context.start, candidate.scope!.context.end), candidate.scope!.context.text);
  }
});

void test('keeps Boolean subjects intact and does not fuse independently scoped wishes', () => {
  assert.ok(interests('fotoğraf veya seramik olsun').some(({ value }) => value === 'fotoğraf veya seramik'));
  const candidates = interests('Photography is mandatory. Workshop would be nice, but it is not required.');
  assert.ok(candidates.some(({ value, scope }) => value === 'Photography' && /mandatory/iu.test(scope?.context.text ?? '')));
  assert.ok(candidates.some(({ value }) => value === 'Workshop'));
});

void test('keeps quoted and masked literal subjects case-sensitive and source-backed', () => {
  for (const message of ['Find "Don\'t Stop. Now"', 'Find LITERALCURRENTTITLEA']) {
    const candidate = interests(message).find(({ value }) => /Don't Stop|LITERALCURRENTTITLEA/u.test(value));
    assert.ok(candidate, message);
    const [{ start, end }] = candidate.sourceSpans!;
    assert.equal(message.slice(start, end), candidate.value);
  }
});

void test('marks overflow before truncating structurally distinct subjects', () => {
  const message = Array.from({ length: 18 }, (_, index) => `topic${index} olsun`).join('; ');
  const pool = buildInputCandidates(message, now, emptyIntentState());
  assert.equal(pool.interests.length, 16);
  assert.equal(pool.overflow, true);
});

void test('splits independently scoped conjunctions while retaining coordinated topical scope', () => {
  const split = interests('Photography is required and a workshop would be nice');
  assert.deepEqual(split.map(({ value }) => value), ['Photography', 'workshop']);
  assert.ok(split.every(({ scope }) => scope?.context.text === 'Photography is required and a workshop would be nice'));
  assert.deepEqual(interests('Photography and pottery would be nice').map(({ value }) => value), ['Photography and pottery']);
  assert.deepEqual(interests('I want photography and a workshop would be nice').map(({ value }) => value), ['photography', 'workshop']);
  assert.deepEqual(interests('Fotoğrafla ilgili bir etkinlik istiyorum ama workshop olsa güzel olur').map(({ value }) => value), ['Fotoğraf', 'workshop']);
});

void test('protects numeric commas and harvests unquoted subjects beside quoted titles', () => {
  const quoted = interests('"A. Title", preferably workshop');
  assert.ok(quoted.some(({ value, scope }) => value === 'A. Title' && scope?.kind === 'quoted'));
  assert.ok(quoted.some(({ value }) => value === 'workshop'));
  const numeric = interests('Budget 1,250.50, preferably intimate');
  assert.ok(numeric.some(({ value }) => value === 'intimate'));
  assert.ok(!numeric.some(({ value }) => value === '250'));
});

void test('isolates opaque literal tokens from title wrappers and optional neighbors', () => {
  for (const message of [
    'Search for a show titled LITERALCURRENTTITLEA',
    'LITERALCURRENTTITLEA yazan bir oyun, preferably romantic',
  ]) {
    const candidates = interests(message);
    assert.equal(candidates.filter(({ value }) => value === 'LITERALCURRENTTITLEA').length, 1);
    assert.ok(!candidates.some(({ value }) => value.includes('LITERALCURRENTTITLEA') && value !== 'LITERALCURRENTTITLEA'));
  }
  assert.ok(interests('Anything else, maybe more intimate?').some(({ value }) => value === 'intimate'));
});

void test('recognizes generic request placeholders and adjacent scoped predicates', () => {
  assert.deepEqual(interests('Fotoğraf ile ilgili bir etkinlik arıyorum').map(({ value }) => value), ['Fotoğraf']);
  assert.deepEqual(interests('Fotoğrafla ilgili bir şey arıyorum').map(({ value }) => value), ['Fotoğraf']);
  const adjacent = interests('Photography is required workshop would be nice');
  assert.deepEqual(adjacent.map(({ value }) => value), ['Photography', 'workshop']);
  const repeatedPredicate = interests('botany-related event I want garden tour would be nice');
  assert.deepEqual(repeatedPredicate.map(({ value }) => value), ['botany-related', 'garden tour']);
  assert.ok(repeatedPredicate.every(({ scope }) => scope?.context.text === 'botany-related event I want garden tour would be nice'));
});

void test('keeps complete mandatory source predicates available for semantic role judgment', () => {
  for (const message of [
    'It must be about geology',
    'The event must concern marine conservation',
  ]) {
    const candidates = interests(message);
    assert.ok(candidates.some(({ value, scope }) => value === message && scope?.kind === 'subject'), message);
    assert.equal(candidates[0]?.scope?.context.text, message);
  }
  const mixed = interests('photography or a concert');
  assert.equal(mixed[0]?.scope?.kind, 'scope-fallback');
});

void test('preserves Turkish instrumental noun heads and atomizes source-owned frames', () => {
  for (const [message, expected] of [
    ['Astronomiyle ilgili bir etkinlik arıyorum', 'Astronomi'],
    ['Mitolojiyle ilgili bir şey arıyorum', 'Mitoloji'],
  ]) assert.deepEqual(interests(message).map(({ value }) => value), [expected]);

  const replacement = interests('Replace photography with ceramics');
  assert.deepEqual(replacement.map(({ value }) => value), ['photography', 'ceramics']);
  assert.equal(replacement[0]?.scope?.ownership?.operation, 'replace');
  assert.deepEqual(replacement[0]?.scope?.ownership?.references, [replacement[1]?.id]);
  assert.equal(replacement[1]?.scope?.ownership?.kind, 'operation-replacement');
  assert.deepEqual(interests('Make botany optional').map(({ value }) => value), ['botany']);
  assert.deepEqual(interests('Remove paleontology').map(({ value }) => value), ['paleontology']);
  assert.deepEqual(interests('photography with ceramics').map(({ value }) => value), ['photography with ceramics']);
  assert.equal(interests('"replace photography with ceramics"')[0]?.scope?.kind, 'quoted');
});

void test('separates typed conjunction arms without splitting ordinary topical coordination', () => {
  assert.deepEqual(interests('Photography and a concert').map(({ value }) => value), ['Photography']);
  assert.deepEqual(interests('Geology and wheelchair access are required').map(({ value }) => value), ['Geology']);
  assert.deepEqual(interests('Photography and ceramics').map(({ value }) => value), ['Photography and ceramics']);
  assert.equal(interests('Photography or a concert')[0]?.scope?.kind, 'scope-fallback');
  assert.deepEqual(interests('It must cover both philosophy and psychology').map(({ value }) => value), ['philosophy', 'psychology']);
  assert.deepEqual(interests('A concert is required'), []);
  const optionalCategory = interests('A concert would be nice');
  assert.deepEqual(optionalCategory.map(({ value }) => value), ['concert']);
  assert.equal(optionalCategory[0]?.scope?.ownership?.kind, 'typed-arm');
  assert.deepEqual(interests('Saturday gidebileceğim konser dışı'), []);
  assert.equal(interests('kişi başı maks olan')[0]?.scope?.kind, 'scope-fallback');
  assert.ok(interests('fotoğrafla ilgili konser dışı etkinlik').some(({ value }) => /fotoğraf/iu.test(value)));
  assert.ok(interests('geology non-concert event').some(({ value }) => /geology/iu.test(value)));
  assert.deepEqual(interests('history of wheelchair access').map(({ value }) => value), ['history of wheelchair access']);
  assert.deepEqual(interests('It must cover both geology and wheelchair access').map(({ value }) => value), ['geology']);
});

void test('extracts count-of-us parties without leaving scalar residue as a topic', () => {
  for (const message of ['Four of us, total 3200 TL, photography required', 'We are four of us, total 3200 TL, photography required']) {
    const pool = buildInputCandidates(message, now, emptyIntentState());
    assert.ok(pool.parties.some(({ value }) => value === 4), message);
    assert.ok(!pool.interests.some(({ value }) => /four|of us|3200/iu.test(value)), message);
    assert.ok(pool.interests.some(({ value }) => value === 'photography'), message);
  }
});

void test('typed source ownership removes only fully accounted grammar residue', () => {
  const root = 'kişi başı maks 2000tl olan kız arkadaşımla gideceğim etkinlik konser veya tiyatro olmasın, workshop olabilir, en yakın tarih';
  assert.deepEqual(interests(root).map(({ value }) => value), ['workshop']);
  assert.deepEqual(interests('pardon toplam değil kişi başı 800 demek istemiştim; bir de kesin Kadıköy olsun, diğerleri aynı'), []);
  assert.deepEqual(interests('bu cumartesi sevgilimle gidebileceğim konser dışı etkinlik'), []);

  assert.ok(interests('kişi başı maks 2000tl fotoğraf etkinliği').some(({ value }) => /fotoğraf/iu.test(value)));
  assert.ok(interests('cumartesi sevgilimle gidebileceğim fotoğraf etkinliği konser dışı').some(({ value }) => /fotoğraf/iu.test(value)));
  assert.ok(interests('pardon toplam değil kişi başı 800 demek istemiştim seramik için').some(({ value }) => /seramik/iu.test(value)));

  const demotion = interests('Tarih şart olmasın, sadece tercih olarak kalsın');
  assert.equal(demotion[0]?.value, 'Tarih');
  assert.equal(demotion[0]?.scope?.ownership?.operation, 'demote');
});
