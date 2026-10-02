import assert from 'node:assert/strict';
import test from 'node:test';
import { extract } from '../parser/extract.ts';

const referenceDate = '2026-10-02';
const mentions = (text: string) => extract(text, referenceDate).mentions;

void test('preserves explicit 24-hour clocks in Turkish and English contexts', () => {
  for (const text of ['saat 09:00', '09:00 sonrası', 'at 09:00', 'before 09:00']) {
    const time = mentions(text).find((mention) => mention.kind === 'time');
    assert.equal(time?.kind === 'time' ? time.clock : undefined, '09:00', text);
  }
});

void test('dotted Turkish clocks are clocks, not invalid dates', () => {
  for (const [text, clocks] of [
    ["Saat 20.00'den sonra başlayan konserler.", ['20:00']],
    ["En geç 21.00'de başlayan tiyatro", ['21:00']],
    ['18.00 ile 22.00 arasındaki festivaller', ['18:00', '22:00']],
  ] as const) {
    const result = extract(text, referenceDate);
    assert.deepEqual(result.invalidSpans, [], text);
    assert.deepEqual(result.mentions.flatMap((mention) => mention.kind === 'time' ? [mention.clock] : []), clocks, text);
  }
});

void test('reports impossible explicit calendar dates instead of normalizing them', () => {
  for (const text of ['2027-02-30', '30.02.2027', '30 Şubat 2027', 'February 30, 2027']) {
    const result = extract(text, referenceDate);
    assert.deepEqual(result.mentions.filter((mention) => mention.kind === 'date'), [], text);
    assert.deepEqual(result.invalidSpans, [{ start: 0, end: text.length, text, reason: 'invalid_date' }], text);
  }

  const leapDay = extract('2028-02-29', referenceDate);
  assert.equal(leapDay.invalidSpans.length, 0);
  assert.ok(leapDay.mentions.some((mention) => mention.kind === 'date' && mention.from === '2028-02-29'));
});

void test('classifies Turkish girlfriend and boyfriend inflections as partners', () => {
  for (const text of ['kız arkadaşımla', 'erkek arkadaşımla']) {
    const companions = mentions(text).filter((mention) => mention.kind === 'companion');
    assert.deepEqual(companions.map((mention) => mention.value), ['partner'], text);
  }
});

void test('extracts attendee counts when a relative-change word separates the number and noun', () => {
  const cases = [
    ['One more person is joining', 1],
    ['two fewer people can attend', 2],
    ['three additional attendees are coming', 3],
    ['bir daha kişi katılıyor', 1],
    ['iki eksik kişi olacağız', 2],
    ['bir kişi daha katılıyor', 1],
  ] as const;
  for (const [text, count] of cases) {
    const parties = mentions(text).filter((mention) => mention.kind === 'party');
    assert.deepEqual(parties.map((mention) => mention.count), [count], text);
  }
});

void test('extracts canonical experiences from Turkish and English inverse terms', () => {
  const cases = [
    ['kalabalık', 'uncrowded'], ['aşırı kalabalık', 'uncrowded'], ['crowded', 'uncrowded'], ['overcrowded', 'uncrowded'],
    ['gürültülü', 'quiet'], ['gürültücü', 'quiet'], ['noisy', 'quiet'], ['loudness', 'quiet'],
    ['ayakta', 'seated'], ['ayakta durma', 'seated'], ['standing', 'seated'], ['standing room', 'seated'],
  ] as const;
  for (const [text, value] of cases) {
    assert.ok(mentions(text).some((mention) => mention.kind === 'experience' && mention.value === value), `${text} -> ${value}`);
  }
});

void test('a museum or exhibition visit is that event, not an extra tour type', () => {
  const categories = (text: string) => mentions(text).flatMap((mention) => mention.kind === 'category' ? [mention.value] : []);
  assert.deepEqual(categories('Tarih temalı bir müze gezisi'), ['museum']);
  assert.deepEqual(categories('sergi turu'), ['exhibition']);
  assert.deepEqual(categories('Boğaz turu'), ['tour']);
});
