/**
 * Stateless request reader ("reader v3"). Code proposes concrete candidates
 * (120-day calendar with relations, number candidates, full category and topic
 * items) and Jev selects. Code owns calendar math, place hierarchy, confidence
 * margins, and Phase 1R hard/soft plan composition.
 */
import { placeOf } from '../../contracts/location.ts';
import { validateSearchPlan } from '../lib/plan-evidence.ts';
import type { Atom, BudgetBasis, Category, Comparison, Condition, Operation, Order, ParserInput, Plan } from './contract.ts';
import { CATEGORY_TERMS, DISTRICTS, fold, MOOD_TERMS, NEIGHBORHOODS, TOPIC_TERMS } from './lexicon.ts';
import { numberCandidates, scopedTargetEvidence } from './fields.ts';
import type { ChoiceAnswer, Debug, JevResponse, NoulAnswer, ParseResult, Question } from './parse-core.ts';
import { applyOperations } from './state.ts';

export const ITEM_MIN_PROBABILITY = 0.5;
export const ITEM_MIN_MARGIN = 0.15;
export const SCOPE_DECLINE_THRESHOLD = 0.7;
/** Source text can state these; romantic, quiet, uncrowded and similar qualities only rank. */
const CHECKABLE_EXPERIENCES = new Set(['outdoors', 'seated', 'wheelchair_accessible']);
/** Topics that exist to exclude events; as wishes they overlap a category or companion. */
const NEGATION = /(?:^|[^\p{L}\p{N}])(?:olmasin|olmasın|olmayan|olmayacak|hariç|haric|disinda|dışında|disindaki|dışındaki|disi|dışı|istemiyorum|istemem|degil|değil|yok|haric tut|no|not|without|except|exclude|excluding|anything but|nothing)(?=$|[^\p{L}\p{N}])/u;
const EXCLUSION_ONLY_TOPICS = new Set(['kids', 'comedy', 'nightclub', 'bar', 'tasting', 'food', 'animation', 'horror', 'dancing']);

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const WEEKDAYS_TR = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'] as const;
const WEEKDAYS_TR_POSS = ['pazarı', 'pazartesisi', 'salısı', 'çarşambası', 'perşembesi', 'cuması', 'cumartesi'] as const;
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'] as const;
const MONTHS_TR_GEN = ["Ocak'ın", "Şubat'ın", "Mart'ın", "Nisan'ın", "Mayıs'ın", "Haziran'ın", "Temmuz'un", "Ağustos'un", "Eylül'ün", "Ekim'in", "Kasım'ın", "Aralık'ın"] as const;

const CATEGORIES: Record<Category, string> = {
  concert: 'concerts or live music ("konser", "canlı müzik", "concert", "gig")',
  theatre: 'theatre plays ("tiyatro", "oyun", "theatre", "play")',
  standup: 'stand-up comedy ("stand-up", "standup", "stand up", "komedyen")',
  workshop: 'one-off workshops ("atölye", "workshop")',
  exhibition: 'exhibitions or galleries ("sergi", "galeri", "exhibition")',
  festival: 'festivals ("festival", "fest")',
  sport: 'sports events or matches ("spor", "maç", "match", "game")',
  cinema: 'cinema or film screenings ("sinema", "film", "movie")',
  talk: 'talks, panels, seminars or conferences ("söyleşi", "panel", "seminer", "talk")',
  dance: 'dance or ballet performances ("dans", "bale", "dance", "ballet")',
  show: 'a show or stage performance in general ("gösteri", "a show", "performans", circus, magic, musical, cabaret) — not when the message names a concert, play, stand-up or dance instead',
  course: 'multi-session courses or classes ("kurs", "ders", "course", "class") — a one-off "atölye"/workshop is not a course',
  tour: 'tours or guided walks ("tur", "gezi", "tour", "yürüyüş")',
  museum: 'museums ("müze", "museum")',
};

const EXPERIENCES = {
  quiet: 'the quality "quiet" — a quiet, not noisy environment ("sessiz", "gürültüsüz", "quiet")',
  seated: 'the quality "seated" — seated events, not standing ("oturmalı", "koltuklu", "seated")',
  outdoors: 'the quality "outdoors" — open-air events ("açık hava", "dışarıda", "outdoor")',
  wheelchair_accessible: 'the quality "wheelchair accessible" ("tekerlekli sandalye", "engelli erişimi", "step-free")',
  family_friendly: 'the quality "family-friendly" ("aile dostu", "ailece izlenebilir", "aileye uygun", "family-friendly")',
  uncrowded: 'the quality "uncrowded" — few people, no crowds ("kalabalık olmayan", "tenha", "uncrowded")',
  romantic: 'the quality "romantic" ("romantik", "romantic")',
  beginner_friendly: 'the quality "beginner-friendly" ("yeni başlayanlar", "başlangıç seviyesi", "beginner")',
} as const;

const CONTENT = {
  profanity: 'profanity or swearing (küfür)',
  sexual_content: 'sexual content or nudity',
} as const;

const MOODS = {
  calm: 'a calm, relaxing outing (sakin, dinlendirici, chill)',
  intimate: 'an intimate outing (samimi, cozy)',
} as const;

const COMPANIONS = {
  partner: 'a romantic partner, girlfriend, boyfriend or spouse (sevgili, eş, date)',
  friends: 'friends (arkadaşlar)',
  family: 'family members named as such ("ailemle", "ailece", "annemle", "with my family", "family-friendly"); children alone ("çocuklarla", "kızım", "with kids") are not this',
  children: 'children: the user brings children, or the event is meant for children ("çocuğumla", "oğlum ve kızımla", "çocuk etkinliği", "kids show"). A family outing or "family-friendly" alone is not this',
} as const;

const NUMBER_ROLES = {
  attendee_age: 'The age of a person who will attend ("6 yaşında", "a 9-year-old", "oğlum 14").',
  age_limit: 'An age limit or age range of an event or venue, not the age of a person ("+16", "21 and over", "10 yaş altı", "yetişkinler için 18").',
  number_of_attendees: 'How many people attend or how many tickets ("5 kişiyiz", "üç kişilik", "for six", "2 bilet").',
  price_amount: 'An amount of money for tickets ("350 TL", "2k", "bütçemiz 900", "under 450 lira").',
  year: 'An explicit calendar year ("2027"); not a decade or era ("90\'lar", "the 70s").',
  clock_time: 'Clock hour or minute ("saat 19:00", "after 8 pm").',
  calendar_day: 'Day of the month ("29 Ekim", "October 31").',
  count_of_days_or_weeks: 'Relative day/week count ("2 hafta sonra", "3 gün içinde").',
  other: 'Any other number: decades, ratings, age limits of a venue, sizes, phone numbers.',
} as const;

/** Meteorological seasons as month indexes (0 = January). */
const SEASONS: Record<string, number[]> = { spring: [2, 3, 4], summer: [5, 6, 7], autumn: [8, 9, 10], winter: [11, 0, 1] };
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** First and last day of a named month part or season, the next one that has not ended. */
export function periodRange(referenceDate: string, period: string, part: string): { from: string; to: string } | null {
  const today = new Date(`${referenceDate}T12:00:00Z`);
  const months = SEASONS[period] ?? (MONTHS_EN.indexOf(period as (typeof MONTHS_EN)[number]) >= 0 ? [MONTHS_EN.indexOf(period as (typeof MONTHS_EN)[number])] : null);
  if (!months) return null;
  const span = (year: number) => {
    const first = months[0], last = months[months.length - 1];
    const lastYear = last < first ? year + 1 : year;
    const lastDay = new Date(Date.UTC(lastYear, last + 1, 0, 12)).getUTCDate();
    const [a, b] = !SEASONS[period] && part === 'start' ? [1, 10] : !SEASONS[period] && part === 'middle' ? [11, 20]
      : !SEASONS[period] && part === 'end' ? [21, lastDay] : [1, lastDay];
    return { from: iso(new Date(Date.UTC(year, first, a, 12))), to: iso(new Date(Date.UTC(lastYear, last, b, 12))) };
  };
  let range = span(today.getUTCFullYear() - (SEASONS[period] && months[0] > months[months.length - 1] && today.getUTCMonth() <= months[months.length - 1] ? 1 : 0));
  if (range.to < referenceDate) range = span(today.getUTCFullYear() + 1);
  return { from: range.from < referenceDate ? referenceDate : range.from, to: range.to };
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const choice = (instructions: unknown, criteria: Record<string, string>): Question => {
  const { none, ...rest } = criteria;
  return { type: 'choice', instructions, criteria: none === undefined ? criteria : { none, ...rest } };
};
const noulQ = (instructions: unknown): Question => ({ type: 'noul', instructions });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
const opts = (keys: readonly string[], describe: (key: string) => string = (key) => key) =>
  Object.fromEntries(keys.map((key) => [key, describe(key)]));

const termPattern = (term: string) =>
  new RegExp(`(?:^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\p{L}\\p{N}])`, 'u');
const targetsIn = (text: string, terms: Record<string, string[]>) => {
  const value = fold(text);
  return Object.keys(terms).filter((target) => terms[target].some((term) => termPattern(term).test(value)));
};

/**
 * Build 120 consecutive days from referenceDate with Turkish + English relations:
 * today/tomorrow/day after tomorrow, N days ahead, Monday-based week relation,
 * weekend flag, nth weekday of its month (including last), and month name.
 */
export function buildCalendar(referenceDate: string, days = 120): Record<string, string> {
  const today = new Date(`${referenceDate}T12:00:00Z`);
  const todayDow = today.getUTCDay();
  const todayMondayOffset = (todayDow + 6) % 7;
  const todayMonday = addDays(today, -todayMondayOffset);
  const out: Record<string, string> = {};

  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    const dateStr = iso(d);
    const dow = d.getUTCDay();
    const m = d.getUTCMonth();
    const dom = d.getUTCDate();
    const nth = Math.floor((dom - 1) / 7) + 1;
    const isLastInMonth = addDays(d, 7).getUTCMonth() !== m;
    const weekIdx = Math.floor((d.getTime() - todayMonday.getTime()) / (7 * 86400000));
    const occurrenceAhead = Math.floor((i - 1) / 7) + 1;
    const isWeekend = dow === 0 || dow === 6;

    const rels: string[] = [];
    if (i === 0) rels.push('bugün/today');
    else if (i === 1) rels.push('yarın/tomorrow', '1 gün sonra');
    else if (i === 2) rels.push('öbür gün/day after tomorrow', '2 gün sonra');
    else rels.push(`${i} gün sonra`);

    if (weekIdx === 0) {
      rels.push('bu hafta/this week');
    } else if (weekIdx === 1) {
      rels.push(`gelecek haftanın (next week's) ${WEEKDAYS_TR_POSS[dow]}`);
      if (occurrenceAhead >= 2) {
        rels.push(`${occurrenceAhead} hafta sonra`);
      }
    } else {
      rels.push(`${weekIdx} hafta sonra`);
    }

    if (isWeekend) {
      rels.push('hafta sonu/weekend');
    }

    const nthLabel = `${MONTHS_TR_GEN[m]} ${nth}. ${WEEKDAYS_TR_POSS[dow]}`;
    const lastLabel = isLastInMonth ? `; ayın son ${WEEKDAYS_TR_POSS[dow]}` : '';
    rels.push(`${nthLabel}${lastLabel}`);
    rels.push(`${MONTHS_TR[m]}/${MONTHS_EN[m]} ${dom <= 10 ? 'başı/early' : dom <= 20 ? 'ortası/mid' : 'sonu/late'}`);

    out[`d${i}`] = `${dateStr} ${WEEKDAYS_TR[dow]}/${WEEKDAYS_EN[dow]} — ${rels.join('; ')}`;
  }
  return out;
}

/** Every occurrence of a number candidate, with nearby words: "3-year-old" and
 * "3 tickets" are different numbers, and "altı" can mean six or "under". */
export function numberOccurrences(text: string, limit = 24) {
  const lower = text.toLocaleLowerCase('tr-TR');
  const out: Array<{ text: string; value: number; at: number; nearby: string }> = [];
  for (const candidate of numberCandidates(text)) {
    const needle = candidate.text.toLocaleLowerCase('tr-TR');
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + needle.length)) {
      const before = lower[at - 1] ?? ' ', after = lower[at + needle.length] ?? ' ';
      // Digits must not continue a longer number ("16" in "160"). Number words
      // must start a word ("altı" in "kaltı" is not one); Turkish suffixes may follow.
      const numeric = /\d/u.test(needle[0]);
      if (numeric ? /\d/u.test(before) || /\d/u.test(after) : /\p{L}/u.test(before)) continue;
      out.push({ text: text.slice(at, at + needle.length), value: candidate.value, at,
        nearby: text.slice(Math.max(0, at - 24), at + needle.length + 24).replace(/\s+/gu, ' ').trim() });
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, limit);
}

export function buildReaderRequest(input: ParserInput) {
  const ref = new Date(`${input.referenceDate}T12:00:00Z`);
  const calendar = buildCalendar(input.referenceDate, 120);
  const numbers = numberOccurrences(input.utterance);
  const state = {
    message: input.utterance,
    today: `${input.referenceDate}, ${WEEKDAYS_EN[ref.getUTCDay()]} (Istanbul)`,
    calendar,
    numbersInMessage: numbers.map((n, i) => ({ ref: `n${i}`, text: n.text, value: n.value, nearby: n.nearby })),
  };
  const context =
    'The message is a request for events to attend in Istanbul; answer only from what it states.';
  const optional = (noun: string) =>
    noulQ(
      `${context} Is the ${noun} condition stated only as optional/preferred ("olsa iyi olur", "tercihen", "mümkünse", "ideally", "if possible", "preferably")?`,
    );
  const questions: Record<string, Question> = {};

  // 1. Scope gate.
  questions.scope = choice(
    `${context} What is the scope of \`message\`? Never decline just for moods, vibes or unknown words.`,
    {
      events:
        'An Istanbul event request (concerts, theatre, stand-up, workshops, exhibitions, museums, talks, shows, festivals, cinema, sports, tours, or general outings in Istanbul, even if vague).',
      other_city:
        'Asks for events in another city or country outside Istanbul (e.g. Ankara, İzmir, Eskişehir, London).',
      out_of_product:
        'Not about attending events: restaurants or dinners, table/hotel bookings ("rezervasyon", "masa ayırt"), ratings, reviews or rankings ("puanı yüksek", "best reviewed", "top-rated"), or guarantees the search cannot check ("kesin kabul edilir mi", "guaranteed entry").',
    },
  );

  // 2. Dates by candidate selection.
  questions.date_shape = choice(
    `${context} What date condition does the message state? Use \`calendar\` in state.`,
    {
      none: 'No date, day, week, weekend, month or season is stated.',
      single:
        'A single day ("bugün", "yarın", "perşembe", "haftaya salı", "Aralık\'ın ikinci pazarı", "3 hafta sonra cumartesi", "12 Aralık", "the last Friday of the month"). ',
      range:
        'A date range from–to: a weekend ("hafta sonu", "the weekend after next" → Saturday to Sunday), a week ("bu hafta", "next week"), weekdays of a week (Monday to Friday), "until a day" ("cumaya kadar", "by the 15th" → today to that day), "within N days" ("önümüzdeki 5 gün"), a whole month ("Aralık\'ta", "in December"), or a season ("kışın", "this winter" → today to the end of the season inside the calendar). ',
      alternatives:
        'Two separate days as alternatives ("salı ya da çarşamba", "Friday or Sunday").',
      past: 'Before `today` ("dün", "geçen hafta", "last weekend", past dates).',
      beyond_window: 'More than 119 days after `today`.',
      unreadable: 'Impossible calendar date (e.g. "30 Şubat" / February 30) or unresolvable.',
    },
  );

  const dateCriteria: Record<string, string> = { none: 'No date.' };
  for (let i = 0; i < 120; i++) {
    const d = addDays(ref, i);
    dateCriteria[`d${i}`] = iso(d);
  }
  // Questions cannot see each other's answers: each premise is stated explicitly.
  questions.day_single = choice(
    `${context} Assume the message names exactly one day for the events. Which day in \`calendar\` is it?`,
    dateCriteria,
  );
  questions.range_start = choice(
    `${context} Assume the message names a period of several days (a weekend, a week, weekdays, a month, a season, "until" a day or "within" some days). Which day in \`calendar\` starts it? A period that starts now starts today.`,
    dateCriteria,
  );
  questions.range_end = choice(
    `${context} Assume the message names a period of several days (a weekend, a week, weekdays, a month, a season, "until" a day or "within" some days). Which day in \`calendar\` ends it? If the period ends after the last calendar day, choose the last calendar day.`,
    dateCriteria,
  );
  questions.alternative_first = choice(
    `${context} Assume the message names two separate days as alternatives ("X or Y"). Which day in \`calendar\` is the first one?`,
    dateCriteria,
  );
  questions.alternative_second = choice(
    `${context} Assume the message names two separate days as alternatives ("X or Y"). Which day in \`calendar\` is the second one?`,
    dateCriteria,
  );
  questions.period = choice(
    `${context} Assume the message names a month or a season as the period for the events ("ekimde", "kasım sonu", "in December", "early March", "sonbaharda", "this winter"). A month inside a calendar date ("31 Ekim", "October 5") is not a period. Which one?`,
    { none: 'No month or season is named.', ...opts(MONTHS_EN), ...opts(Object.keys(SEASONS)) },
  );
  questions.period_part = choice(
    `${context} Assume the message names a month. Which part of that month?`,
    {
      whole: 'The whole month, or no part is named ("ekimde", "in October").',
      start: 'The beginning ("ekim başı", "early October").',
      middle: 'The middle ("ekim ortası", "mid-October").',
      end: 'The end ("ekim sonu", "ekim sonunda", "late October", "end of October").',
    },
  );
  questions.date_optional = optional('date');

  // 3. Time.
  questions.time = choice(`${context} What start time does the user want?`, {
    none: 'No start time or time of day.',
    after: 'After a clock time: "saat 8\'den sonra", "19:00\'dan sonra", "after 7 pm".',
    from: 'At or after a clock time: "8\'den itibaren", "from 7", "en erken 19:00".',
    before: 'Before a clock time: "20:00\'den önce", "before 9".',
    until: 'At the latest at a clock time: "en geç 21:00", "by 9 pm".',
    between: 'Between two clock times: "19:00 ile 21:00 arası", "between 6 and 8 pm".',
    at: 'At a clock time: "saat 20:00\'de", "at 8 pm".',
    morning: 'Morning: "sabah", "morning".',
    afternoon: 'Afternoon: "öğleden sonra", "öğlen", "afternoon".',
    evening:
      'Evening or night: "akşam", "akşamı", "gece", "evening", "tonight", "night", "after work".',
  });
  const hours = opts(range(0, 23));
  const minutes = opts(
    range(0, 59).map((minute) => minute.padStart(2, '0')),
    (minute) => (minute === '00' ? 'On the hour or not stated.' : `:${minute}`),
  );
  questions.time_hour = choice(
    `${context} First clock hour (0-23)? Evening wording makes small hours 12-23 ("akşam 8" / "8 pm" = 20).`,
    { ...hours, none: 'No clock time.' },
  );
  questions.time_minute = choice(
    `${context} First clock minute? "Buçuk" / "half past" = 30.`,
    minutes,
  );
  questions.time_hour_end = choice(
    `${context} End clock hour (0-23) for a time range?`,
    { ...hours, none: 'No time range.' },
  );
  questions.time_minute_end = choice(
    `${context} End clock minute for a time range?`,
    minutes,
  );
  questions.time_optional = optional('start time');

  // 4. Place.
  questions.place = choice(
    `${context} Where in Istanbul does the user want the events? Ignore ruled-out places.`,
    {
      none: 'No place inside Istanbul (or only "İstanbul" as a whole).',
      in: 'In or around one Istanbul place ("Üsküdar\'da", "Nişantaşı civarı", "near Bebek", "Anadolu yakasında").',
      either: 'In one of two or more Istanbul places ("Şişli ya da Beyoğlu", "Karaköy/Galata", "Ataşehir or Kartal").',
      unknown: 'A wanted place is named, but it is unclear where in Istanbul it is.',
    },
  );
  questions.district = choice(
    `${context} Which Istanbul district is or contains the (first) wanted place? (Taksim/Galata → Beyoğlu; Moda → Kadıköy; Bebek/Ortaköy → Beşiktaş; Sultanahmet/Balat → Fatih; common abbreviations and misspellings name the same district.) Ignore ruled-out places.`,
    {
      ...opts(DISTRICTS),
      none: 'No district, or only a side (Avrupa/Anadolu yakası) is named.',
    },
  );
  questions.district_2 = choice(
    `${context} Second alternative wanted district (or district containing the second place)?`,
    { ...opts(DISTRICTS), none: 'No second place.' },
  );
  questions.neighborhood = choice(
    `${context} Wanted neighbourhood or area smaller than a district? Ignore ruled-out places.`,
    {
      ...opts(NEIGHBORHOODS),
      other: 'Another smaller place.',
      none: 'No neighbourhood named.',
    },
  );
  questions.neighborhood_2 = choice(
    `${context} Second alternative wanted neighbourhood or area smaller than a district ("X ya da Y", "X/Y")? Ignore ruled-out places.`,
    { ...opts(NEIGHBORHOODS), other: 'Another smaller place.', none: 'No second neighbourhood named.' },
  );
  questions.excluded_district = choice(
    `${context} Does the user rule out a whole Istanbul district ("Kadıköy dışında", "not in Beşiktaş")? Choose none if only a neighbourhood is ruled out.`,
    { ...opts(DISTRICTS), none: 'No whole district ruled out.' },
  );
  questions.excluded_neighborhood = choice(
    `${context} Does the user rule out a neighbourhood ("Taksim'de olmasın", "nothing in Moda")?`,
    { ...opts(NEIGHBORHOODS), none: 'No neighbourhood ruled out.' },
  );
  questions.side = choice(`${context} Does the message limit events to one side of Istanbul?`, {
    europe: 'European side ("Avrupa yakası", "European side").',
    asia: 'Asian side ("Anadolu yakası", "Asian side").',
    none: 'No side named.',
  });
  questions.place_optional = optional('place');

  // 5. Numbers by role, budget, party_words.
  const numRoleCriteria = Object.fromEntries(
    Object.keys(NUMBER_ROLES).map((k) => [k, k]),
  );
  numbers.forEach((n, i) => {
    questions[`number_role_${i}`] = choice(
      `${context} What does \`numbersInMessage[${i}]\` ("${n.text}" in "…${n.nearby}…") count or measure? Judge this occurrence from its nearby words only.`,
      numRoleCriteria,
    );
  });

  questions.budget = choice(`${context} What ticket price limit does the user set?`, {
    none: 'No price or budget condition.',
    max: 'At most / up to / a budget of ("en fazla 300 TL", "700 TL\'yi aşmasın", "bütçem 1500", "max 400", "up to 650 lira"), also when "free or at most X" is acceptable.',
    under: 'Strictly under ("500 TL altı", "500\'den ucuz", "under 500").',
    min: 'At least ("en az 300 TL").',
    over: 'More than ("300 TL üstü", "over 300").',
    around: 'Approximately ("450 TL civarı", "~1000 tl", "about 300").',
    between: 'Between two amounts ("300-600 TL").',
    free: 'Free events only ("ücretsiz", "bedava", "free").',
    cheap_no_amount: 'Cheap/affordable with no amount ("ucuz olsun", "uygun fiyatlı").',
  });
  questions.budget_basis = choice(
    `${context} What does the price amount apply to?`,
    {
      per_person: 'Each person ("kişi başı", "per person", "each").',
      per_ticket: 'Each ticket ("bilet başına", "per ticket", "bilet").',
      group_total: 'The whole group together ("toplam", "hepimiz için", "in total for us").',
      unstated: 'Not stated.',
    },
  );
  questions.budget_optional = optional('price');

  questions.party_words = choice(
    `${context} If the number of attendees is stated only in words that are not in \`numbersInMessage\` ("ikimiz" = 2, "üçümüz" = 3, "just me" = 1), how many? A partner, family or "we" without a count is none.`,
    { ...opts(range(1, 20)), none: 'No word-only count.' },
  );

  // 6. Items: categories, topics, experiences, content, moods.
  const item = (text: string, opposite = false, evidence?: string, wantText?: string, optionalText?: string) =>
    choice(
      evidence === undefined
        ? `${context} How does the message treat ${text}? Judge only its local clause.`
        : { evidence, question: `Classify ${text} using only \`evidence\`. The evidence is the complete clause for this event type. A negation in another clause does not reach it; a trailing negation applies to every item of its own coordinated phrase ("A veya B olmasın" excludes both).` },
      {
        no: `The message does not name ${text} itself. Related, broader or narrower items, and words with another meaning, do not count.`,
        want: wantText ?? (opposite ? 'The message asks for it, or rules out its opposite.' : 'The message asks for it, or accepts it as one of its options.'),
        optional: optionalText ?? 'The message names it only as a possibility or preference ("olabilir", "tercihen", "ideally").',
        exclude: `The message names ${text} itself and rules it out ("olmasın", "hariç", "dışında", "istemiyorum", "no", "except"). A negation that names a different item does not exclude it, and "it does not have to be" ("illa ... olmasın", "şart değil") is not an exclusion.`,
      },
    );

  // Code finds the clause that names each event type; Jev judges its role there.
  const categoryEvidence = scopedTargetEvidence(input.utterance, CATEGORY_TERMS);
  for (const [value, text] of Object.entries(CATEGORIES)) {
    questions[`category_${value}`] = item(`event type ${text}`, false, categoryEvidence[value]);
  }
  questions.dance_activity = noulQ(
    `${context} Does the user want to dance themselves rather than watch a dance/ballet performance?`,
  );

  // A topic can only be hard (wanted or excluded) when the message uses one of its
  // words, so only those topics are asked; the raw message still ranks themes.
  const topics = targetsIn(input.utterance, TOPIC_TERMS);
  for (const value of topics) {
    const terms = TOPIC_TERMS[value];
    const extra = value === 'history' ? '; "tarih"=date isn\'t history' : '';
    questions[`topic_${value}`] = item(
      `topic "${value}" (${terms.slice(0, 4).join(', ')}${extra})`,
      false,
      undefined,
      'The events must be of this genre or topic: the message names it as what the event is ("caz konseri", "a pottery workshop", "rock dinletisi"), or as one of such options.',
      'Only a vibe, mood, style or wish, not what the event must be ("caz barı havası", "jazzy", "-vari", "olabilir", "tercihen", "ideally").',
    );
  }
  for (const [value, text] of Object.entries(EXPERIENCES)) {
    questions[`experience_${value}`] = item(text, true);
  }
  for (const [value, text] of Object.entries(CONTENT)) {
    questions[`content_${value}`] = item(text);
  }
  for (const [value, text] of Object.entries(MOODS)) {
    questions[`mood_${value}`] = item(text);
  }

  // 7. Companions.
  for (const [value, text] of Object.entries(COMPANIONS)) {
    questions[`companion_${value}`] = choice(
      `${context} Will the user attend with ${text}, or is the event for ${text}?`,
      {
        no: 'No, not mentioned, or the user rules it out.',
        yes: 'Yes.',
      },
    );
  }

  // 8. Order.
  questions.order = choice(`${context} How does the user want results sorted?`, {
    none: 'Not mentioned.',
    soonest: 'Soonest first ("en yakın tarih", "en erken", "soonest").',
    cheapest: 'Cheapest first ("en ucuz", "cheapest").',
  });

  return { state, questions, numbers, calendar, topics };
}

export type ReaderRequest = ReturnType<typeof buildReaderRequest>;

function validAnswers(questions: Record<string, Question>, response: JevResponse): boolean {
  if (!response?.answers || typeof response.answers !== 'object') return false;
  const probability = (p: unknown): p is number =>
    typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
  return Object.entries(questions).every(([id, question]) => {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type) return false;
    if (question.type === 'noul') return answer.type === 'noul' && probability(answer.noul);
    return (
      answer.type === 'choice' &&
      Object.hasOwn(question.criteria, answer.choice) &&
      probability(answer.confidence) &&
      Boolean(answer.probabilities) &&
      Object.entries(answer.probabilities).every(
        ([key, p]) => Object.hasOwn(question.criteria, key) && probability(p),
      )
    );
  });
}

type ResolvedRole = 'no' | 'want' | 'optional' | 'exclude';

/**
 * Confidence margin check for 4-way item questions:
 * An item becomes want/exclude only if its top probability >= ITEM_MIN_PROBABILITY (0.5)
 * and exceeds the next option by >= ITEM_MIN_MARGIN (0.15);
 * otherwise want -> optional (preference) and exclude -> dropped ('no').
 */
function resolveItemRole(answer: ChoiceAnswer, allowExclude = true): ResolvedRole {
  // When the evidence cannot support an exclusion, judge among the other options.
  const entries = Object.entries(answer.probabilities)
    .filter(([key]) => allowExclude || key !== 'exclude')
    .sort((a, b) => b[1] - a[1]);
  const [topChoice, topProb] = entries[0] ?? [answer.choice, answer.confidence];
  const secondProb = entries[1]?.[1] ?? 0;
  const confident = topProb >= ITEM_MIN_PROBABILITY && topProb - secondProb >= ITEM_MIN_MARGIN;

  if (topChoice === 'want') return confident ? 'want' : 'optional';
  if (topChoice === 'exclude') return confident ? 'exclude' : 'no';
  if (topChoice === 'optional') {
    return topProb >= ITEM_MIN_PROBABILITY || answer.choice === 'optional' ? 'optional' : 'no';
  }
  return 'no';
}

export function composeReader(
  input: ParserInput,
  built: ReaderRequest,
  response: JevResponse,
): ParseResult {
  const a = response.answers;
  const debug: Debug = {
    mentions: [],
    answers: Object.fromEntries(
      Object.entries(a ?? {}).map(([k, v]) => [
        k,
        v.type === 'choice'
          ? Object.entries(v.probabilities)
              .sort((x, y) => y[1] - x[1])
              .slice(0, 2)
              .filter(([, p], i) => i === 0 || p >= 0.1)
              .map(([o, p]) => `${o}:${p.toFixed(2)}`)
              .join('/')
          : (v as NoulAnswer).noul.toFixed(2),
      ]),
    ),
    usage: response.usage,
  };
  const whole = [{ start: 0, end: input.utterance.length, text: input.utterance }];
  const refuse = (reason: string): ParseResult => ({
    status: 'unsupported',
    reason,
    unresolvedSpans: whole,
    debug,
  });

  if (!validAnswers(built.questions, response)) {
    return refuse('invalid or incomplete provider judgments');
  }

  const pick = (id: string) => (a[id] as ChoiceAnswer).choice;
  const dist = (id: string) => (a[id] as ChoiceAnswer).probabilities;
  const noul = (id: string) => (a[id] as NoulAnswer).noul;
  const itemRole = (id: string, allowExclude = true) => resolveItemRole(a[id] as ChoiceAnswer, allowExclude);
  // An exclusion needs a negation word in the clause that names the item.
  const negated = (clause: string) => NEGATION.test(fold(clause));

  // 1. Scope gate.
  const scopeDist = dist('scope');
  if ((scopeDist.other_city ?? 0) > SCOPE_DECLINE_THRESHOLD) {
    return refuse('unsupported outside_location');
  }
  if ((scopeDist.out_of_product ?? 0) > SCOPE_DECLINE_THRESHOLD) {
    return refuse('condition outside supported vocabulary');
  }

  const refDate = new Date(`${input.referenceDate}T12:00:00Z`);
  const dayIso = (key: string): string | null => {
    if (!/^d\d+$/u.test(key)) return null;
    const offset = Number(key.slice(1));
    if (!Number.isInteger(offset) || offset < 0 || offset >= 120) return null;
    return iso(addDays(refDate, offset));
  };

  const numberRoles = built.numbers.map((_, i) => pick(`number_role_${i}`));

  const hard: Condition[] = [];
  const preferences: Condition[] = [];
  const addCondition = (condition: Condition, preferred: boolean) => {
    (preferred ? preferences : hard).push(condition);
  };

  // 2. Date.
  const dateShape = pick('date_shape');
  // A clear start/end pair (an explicit "31 Ekim-1 Kasım") outweighs a month name.
  const confidentRange = () => (dist('range_start')[pick('range_start')] ?? 0) >= 0.6 && (dist('range_end')[pick('range_end')] ?? 0) >= 0.6
    && pick('range_start') !== 'none' && pick('range_end') !== 'none';
  const dateOptional = noul('date_optional') > 0.5;

  if (dateShape === 'past') return refuse('past date');
  if (dateShape === 'beyond_window' || dateShape === 'unreadable') {
    return refuse('unreadable date');
  }
  if (dateShape === 'single') {
    const day = dayIso(pick('day_single'));
    if (!day) return refuse('unreadable date');
    addCondition({ type: 'atom', atom: { kind: 'date', from: day, to: day } }, dateOptional);
  } else if (dateShape === 'range' && pick('period') !== 'none' && (dist('period')[pick('period')] ?? 0) >= 0.5 && !confidentRange()) {
    const range = periodRange(input.referenceDate, pick('period'), pick('period_part'));
    if (!range) return refuse('unreadable date');
    addCondition({ type: 'atom', atom: { kind: 'date', ...range } }, dateOptional);
  } else if (dateShape === 'range') {
    // Start and end are separate judgments: choose the most likely pair with end >= start.
    const top = (id: string) => Object.entries(dist(id)).filter(([key]) => dayIso(key)).sort((x, y) => y[1] - x[1]).slice(0, 6);
    let best: { from: string; to: string; p: number } | null = null;
    for (const [startKey, ps] of top('range_start'))
      for (const [endKey, pe] of top('range_end')) {
        const from = dayIso(startKey)!, to = dayIso(endKey)!;
        if (to >= from && (!best || ps * pe > best.p)) best = { from, to, p: ps * pe };
      }
    if (!best) return refuse('unreadable date');
    const { from, to } = best;
    addCondition({ type: 'atom', atom: { kind: 'date', from, to } }, dateOptional);
  } else if (dateShape === 'alternatives') {
    const firstIso = dayIso(pick('alternative_first')), lastIso = dayIso(pick('alternative_second'));
    if (!firstIso || !lastIso) return refuse('unreadable date');
    const c1: Condition = { type: 'atom', atom: { kind: 'date', from: firstIso, to: firstIso } };
    const c2: Condition = { type: 'atom', atom: { kind: 'date', from: lastIso, to: lastIso } };
    addCondition(
      firstIso === lastIso ? c1 : { type: 'any', children: [c1, c2] },
      dateOptional,
    );
  }

  // 3. Time.
  const timeKind = pick('time');
  const timeOptional = noul('time_optional') > 0.5;
  const clock = (h: string, m: string) => (h === 'none' ? null : `${h.padStart(2, '0')}:${m}`);
  const t1 = clock(pick('time_hour'), pick('time_minute'));
  const t2 = clock(pick('time_hour_end'), pick('time_minute_end'));
  const periods: Record<string, [string, string]> = {
    morning: ['06:00', '11:59'],
    afternoon: ['12:00', '17:59'],
    evening: ['18:00', '23:59'],
  };
  if (periods[timeKind]) {
    addCondition(
      { type: 'atom', atom: { kind: 'time', from: periods[timeKind][0], to: periods[timeKind][1] } },
      timeOptional,
    );
  } else if (['after', 'from', 'before', 'until', 'at', 'between'].includes(timeKind)) {
    if (!t1 || (timeKind === 'between' && (!t2 || t1 > t2))) {
      return refuse('unreadable time');
    }
    const timeAtom: Extract<Atom, { kind: 'time' }> =
      timeKind === 'after'
        ? { kind: 'time', from: t1, fromExclusive: true }
        : timeKind === 'from'
          ? { kind: 'time', from: t1 }
          : timeKind === 'before'
            ? { kind: 'time', to: t1, toExclusive: true }
            : timeKind === 'until'
              ? { kind: 'time', to: t1 }
              : timeKind === 'at'
                ? { kind: 'time', from: t1, to: t1 }
                : { kind: 'time', from: t1, to: t2! };
    addCondition({ type: 'atom', atom: timeAtom }, timeOptional);
  }

  // 4. Place.
  let placeKind = pick('place');
  const namedNeighborhood = pick('neighborhood');
  const excludedNeighborhood = pick('excluded_neighborhood');
  const excludedDistrict = pick('excluded_district');
  if (excludedNeighborhood !== 'none') {
    debug.answers.excluded_neighborhood_ignored = excludedNeighborhood;
  }
  const namedPlace =
    namedNeighborhood !== 'none' && namedNeighborhood !== 'other'
      ? placeOf(fold(namedNeighborhood).trim())
      : null;
  const namedDistrict = namedPlace?.district
    ? DISTRICTS.find((district) => fold(district) === namedPlace.district) ?? null
    : null;
  const namedNeighborhoodAllowed =
    namedNeighborhood !== excludedNeighborhood &&
    (!namedDistrict || fold(namedDistrict) !== fold(excludedDistrict));
  const escapedNeighborhood = fold(namedNeighborhood).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const directlyNamedNeighborhood = Boolean(
    namedPlace?.district &&
      escapedNeighborhood &&
      new RegExp(
        `(?:^|[^a-z0-9])${escapedNeighborhood}(?:'?(?:de|da|te|ta|den|dan|ten|tan))?(?=$|[^a-z0-9])`,
        'u',
      ).test(fold(input.utterance)),
  );
  if (
    placeKind === 'none' &&
    (((dist('district')[pick('district')] ?? 0) >= 0.8 &&
      pick('district') !== 'none' &&
      pick('district') !== excludedDistrict) ||
      (namedNeighborhood !== 'none' &&
        namedNeighborhood !== 'other' &&
        namedNeighborhoodAllowed &&
        (dist('neighborhood')[namedNeighborhood] ?? 0) >= 0.6))
  ) {
    placeKind = 'in';
  }
  if (
    placeKind === 'unknown' &&
    (dist('neighborhood')[namedNeighborhood] ?? 0) >= 0.8 &&
    namedNeighborhoodAllowed &&
    directlyNamedNeighborhood
  ) {
    placeKind = 'in';
  }
  if (placeKind === 'unknown') return refuse('unreadable place');
  if (placeKind === 'in' || placeKind === 'either') {
    const placeOptional = noul('place_optional') > 0.5;
    const listed =
      namedNeighborhood !== 'none' &&
      namedNeighborhood !== 'other' &&
      namedNeighborhood !== excludedNeighborhood
        ? namedNeighborhood
        : null;
    const listedPlace = listed ? placeOf(fold(listed).trim()) : null;
    const districtOf = (name: string) => (name === 'none' ? null : name);
    // Code owns the place hierarchy: a known neighbourhood fixes its district.
    const districtOfPlace = (name: string | null) => {
      const place = name && name !== 'none' && name !== 'other' ? placeOf(fold(name).trim()) : null;
      return place?.district ? DISTRICTS.find((d) => fold(d) === place.district) ?? null : null;
    };
    const second2 = pick('neighborhood_2');
    const listed2 = second2 !== 'none' && second2 !== 'other' && second2 !== excludedNeighborhood ? second2 : null;
    if (placeKind === 'in' && listed && listed2 && listed2 !== listed && (dist('neighborhood_2')[listed2] ?? 0) >= 0.6)
      placeKind = 'either';
    const answered = districtOf(pick('district'));
    const confidentDistrict = answered && (dist('district')[answered] ?? 0) >= 0.8 ? answered : null;
    const district = confidentDistrict ?? districtOfPlace(listed) ?? answered;
    const side = pick('side');
    const area = (name: string | null): Atom | null =>
      name
        ? { kind: 'location', name, precision: 'district' }
        : side !== 'none'
          ? {
              kind: 'location',
              name: side === 'asia' ? 'Anadolu yakası' : 'Avrupa yakası',
              precision: 'side',
            }
          : listedPlace?.side
            ? {
                kind: 'location',
                name: listedPlace.side === 'asia' ? 'Anadolu yakası' : 'Avrupa yakası',
                precision: 'side',
              }
            : null;
    const first = area(district);
    if (!first) return refuse('unreadable place');
    const second = placeKind === 'either' ? area(districtOfPlace(listed2) ?? districtOf(pick('district_2'))) : null;
    if (placeKind === 'either' && !second) return refuse('unreadable place');
    const condition: Condition =
      second && JSON.stringify(second) !== JSON.stringify(first)
        ? { type: 'any', children: [{ type: 'atom', atom: first }, { type: 'atom', atom: second }] }
        : { type: 'atom', atom: first };
    addCondition(condition, placeOptional);
    for (const name of placeKind === 'in' ? [listed] : [listed, listed2]) {
      if (name) preferences.push({ type: 'atom', atom: { kind: 'location', name, precision: 'neighborhood' } });
    }
  }
  if (excludedDistrict !== 'none') {
    hard.push({
      type: 'not',
      child: {
        type: 'atom',
        atom: { kind: 'location', name: excludedDistrict, precision: 'district' },
      },
    });
  }

  // 5. Numbers: Party, Age, Budget.
  const partyNumbers = built.numbers
    .filter((_, i) => numberRoles[i] === 'number_of_attendees')
    .map((n) => n.value);
  const partyWordsPick = pick('party_words');
  const partyCount =
    partyNumbers[0] ?? (partyWordsPick !== 'none' ? Number(partyWordsPick) : null);
  if (partyCount !== null) {
    if (!Number.isInteger(partyCount) || partyCount < 1 || partyCount > 1000) {
      return refuse('unreadable party');
    }
    hard.push({ type: 'atom', atom: { kind: 'party', count: partyCount } });
  }

  const ages = [
    ...new Set(
      built.numbers
        .filter((_, i) => numberRoles[i] === 'attendee_age')
        .map((n) => n.value),
    ),
  ];
  if (ages.some((age) => !Number.isInteger(age) || age < 0 || age > 120)) {
    return refuse('unreadable age');
  }
  for (const years of ages) {
    hard.push({ type: 'atom', atom: { kind: 'age', years } });
  }

  // 7. Companions (children/family -> hard; partner/friends -> preference).
  for (const value of Object.keys(COMPANIONS) as Array<keyof typeof COMPANIONS>) {
    if (pick(`companion_${value}`) === 'yes') {
      const cond: Condition = { type: 'atom', atom: { kind: 'companion', value } };
      if (value === 'children' || value === 'family') hard.push(cond);
      else preferences.push(cond);
    }
  }

  // 6. Items: Categories, Topics, Experiences, Content, Moods.
  const danceIsActivity = noul('dance_activity') > 0.5;
  const categoryEvidence = scopedTargetEvidence(input.utterance, CATEGORY_TERMS);
  const rawCatRoles = new Map<Category, ResolvedRole>();
  for (const cat of Object.keys(CATEGORIES) as Category[]) {
    if (cat === 'dance' && danceIsActivity) {
      rawCatRoles.set(cat, 'no');
    } else {
      rawCatRoles.set(cat, itemRole(`category_${cat}`, negated(categoryEvidence[cat] ?? input.utterance)));
    }
  }
  const hasSpecificCategory = (['concert', 'theatre', 'standup', 'dance'] as Category[]).some(
    (c) => rawCatRoles.get(c) === 'want' || rawCatRoles.get(c) === 'optional',
  );
  if (hasSpecificCategory && rawCatRoles.get('show') !== 'exclude') {
    rawCatRoles.set('show', 'no');
  }

  const wantedCategories: Condition[] = [];
  for (const [cat, role] of rawCatRoles) {
    const cond: Condition = { type: 'atom', atom: { kind: 'category', value: cat } };
    if (role === 'want') wantedCategories.push(cond);
    else if (role === 'optional') preferences.push(cond);
    else if (role === 'exclude') hard.push({ type: 'not', child: cond });
  }
  if (wantedCategories.length === 1) {
    hard.push(wantedCategories[0]);
  } else if (wantedCategories.length > 1) {
    hard.push({ type: 'any', children: wantedCategories });
  }

  // Topics: a named genre is hard (several are alternatives); a vibe ranks;
  // each exclusion is its own hard not(topic).
  const seenTopics = new Set<string>();
  // A hard topic needs one of its words in the message; inferred themes only rank.
  const topicNamed = (value: string) => targetsIn(input.utterance, { [value]: TOPIC_TERMS[value] ?? [] }).length > 0;
  const topicEvidence = scopedTargetEvidence(input.utterance, TOPIC_TERMS);
  const wantedTopics: Condition[] = [];
  const addTopic = (value: string, role: ResolvedRole) => {
    if (role === 'no' || seenTopics.has(`${role}:${value}`)) return;
    seenTopics.add(`${role}:${value}`);
    const cond: Condition = { type: 'atom', atom: { kind: 'topic', value } };
    if (role === 'exclude') hard.push({ type: 'not', child: cond });
    else if (role === 'want' && !EXCLUSION_ONLY_TOPICS.has(value) && topicNamed(value)) wantedTopics.push(cond);
    else preferences.push(cond);
  };
  if (danceIsActivity) {
    const danceRole = itemRole('category_dance');
    if (danceRole !== 'no') addTopic('dancing', danceRole);
  }
  for (const topic of built.topics) {
    // A topic can be excluded only when the message names it in a negated clause.
    addTopic(topic, itemRole(`topic_${topic}`, topicNamed(topic) && negated(topicEvidence[topic] ?? input.utterance)));
  }
  if (wantedTopics.length === 1) hard.push(wantedTopics[0]);
  else if (wantedTopics.length > 1) hard.push({ type: 'any', children: wantedTopics });

  // Experiences: checkable formats are hard when required; subjective qualities rank.
  for (const exp of Object.keys(EXPERIENCES) as Array<keyof typeof EXPERIENCES>) {
    const role = itemRole(`experience_${exp}`);
    const cond: Condition = { type: 'atom', atom: { kind: 'experience', value: exp } };
    if (role === 'want' && CHECKABLE_EXPERIENCES.has(exp)) hard.push(cond);
    else if (role === 'want' || role === 'optional') preferences.push(cond);
  }

  // Content: exclusions -> hard not(content); wants/optional -> preferences.
  for (const content of Object.keys(CONTENT) as Array<keyof typeof CONTENT>) {
    const role = itemRole(`content_${content}`);
    const cond: Condition = { type: 'atom', atom: { kind: 'content', value: content } };
    if (role === 'exclude') hard.push({ type: 'not', child: cond });
    else if (role === 'want' || role === 'optional') preferences.push(cond);
  }

  // Moods: preferences ONLY.
  const literalMoods = new Set(
    fold(input.utterance)
      .split(/[,;.!?]+|\b(?:ama|fakat|ancak|lakin|but|however|yet)\b/gu)
      .flatMap((clause) =>
        /(?:^|[^\p{L}\p{N}])(?:olmasin|istemiyorum|degil|olmayan|no|not|without)(?=$|[^\p{L}\p{N}])/u.test(
          clause,
        )
          ? []
          : targetsIn(clause, MOOD_TERMS),
      ),
  );
  for (const mood of Object.keys(MOODS) as Array<keyof typeof MOODS>) {
    const role = itemRole(`mood_${mood}`);
    if (role === 'want' || role === 'optional' || (role === 'no' && literalMoods.has(mood))) {
      preferences.push({ type: 'atom', atom: { kind: 'mood', value: mood } });
    }
  }

  // 5b. Budget.
  const budgetKind = pick('budget');
  const budgetOptional = noul('budget_optional') > 0.5;
  // Most likely price numbers first: "600 TL altı" names 600, not "altı" (six).
  const priceAmounts = built.numbers
    .map((n, i) => ({ value: n.value, p: dist(`number_role_${i}`).price_amount ?? 0, role: numberRoles[i] }))
    .filter((n) => n.role === 'price_amount')
    .sort((x, y) => y.p - x.p)
    .map((n) => n.value);
  const statedBasis = pick('budget_basis');
  const effectiveBasis = (
    budgetKind === 'free'
      ? 'per_ticket'
      : statedBasis === 'group_total' && partyCount !== null
        ? 'group_total'
        : statedBasis === 'per_person' || statedBasis === 'per_ticket'
          ? statedBasis
          : 'per_ticket'
  ) as BudgetBasis;

  const makeBudget = (comparison: Comparison, amount: number): Condition => ({
    type: 'atom',
    atom: { kind: 'budget', comparison, amount, currency: 'TRY', basis: effectiveBasis },
  });

  if (budgetKind === 'free') {
    addCondition(makeBudget('lte', 0), budgetOptional);
  } else if (budgetKind === 'around') {
    const amount = priceAmounts[0];
    if (amount === undefined) return refuse('unreadable budget');
    preferences.push(makeBudget('approx', amount));
  } else if (budgetKind === 'between') {
    if (priceAmounts.length < 2) return refuse('unreadable budget');
    const low = Math.min(priceAmounts[0], priceAmounts[1]);
    const high = Math.max(priceAmounts[0], priceAmounts[1]);
    addCondition(makeBudget('gte', low), budgetOptional);
    addCondition(makeBudget('lte', high), budgetOptional);
  } else if (['max', 'under', 'min', 'over'].includes(budgetKind)) {
    const amount = priceAmounts[0];
    if (amount === undefined) return refuse('unreadable budget');
    const comparison = ({ max: 'lte', under: 'lt', min: 'gte', over: 'gt' } as const)[
      budgetKind as 'max'
    ];
    addCondition(makeBudget(comparison, amount), budgetOptional);
  }

  // 8. Order.
  const pickedOrder = pick('order');
  const planOrder: Order =
    budgetKind === 'cheap_no_amount' && pickedOrder === 'none'
      ? 'cheapest'
      : (pickedOrder as Order);

  let plan: Plan = {
    hard: { type: 'all', children: hard },
    preferences,
    order: planOrder,
  };

  // Ensure the composed plan passes validateSearchPlan; sanitize rather than decline.
  try {
    validateSearchPlan(plan);
  } catch {
    const sanitizedHard = plan.hard.type === 'all'
      ? plan.hard.children.flatMap((c): Condition[] => {
          if (c.type === 'atom') {
            if (c.atom.kind === 'mood') return [];
            if (c.atom.kind === 'budget' && c.atom.comparison === 'approx') return [];
            if (c.atom.kind === 'location' && c.atom.precision === 'neighborhood') return [];
            if (c.atom.kind === 'budget' && c.atom.basis === 'group_total' && partyCount === null) {
              return [{ type: 'atom', atom: { ...c.atom, basis: 'per_ticket' } }];
            }
          }
          return [c];
        })
      : [];
    plan = {
      hard: { type: 'all', children: sanitizedHard },
      preferences: plan.preferences,
      order: plan.order === 'nearest' ? 'none' : plan.order,
    };
  }

  const operations: Operation[] = [];
  for (const c of plan.hard.type === 'all' ? plan.hard.children : []) {
    operations.push({ op: 'add', strength: 'hard', condition: c });
  }
  for (const c of plan.preferences) {
    operations.push({ op: 'add', strength: 'preferred', condition: c });
  }
  if (plan.order !== 'none') {
    operations.push({ op: 'order', value: plan.order });
  }

  const resultingPlan = applyOperations(null, operations);
  return { status: 'accepted', operations, resultingPlan, debug };
}
