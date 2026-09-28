import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import type { Filters } from '../lib/types.ts';
import { buildInputCandidates } from '../lib/input-candidates.ts';
import { emptyIntentState } from '../lib/input-state.ts';

const now = new Date('2026-09-28T09:00:00Z');
const build = (message: string, previous = emptyIntentState()) =>
  buildInputCandidates(message, now, previous);

void test('normalizes localized, shorthand, word, correction and free amounts', () => {
  assert.equal(build('under 1,000 TL').amounts[0].value, 1000);
  assert.equal(build('1.000 TL altı').amounts[0].value, 1000);
  assert.equal(build('toplam 2,5 bin TL').amounts[0].value, 2500);
  assert.equal(build('toplam üç bin iki yüz lira').amounts[0].value, 3200);
  assert.equal(build('up to fifteen hundred lira').amounts[0].value, 1500);
  assert.equal(build('yalnızca ücretsiz etkinlikler').amounts[0].value, 0);
  const previous = emptyIntentState({
    ...emptyIntentState().filters,
    maxPrice: 750,
  });
  assert.ok(
    build('750 değil, kişi başı 600', previous).amounts.some(
      ({ value }) => value === 600,
    ),
  );
});

void test('offers absolute, summed and relative final party sizes and child ages', () => {
  assert.ok(build('iki kişiyiz').parties.some(({ value }) => value === 2));
  assert.ok(build('two adults').parties.some(({ value }) => value === 2));
  assert.ok(
    build('2 yetişkin 1 çocuk').parties.some(({ value }) => value === 3),
  );
  assert.ok(build('sevgilimle').parties.some(({ value }) => value === 2));
  assert.ok(build("we're three").parties.some(({ value }) => value === 3));
  const previous = emptyIntentState({
    ...emptyIntentState().filters,
    partySize: 2,
  });
  assert.ok(
    build('Bir kişi daha katıldı', previous).parties.some(
      ({ value }) => value === 3,
    ),
  );
  assert.deepEqual(
    build('5 yaşındaki çocuğum').ages.map(({ value }) => value),
    [5],
  );
});

void test('normalizes relative dates, same weekday, ranges, leap dates and numeric ambiguity', () => {
  assert.deepEqual(build('bugün').dates[0].value, {
    dateFrom: '2026-09-28',
    dateTo: '2026-09-28',
  });
  assert.ok(
    build('bu hafta sonu').dates.some(
      ({ value }) =>
        value.dateFrom === '2026-10-03' && value.dateTo === '2026-10-04',
    ),
  );
  assert.ok(
    build('next week').dates.some(
      ({ value }) =>
        value.dateFrom === '2026-10-05' && value.dateTo === '2026-10-11',
    ),
  );
  assert.ok(
    build('Monday').dates.some(({ value }) => value.dateFrom === '2026-09-28'),
  );
  assert.ok(
    build('from Wednesday through Friday').dates.some(
      ({ value }) =>
        value.dateFrom === '2026-09-30' && value.dateTo === '2026-10-02',
    ),
  );
  assert.ok(
    build('1 Ekim ile 5 Ekim arası').dates.some(
      ({ value }) =>
        value.dateFrom === '2026-10-01' && value.dateTo === '2026-10-05',
    ),
  );
  assert.ok(
    build('29.02.2028').dates.some(
      ({ value }) => value.dateFrom === '2028-02-29',
    ),
  );
  assert.equal(build('29.02.2027').overflow, true);
  assert.equal(
    build('03/04/2027').dates.filter(({ text }) => text === '03/04/2027')
      .length,
    2,
  );
});

void test('extracts English-prefix, Turkish-suffix, exact and evening time policies', () => {
  assert.deepEqual(build('after 20:00').times[0].value, {
    startTimeFrom: '20:00',
    startTimeFromExclusive: true,
  });
  assert.deepEqual(build("20:00'den sonra").times[0].value, {
    startTimeFrom: '20:00',
    startTimeFromExclusive: true,
  });
  assert.deepEqual(build('starting by 3pm').times[0].value, {
    startTimeTo: '15:00',
    startTimeToExclusive: false,
  });
  assert.deepEqual(build('saat 20:00').times[0].value, {
    startTimeFrom: '20:00',
    startTimeTo: '20:00',
    startTimeFromExclusive: false,
    startTimeToExclusive: false,
  });
  assert.ok(
    build('18:30-22:00').times.some(
      ({ value }) =>
        value.startTimeFrom === '18:30' && value.startTimeTo === '22:00',
    ),
  );
  assert.ok(
    build('bu akşam').times.some(
      ({ value }) => value.startTimeFrom === '18:00',
    ),
  );
});

void test('covers the Istanbul district grammar and preserves quoted interests', () => {
  assert.deepEqual(
    build('Arnavutköy veya Küçükçekmece').districts.map(({ value }) => value),
    ['Arnavutköy', 'Küçükçekmece'],
  );
  assert.ok(
    build('Adı "Konser Değil" olan oyunu bul').interests.some(
      ({ value }) => value === 'Konser Değil',
    ),
  );
});

void test('bounds every pool and marks candidate overflow or unsupported numeric facts', () => {
  const many = Array.from({ length: 20 }, (_, index) => `${index + 1} TL`).join(
    ', ',
  );
  const pool = build(many);
  assert.equal(pool.amounts.length, 16);
  assert.equal(pool.overflow, true);
  assert.equal(build('150000 TL').amounts.length, 0);
  assert.equal(build('150000 TL').overflow, true);
});

void test('localized numbers are consumed whole and malformed numeric tokens cannot become cheap suffixes', () => {
  for (const [message, value] of [
    ['1.000,50 TL', 1000.5],
    ['1,000.50 TL', 1000.5],
    ['2,5k TL', 2500],
    ['max 1k per person', 1000],
    ['\u20ba 750', 750],
    ['bin lira', 1000],
    ['twenty five lira', 25],
    ['yirmi be\u015f lira', 25],
  ] as const) {
    const pool = build(message);
    assert.deepEqual(
      pool.amounts.map(({ value }) => value),
      [value],
      message,
    );
    assert.equal(pool.overflow, false, message);
    assert.ok(message.includes(pool.amounts[0].text), message);
  }
  for (const message of [
    '1.00.50 TL',
    '1,00,000 TL',
    '1.2.3 TL',
    'one two lira',
    'zero hundred lira',
  ]) {
    const pool = build(message);
    assert.deepEqual(pool.amounts, [], message);
    assert.equal(pool.overflow, true, message);
  }
  assert.deepEqual(build('abc100 TL').amounts, []);
  assert.deepEqual(build('-100 TL').amounts, []);
});

void test('normalized Unicode scanning preserves original source spelling and decomposed offsets', () => {
  const names = [
    'Adalar',
    'Arnavutk\u00f6y',
    'Ata\u015fehir',
    'Avc\u0131lar',
    'Ba\u011fc\u0131lar',
    'Bah\u00e7elievler',
    'Bak\u0131rk\u00f6y',
    'Ba\u015fak\u015fehir',
    'Bayrampa\u015fa',
    'Be\u015fikta\u015f',
    'Beykoz',
    'Beylikd\u00fcz\u00fc',
    'Beyo\u011flu',
    'B\u00fcy\u00fck\u00e7ekmece',
    '\u00c7atalca',
    '\u00c7ekmek\u00f6y',
    'Esenler',
    'Esenyurt',
    'Ey\u00fcpsultan',
    'Fatih',
    'Gaziosmanpa\u015fa',
    'G\u00fcng\u00f6ren',
    'Kad\u0131k\u00f6y',
    'Ka\u011f\u0131thane',
    'Kartal',
    'K\u00fc\u00e7\u00fck\u00e7ekmece',
    'Maltepe',
    'Pendik',
    'Sancaktepe',
    'Sar\u0131yer',
    'Silivri',
    'Sultanbeyli',
    'Sultangazi',
    '\u015eile',
    '\u015ei\u015fli',
    'Tuzla',
    '\u00dcmraniye',
    '\u00dcsk\u00fcdar',
    'Zeytinburnu',
  ];
  for (const name of names) {
    for (const spelling of [
      name,
      name.toLocaleUpperCase('tr-TR'),
      name.normalize('NFD'),
    ]) {
      const original = `${spelling}\u2019de`;
      const pool = build(`\ud83c\udfb5 ${original} konser`);
      assert.deepEqual(
        pool.districts.map(({ value }) => value),
        [name],
        original,
      );
      assert.equal(pool.districts[0].text, original);
    }
  }
  assert.deepEqual(build('Kartallar ve \u015eileli oyuncular').districts, []);
  assert.equal(build('\u00fc\u00e7 ya\u015f\u0131nda').ages[0].value, 3);
  assert.equal(build('3 \u015eubat').dates[0].text, '3 \u015eubat');
  assert.equal(build('3 May\u0131s').dates[0].text, '3 May\u0131s');
});

void test('ranges, tonight, weekday qualification and Sunday use Istanbul calendar policy', () => {
  const range = build('\u00c7ar\u015fambadan gelecek pazartesiye kadar');
  assert.equal(range.overflow, false);
  assert.ok(
    range.dates.some(
      ({ value }) =>
        value.dateFrom === '2026-09-30' && value.dateTo === '2026-10-05',
    ),
  );
  assert.ok(
    build('2026-10-01 to 2026-10-03').dates.some(
      ({ value }) =>
        value.dateFrom === '2026-10-01' && value.dateTo === '2026-10-03',
    ),
  );
  assert.deepEqual(
    build('11 Ekim Pazar').dates.map(({ value }) => value),
    [{ dateFrom: '2026-10-11', dateTo: '2026-10-11' }],
  );
  assert.equal(build('11 Ekim Pazartesi').overflow, true);
  for (const message of ['tonight', 'bu gece', 'bu ak\u015fam'])
    assert.equal(build(message).dates[0].value.dateFrom, '2026-09-28');
  const sunday = buildInputCandidates(
    'this weekend',
    new Date('2026-10-04T09:00:00Z'),
    emptyIntentState(),
  );
  assert.deepEqual(sunday.dates[0].value, {
    dateFrom: '2026-10-04',
    dateTo: '2026-10-04',
  });
  const boundary = buildInputCandidates(
    'today',
    new Date('2026-09-28T21:30:00Z'),
    emptyIntentState(),
  );
  assert.equal(boundary.dates[0].value.dateFrom, '2026-09-29');
  assert.equal(build('next Monday').dates[0].value.dateFrom, '2026-10-05');
  assert.equal(build('gelecek pazar').dates[0].value.dateFrom, '2026-10-04');
});

void test('time candidates preserve exactness and strictness and reject invalid or ambiguous clocks', () => {
  assert.deepEqual(build('18:30 sonras\u0131').times[0].value, {
    startTimeFrom: '18:30',
    startTimeFromExclusive: true,
  });
  assert.deepEqual(build('20:00 \u00f6ncesi').times[0].value, {
    startTimeTo: '20:00',
    startTimeToExclusive: true,
  });
  for (const message of ['at 8pm', 'saat 20:00', '20:00']) {
    assert.deepEqual(
      build(message).times[0].value,
      {
        startTimeFrom: '20:00',
        startTimeTo: '20:00',
        startTimeFromExclusive: false,
        startTimeToExclusive: false,
      },
      message,
    );
  }
  for (const message of [
    'before 13pm',
    'after 0am',
    'after 8',
    "8'den sonra",
    '12:99',
    '25:00',
    '12:5',
  ]) {
    const pool = build(message);
    assert.deepEqual(pool.times, [], message);
    assert.equal(pool.overflow, true, message);
  }
  assert.equal(build('at 12am').times[0].value.startTimeFrom, '00:00');
  assert.equal(build('at 12pm').times[0].value.startTimeFrom, '12:00');
  assert.equal(build('22:00-18:00').overflow, true);
});

void test('group totals cannot sum corrections or overlapping counts', () => {
  for (const message of [
    '2 ki\u015fi de\u011fil 3 ki\u015fi',
    '2 people or 3 people',
    '3 people, 2 adults',
    '2 adults but no 1 child',
  ])
    assert.ok(
      !build(message).parties.some(({ value }) => value === 5),
      message,
    );
  assert.deepEqual(
    build('2 adults and 1 child').parties.map(({ value }) => value),
    [2, 1, 3],
  );
  assert.ok(
    build('2 adults and 1 kid').parties.some(({ value }) => value === 3),
  );
  assert.ok(
    build('2 yeti\u015fkin 1 \u00e7ocuk').parties.some(
      ({ value }) => value === 3,
    ),
  );
});

void test('composed number words and paired clock directions retain scalar and interval meaning', () => {
  assert.equal(build('on iki ki\u015fi').parties[0].value, 12);
  assert.equal(build('yirmi be\u015f ki\u015fi').parties[0].value, 25);
  assert.equal(build('on iki ya\u015f\u0131nda').ages[0].value, 12);
  assert.equal(build('one two people').overflow, true);
  assert.deepEqual(build('step-free access').amounts, []);
  assert.ok(
    build('after 20:00 and before 22:00').times.some(
      ({ value }) =>
        value.startTimeFrom === '20:00' &&
        value.startTimeFromExclusive &&
        value.startTimeTo === '22:00' &&
        value.startTimeToExclusive,
    ),
  );
  assert.equal(build('after 20:00 and before 20:00').overflow, true);
  assert.ok(
    build('next week Friday').dates.some(
      ({ value }) =>
        value.dateFrom === '2026-10-09' && value.dateTo === '2026-10-09',
    ),
  );
  assert.ok(
    !build('next week Friday').dates.some(
      ({ value }) => value.dateFrom === '2026-10-02',
    ),
  );
});

void test('independent accepted benchmark requests have their expected scalar and interval candidates', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../fixtures/input-intent-v1.json', import.meta.url),
      'utf8',
    ),
  ) as {
    cases: Array<{
      id: string;
      parent?: string;
      message: string;
      expected: { status: string; filters?: Partial<Filters> };
    }>;
  };
  const cases = fixture.cases.filter(
    (item) => !item.parent && item.expected.status === 'ok',
  );
  assert.ok(cases.length >= 15);
  for (const item of cases) {
    const pool = build(item.message),
      expected = item.expected.filters ?? {};
    assert.equal(pool.overflow, false, item.id);
    if (expected.dateFrom)
      assert.ok(
        pool.dates.some(
          ({ value }) =>
            value.dateFrom === expected.dateFrom &&
            value.dateTo === expected.dateTo,
        ),
        `${item.id}: date interval`,
      );
    if (expected.district)
      assert.ok(
        pool.districts.some(({ value }) => value === expected.district),
        `${item.id}: district`,
      );
    if (expected.partySize)
      assert.ok(
        pool.parties.some(({ value }) => value === expected.partySize),
        `${item.id}: party size`,
      );
    if (expected.maxPrice != null)
      assert.ok(
        pool.amounts.some(({ value }) => value === expected.maxPrice),
        `${item.id}: per-person amount`,
      );
    if (expected.totalBudget != null)
      assert.ok(
        pool.amounts.some(({ value }) => value === expected.totalBudget),
        `${item.id}: total amount`,
      );
    if (expected.startTimeFrom)
      assert.ok(
        pool.times.some(
          ({ value }) =>
            value.startTimeFrom === expected.startTimeFrom &&
            (!expected.startTimeFromExclusive || value.startTimeFromExclusive),
        ),
        `${item.id}: lower clock bound`,
      );
    if (expected.startTimeTo)
      assert.ok(
        pool.times.some(
          ({ value }) =>
            value.startTimeTo === expected.startTimeTo &&
            (!expected.startTimeToExclusive || value.startTimeToExclusive),
        ),
        `${item.id}: upper clock bound`,
      );
  }
});

void test('next-week Turkish weekdays and English clock interval modifiers preserve meaning', () => {
  const friday = build('haftaya cuma');
  assert.equal(friday.overflow, false);
  assert.ok(
    friday.dates.some(
      ({ text, value }) =>
        text === 'haftaya cuma' &&
        value.dateFrom === '2026-10-09' &&
        value.dateTo === '2026-10-09',
    ),
  );
  assert.ok(!friday.dates.some(({ value }) => value.dateFrom === '2026-10-02'));
  for (const message of ['between 8pm and 10pm', 'between8pm and10pm']) {
    const pool = build(message);
    assert.equal(pool.overflow, false, message);
    assert.ok(
      pool.times.some(
        ({ text, value }) =>
          text === message &&
          value.startTimeFrom === '20:00' &&
          value.startTimeTo === '22:00' &&
          value.startTimeFromExclusive === false &&
          value.startTimeToExclusive === false,
      ),
      message,
    );
  }
  assert.deepEqual(build('no later than 8pm').times[0].value, {
    startTimeTo: '20:00',
    startTimeToExclusive: false,
  });
  assert.deepEqual(build('no earlier than 8pm').times[0].value, {
    startTimeFrom: '20:00',
    startTimeFromExclusive: false,
  });
  assert.equal(build('between 10pm and 8pm').overflow, true);
  const pending = 'between 8pm and 10pm\nCorrection: no later than 9pm';
  const pool = build(pending);
  assert.ok(
    pool.times.some(
      ({ text, value }) =>
        text === 'no later than 9pm' &&
        value.startTimeTo === '21:00' &&
        value.startTimeToExclusive === false,
    ),
  );
  assert.ok(!pool.times.some(({ text }) => text.includes('Correction')));
  for (const message of ['tonight', 'bu gece canl\u0131 m\u00fczik']) {
    const pool = build(message);
    assert.equal(pool.dates[0].value.dateFrom, '2026-09-28');
    assert.ok(pool.times.some(({ value }) => value.startTimeFrom === '18:00'));
  }
  assert.ok(
    build('bu gece canl\u0131 m\u00fczik').interests.some(
      ({ value }) => value === 'canl\u0131 m\u00fczik',
    ),
  );
});

void test('extracts partner variants and optional workshop without treating soonest as an interest', () => {
  for (const phrase of ['kız arkadaşımla', 'erkek arkadaşımla', 'with my girlfriend'])
    assert.ok(build(phrase).parties.some(({ value }) => value === 2), phrase);
  const pool = build('atölye olabilir, en yakın tarih');
  assert.ok(pool.interests.some(({ value }) => value === 'atölye'));
  assert.ok(!pool.interests.some(({ value }) => /yakın tarih/i.test(value)));
  assert.deepEqual(pool.dates, []);
});
