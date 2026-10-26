import assert from 'node:assert/strict';
import test from 'node:test';
import { conditionSignatures } from '../evals/plan-eval.ts';
import { validateSearchPlan } from '../lib/plan-evidence.ts';
import type { ParserInput } from '../parser/contract.ts';
import type { Answer, JevResponse } from '../parser/parse-core.ts';
import {
  buildCalendar,
  numberOccurrences,
  periodRange,
  buildReaderRequest,
  composeReader,
  type ReaderRequest,
} from '../parser/reader-v3.ts';

function makeInput(utterance: string, referenceDate = '2026-10-26'): ParserInput {
  return {
    utterance,
    language: 'tr',
    referenceDate,
    timezone: 'Europe/Istanbul',
    previousState: null,
  };
}

type AnswerOverride =
  | string
  | number
  | { choice?: string; probabilities: Record<string, number>; confidence?: number };

/**
 * Build a valid JevResponse for `built.questions`, defaulting every choice to
 * 'none'/'no'/'events'/'unstated'/'other'/'00' with probability 0.95 and every
 * noul to 0.05.
 */
function syntheticResponse(
  built: ReaderRequest,
  overrides: Record<string, AnswerOverride> = {},
): JevResponse {
  const answers: Record<string, Answer> = {};

  for (const [id, q] of Object.entries(built.questions)) {
    const ov = overrides[id];
    if (q.type === 'noul') {
      const val = typeof ov === 'number' ? ov : 0.05;
      answers[id] = { type: 'noul', noul: val };
      continue;
    }

    const keys = Object.keys(q.criteria);
    const defaultKey =
      keys.find((k) =>
        ['none', 'no', 'events', 'unstated', 'other', '00'].includes(k),
      ) ?? keys[0];

    if (typeof ov === 'object' && ov !== null) {
      const probs: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
      for (const [k, p] of Object.entries(ov.probabilities)) {
        probs[k] = p;
      }
      const sorted = Object.entries(probs).sort((a, b) => b[1] - a[1]);
      const chosen = ov.choice ?? sorted[0][0];
      const confidence = ov.confidence ?? probs[chosen] ?? 0.5;
      answers[id] = { type: 'choice', choice: chosen, probabilities: probs, confidence };
    } else {
      const chosen = typeof ov === 'string' ? ov : defaultKey;
      const probs: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]));
      probs[chosen] = 0.95;
      const fallback = keys.find((k) => k !== chosen);
      if (fallback) probs[fallback] = 0.05;
      answers[id] = { type: 'choice', choice: chosen, probabilities: probs, confidence: 0.95 };
    }
  }

  return {
    model: 'jev-1.13.0',
    answers,
    usage: { input_tokens: 1200, output_tokens: 150 },
  };
}

void test('calendar labels from reference 2026-10-26 (Monday) match expected relations', () => {
  const cal = buildCalendar('2026-10-26', 120);
  assert.equal(Object.keys(cal).length, 120);

  // d0 is 2026-10-26 Monday (today).
  assert.match(cal.d0, /^2026-10-26 Pazartesi\/Monday — bugün\/today/);

  // 2026-10-31 is Saturday (d5): weekend day of this week and last Saturday of October.
  assert.match(cal.d5, /^2026-10-31 Cumartesi\/Saturday/);
  assert.match(cal.d5, /bu hafta\/this week/);
  assert.match(cal.d5, /hafta sonu\/weekend/);
  assert.match(cal.d5, /ayın son cumartesi/);

  // "Kasım'ın 1. cuması" is on 2026-11-06 (d11).
  assert.match(cal.d11, /^2026-11-06 Cuma\/Friday/);
  assert.match(cal.d11, /11 gün sonra/);
  assert.match(cal.d11, /gelecek haftanın \(next week's\) cuması/);
  assert.match(cal.d11, /Kasım'ın 1\. cuması/);

  // 2026-11-08 (d13) is labelled 2 weeks ahead Sunday ("2 hafta sonra").
  assert.match(cal.d13, /^2026-11-08 Pazar\/Sunday/);
  assert.match(cal.d13, /2 hafta sonra/);
});

void test('composition (a): "except pop, rap, or electronic" yields three separate not(topic) atoms', () => {
  const input = makeInput('Live music in Beyoğlu this week, anything except pop, rap, or electronic');
  const built = buildReaderRequest(input);
  const res = composeReader(
    input,
    built,
    syntheticResponse(built, {
      date_shape: 'range',
      range_start: 'd0',
      range_end: 'd6',
      place: 'in',
      district: 'Beyoğlu',
      category_concert: 'want',
      topic_pop: 'exclude',
      topic_rap: 'exclude',
      topic_electronic: 'exclude',
    }),
  );

  assert.equal(res.status, 'accepted');
  validateSearchPlan(res.resultingPlan);
  const sigs = conditionSignatures(res.resultingPlan.hard);
  assert.ok(sigs.has('!{"kind":"topic","value":"pop"}'));
  assert.ok(sigs.has('!{"kind":"topic","value":"rap"}'));
  assert.ok(sigs.has('!{"kind":"topic","value":"electronic"}'));
  assert.equal([...sigs].some((s) => s.startsWith('!any(')), false);
});

void test('composition (b): attendee ages 3 and 11 are both kept', () => {
  const input = makeInput(
    '3-year-old toddler and 11-year-old kid, looking for a Sunday show where both are allowed and 3 tickets cost at most 900 TL total',
  );
  const built = buildReaderRequest(input);
  assert.deepEqual(
    built.numbers.map((n) => n.value),
    [3, 11, 3, 900],
  );
  const res = composeReader(
    input,
    built,
    syntheticResponse(built, {
      date_shape: 'single',
      day_single: 'd6',
      category_show: 'want',
      companion_children: 'yes',
      number_role_0: 'attendee_age',
      number_role_1: 'attendee_age',
      number_role_2: 'number_of_attendees',
      number_role_3: 'price_amount',
      budget: 'max',
      budget_basis: 'group_total',
    }),
  );

  assert.equal(res.status, 'accepted');
  validateSearchPlan(res.resultingPlan);
  const sigs = conditionSignatures(res.resultingPlan.hard);
  assert.ok(sigs.has('{"kind":"age","years":3}'));
  assert.ok(sigs.has('{"kind":"age","years":11}'));
  assert.ok(sigs.has('{"count":3,"kind":"party"}'));
  assert.ok(sigs.has('{"amount":900,"basis":"group_total","comparison":"lte","currency":"TRY","kind":"budget"}'));
});

void test('composition (c): date_shape alternatives d2/d3 yields any of two single-day atoms', () => {
  const input = makeInput('Classical music concert in Ataşehir this Wednesday or Thursday night');
  const built = buildReaderRequest(input);
  const res = composeReader(
    input,
    built,
    syntheticResponse(built, {
      date_shape: 'alternatives',
      alternative_first: 'd2',
      alternative_second: 'd3',
      time: 'evening',
      place: 'in',
      district: 'Ataşehir',
      category_concert: 'want',
      topic_classical: 'want',
    }),
  );

  assert.equal(res.status, 'accepted');
  validateSearchPlan(res.resultingPlan);
  const sigs = conditionSignatures(res.resultingPlan.hard);
  assert.ok(
    sigs.has(
      'any({"from":"2026-10-28","kind":"date","to":"2026-10-28"}|{"from":"2026-10-29","kind":"date","to":"2026-10-29"})',
    ),
  );
});

void test('composition (d): a named genre and checkable format are hard; vibes, moods and companions rank', () => {
  const input = makeInput('Bu akşam sakin bir caz konseri, açık havada olsun, sevgilimle, rock havası da olabilir');
  const built = buildReaderRequest(input);
  const res = composeReader(
    input,
    built,
    syntheticResponse(built, {
      date_shape: 'single',
      day_single: 'd0',
      time: 'evening',
      topic_jazz: 'want',
      topic_rock: 'optional',
      mood_calm: 'want',
      experience_outdoors: 'want',
      experience_romantic: 'want',
      companion_partner: 'yes',
    }),
  );

  assert.equal(res.status, 'accepted');
  validateSearchPlan(res.resultingPlan);
  const hardSigs = conditionSignatures(res.resultingPlan.hard);
  assert.ok(hardSigs.has('{"kind":"topic","value":"jazz"}'));
  assert.ok(hardSigs.has('{"kind":"experience","value":"outdoors"}'));
  assert.equal(hardSigs.size, 4); // date, time, jazz, outdoors
  const prefSigs = new Set(
    res.resultingPlan.preferences.flatMap((p) => [...conditionSignatures(p)]),
  );
  assert.ok(prefSigs.has('{"kind":"topic","value":"rock"}'));
  assert.ok(prefSigs.has('{"kind":"mood","value":"calm"}'));
  assert.ok(prefSigs.has('{"kind":"experience","value":"romantic"}'));
  assert.ok(prefSigs.has('{"kind":"companion","value":"partner"}'));
});

void test('composition (e): confidence margin downgrades low-margin category want to preference and drops low-margin exclude', () => {
  const input = makeInput('Bu hafta sonu konser olabilir ama stand-up istemiyorum');
  const built = buildReaderRequest(input);
  const res = composeReader(
    input,
    built,
    syntheticResponse(built, {
      date_shape: 'range',
      range_start: 'd5',
      range_end: 'd6',
      // want 0.45 vs no 0.40 -> fails margin -> becomes optional (preference)
      category_concert: {
        choice: 'want',
        probabilities: { want: 0.45, no: 0.4, optional: 0.1, exclude: 0.05 },
      },
      // exclude 0.48 vs no 0.42 -> fails margin -> dropped
      category_theatre: {
        choice: 'exclude',
        probabilities: { exclude: 0.48, no: 0.42, want: 0.05, optional: 0.05 },
      },
      // confident exclude -> kept in hard
      category_standup: {
        choice: 'exclude',
        probabilities: { exclude: 0.9, no: 0.05, want: 0.03, optional: 0.02 },
      },
    }),
  );

  assert.equal(res.status, 'accepted');
  const hardSigs = conditionSignatures(res.resultingPlan.hard);
  assert.ok(hardSigs.has('!{"kind":"category","value":"standup"}'));
  assert.equal(hardSigs.has('{"kind":"category","value":"concert"}'), false);
  assert.equal(hardSigs.has('!{"kind":"category","value":"theatre"}'), false);

  const prefSigs = new Set(
    res.resultingPlan.preferences.flatMap((p) => [...conditionSignatures(p)]),
  );
  assert.ok(prefSigs.has('{"kind":"category","value":"concert"}'));
});

void test('composition (f): scope other_city 0.8 returns unsupported outside_location', () => {
  const input = makeInput('Can you find a bookable theatre show in Ankara this Saturday?');
  const built = buildReaderRequest(input);
  const res = composeReader(
    input,
    built,
    syntheticResponse(built, {
      scope: {
        choice: 'other_city',
        probabilities: { other_city: 0.8, events: 0.15, out_of_product: 0.05 },
      },
    }),
  );

  assert.equal(res.status, 'unsupported');
  assert.equal(res.reason, 'unsupported outside_location');
});

void test('composition (g): group total budget with party 3 yields group_total + party', () => {
  const input = makeInput('30 Ekim Cuma Bakırköy çocuk etkinliği, 3 kişiyiz ve toplam bütçemiz 1500 TL');
  const built = buildReaderRequest(input);
  // numbers: 30 (calendar_day), 3 (number_of_attendees), 1500 (price_amount)
  const res = composeReader(
    input,
    built,
    syntheticResponse(built, {
      date_shape: 'single',
      day_single: 'd4',
      place: 'in',
      district: 'Bakırköy',
      companion_children: 'yes',
      number_role_0: 'calendar_day',
      number_role_1: 'number_of_attendees',
      number_role_2: 'price_amount',
      budget: 'max',
      budget_basis: 'group_total',
    }),
  );

  assert.equal(res.status, 'accepted');
  validateSearchPlan(res.resultingPlan);
  const sigs = conditionSignatures(res.resultingPlan.hard);
  assert.ok(sigs.has('{"count":3,"kind":"party"}'));
  assert.ok(sigs.has('{"amount":1500,"basis":"group_total","comparison":"lte","currency":"TRY","kind":"budget"}'));
  assert.ok(sigs.has('{"kind":"companion","value":"children"}'));
});

void test('composition (h): unreadable date yields unsupported "unreadable date" while other fields are fine', () => {
  const input = makeInput('30 Şubat Kadıköy konser');
  const built = buildReaderRequest(input);
  const res = composeReader(
    input,
    built,
    syntheticResponse(built, {
      date_shape: 'unreadable',
      place: 'in',
      district: 'Kadıköy',
      category_concert: 'want',
    }),
  );

  assert.equal(res.status, 'unsupported');
  assert.equal(res.reason, 'unreadable date');
});

void test('request size stays under MAX_REQUEST_BYTES (150,000) for a 1200-char message with 24 numbers', () => {
  const numbersPart = Array.from({ length: 24 }, (_, i) => `${i + 1}0`).join(' ');
  const padding = 'istanbul konser tiyatro sergi '.repeat(40);
  const message = `${numbersPart} ${padding}`.slice(0, 1200);
  assert.equal(message.length, 1200);

  const input = makeInput(message);
  const built = buildReaderRequest(input);
  assert.equal(built.numbers.length, 24);

  const serialized = JSON.stringify({
    model: 'jev-1.13.0',
    state: built.state,
    questions: built.questions,
  });
  const byteLength = new TextEncoder().encode(serialized).byteLength;
  const questionCount = Object.keys(built.questions).length;

  const typicalInput = makeInput('Bu hafta sonu Kadıköy tarafında 2 kişi toplam 1200 TL altı tiyatro veya konser');
  const typicalBuilt = buildReaderRequest(typicalInput);
  const typicalBytes = new TextEncoder().encode(
    JSON.stringify({
      model: 'jev-1.13.0',
      state: typicalBuilt.state,
      questions: typicalBuilt.questions,
    }),
  ).byteLength;
  const typicalQuestions = Object.keys(typicalBuilt.questions).length;

  console.log(
    `[reader-v3] typical: ${typicalQuestions} questions, ${typicalBytes} bytes; max (1200 chars, 24 numbers): ${questionCount} questions, ${byteLength} bytes`,
  );
  assert.ok(byteLength < 150_000, `Expected < 150,000 bytes, got ${byteLength}`);
});

void test('month parts and seasons resolve in code and never start before today', () => {
  assert.deepEqual(periodRange('2026-10-04', 'October', 'end'), { from: '2026-10-21', to: '2026-10-31' });
  assert.deepEqual(periodRange('2026-10-26', 'December', 'start'), { from: '2026-12-01', to: '2026-12-10' });
  assert.deepEqual(periodRange('2026-10-26', 'autumn', 'whole'), { from: '2026-10-26', to: '2026-11-30' });
  assert.deepEqual(periodRange('2026-10-26', 'winter', 'whole'), { from: '2026-12-01', to: '2027-02-28' });
  assert.deepEqual(periodRange('2026-02-10', 'winter', 'whole'), { from: '2026-02-10', to: '2026-02-28' });
  assert.equal(periodRange('2026-10-26', 'Smarch', 'whole'), null);
});

void test('every number occurrence is a candidate with its nearby words', () => {
  const values = (text: string) => numberOccurrences(text).map((n) => [n.text, n.value]);
  assert.deepEqual(values('3-year-old and 11-year-old, 3 tickets at most 900 TL'), [['3', 3], ['11', 11], ['3', 3], ['900', 900]]);
  // "altı" is both "six" and "under": it stays a candidate for Jev to judge in context.
  assert.deepEqual(values('21 yaş altı, kardeşim 16 yaşında'), [['21', 21], ['altı', 6], ['16', 16]]);
  // Digits inside a longer number are not separate candidates.
  assert.deepEqual(values('160 TL'), [['160', 160]]);
  assert.ok(numberOccurrences('kardeşim 16 yaşında')[0].nearby.includes('kardeşim 16 yaşında'));
});
