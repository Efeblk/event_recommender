/**
 * Field reader. Jev reads every supported field from the whole message in one
 * request: whether the field is stated, and its parts (TypeSafe date-extraction
 * and function-calling cookbooks). Code owns calendar math, place hierarchy,
 * number values and plan composition.
 *
 * A field that is stated but cannot be resolved is never dropped: the parser
 * returns `unsupported` with that field, so the search asks instead of running
 * without it. Numbers are selected from candidates found in the text, never
 * generated.
 */
import { placeOf } from '../../contracts/location.ts';
import type { Atom, Category, Condition, Interpretation, Operation, Order, ParserInput, Plan } from './contract.ts';
import { DISTRICTS, fold, NEIGHBORHOODS, NUMBER_WORDS, TOPIC_TERMS } from './lexicon.ts';
import type { ChoiceAnswer, Debug, JevResponse, NoulAnswer, ParseResult, Question } from './parse-core.ts';
import { applyOperations } from './state.ts';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
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
  show: 'a show or stage performance in general ("gösteri", "a show", "performans", circus, magic) — not when the message names a concert, play, stand-up or dance instead',
  course: 'multi-session courses or classes ("kurs", "ders", "course", "class") — a one-off "atölye"/workshop is not a course',
  tour: 'tours or guided walks ("tur", "gezi", "tour")',
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
const CONTENT = { profanity: 'profanity or swearing (küfür)', sexual_content: 'sexual content or nudity' } as const;
const MOODS = { calm: 'a calm, relaxing outing (sakin, dinlendirici)', intimate: 'an intimate outing (samimi)' } as const;
const COMPANIONS = {
  partner: 'a romantic partner, girlfriend, boyfriend or spouse (sevgili, eş)',
  friends: 'friends',
  family: 'family members named as such ("ailemle", "ailece", "annemle", "with my family"); children alone ("çocuklarla", "kızım", "with kids") are not this',
  children: 'children or kids',
} as const;
type Kind = Atom['kind'];

const SUPPORTED = 'The search can check only: Istanbul districts, neighbourhoods and sides; dates (today or later); start times; ticket prices in Turkish lira; number and ages of attendees; companions; event types; topics or genres; quiet, seated, outdoors, wheelchair access, family-friendly, uncrowded, romantic, beginner-friendly; calm or intimate outings; absence of profanity or sexual content; sorting by soonest, cheapest or nearest.';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
// The "not stated" option comes first, so a default reading adds no condition.
const choice = (instructions: unknown, criteria: Record<string, string>): Question => {
  const { none, ...rest } = criteria;
  return { type: 'choice', instructions, criteria: none === undefined ? criteria : { none, ...rest } };
};
const noulQ = (instructions: unknown): Question => ({ type: 'noul', instructions });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => String(from + i));
const opts = (keys: string[], describe: (key: string) => string = (key) => key) => Object.fromEntries(keys.map((key) => [key, describe(key)]));

/** Number candidates in the message: digits ("1.500", "2,5k") and number words ("iki yüz"). */
export function numberCandidates(text: string): Array<{ text: string; value: number }> {
  const folded = fold(text);
  const words = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');
  // Over-find (pre-parsed value extraction cookbook): any run of digits is a
  // candidate, whatever letters touch it ("1000tl", "500₺", "x2"). Number
  // words need word boundaries, or "on" and "bir" would match inside words.
  const digits = /(?<!\p{N})(?:\d+(?:[.,]\d+)?\s?k(?![a-z])|\d{1,3}(?:[.,]\d{3})+(?![.,]?\d)|\d+(?:[.,]\d{1,2})?)(?!\p{N})/gu;
  const named = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words})(?:\\s+(?:${words}))*(?![\\p{L}\\p{N}])`, 'gu');
  const matches = [...folded.matchAll(digits), ...folded.matchAll(named)].sort((a, b) => a.index! - b.index!);
  const seen = new Set<string>();
  const out: Array<{ text: string; value: number }> = [];
  for (const m of matches) {
    const value = numberValue(m[0]);
    if (value === null) continue;
    const surface = text.slice(m.index!, m.index! + m[0].length);
    if (seen.has(surface)) continue;
    seen.add(surface);
    out.push({ text: surface, value });
  }
  return out.slice(0, 24);
}

function numberValue(raw: string): number | null {
  const s = raw.trim();
  const k = /^(\d+(?:[.,]\d+)?)\s?k$/u.exec(s);
  if (k) return Math.round(Number(k[1].replace(',', '.')) * 1000);
  if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(s)) return Number(s.replace(/[.,]/gu, ''));
  if (/^\d+(?:[.,]\d{1,2})?$/u.test(s)) return Number(s.replace(',', '.'));
  let total = 0, current = 0;
  for (const word of s.split(/\s+/u)) {
    const value = NUMBER_WORDS[word];
    if (value === undefined) return null;
    if (value === 1000) { total += (current || 1) * 1000; current = 0; }
    else if (value === 100) current = (current || 1) * 100;
    else current += value;
  }
  return total + current;
}

// --- Describing an existing plan, by field.
interface Item { kind: Kind; condition: Condition; preferred: boolean }
const atomsOf = (c: Condition): Atom[] => c.type === 'atom' ? [c.atom] : c.type === 'not' ? atomsOf(c.child) : c.children.flatMap(atomsOf);
const kindOf = (c: Condition): Kind => atomsOf(c)[0].kind;
function items(plan: Plan | null): Item[] {
  if (!plan) return [];
  const hard = plan.hard.type === 'all' ? plan.hard.children : [];
  return [...hard.map((condition) => ({ kind: kindOf(condition), condition, preferred: false })),
    ...plan.preferences.map((condition) => ({ kind: kindOf(condition), condition, preferred: true }))];
}
function describeAtom(atom: Atom): string {
  switch (atom.kind) {
    case 'budget': return `price ${{ lt: 'under', lte: 'at most', gt: 'over', gte: 'at least', approx: 'around' }[atom.comparison]} ${atom.amount} TL ${atom.basis.replace('_', ' ')}`;
    case 'date': return atom.from === atom.to ? `date ${atom.from} (${WEEKDAYS[new Date(`${atom.from}T12:00:00Z`).getUTCDay()]})` : `dates ${atom.from} to ${atom.to}`;
    case 'time': return `start time${atom.from ? ` ${atom.fromExclusive ? 'after' : 'from'} ${atom.from}` : ''}${atom.to ? ` ${atom.toExclusive ? 'before' : 'until'} ${atom.to}` : ''}`;
    case 'location': return `place ${atom.name}`;
    case 'party': return `${atom.count} people attending`;
    case 'age': return `an attendee aged ${atom.years}`;
    case 'mood': return `${atom.value} outing`;
    case 'companion': return `with ${atom.value}`;
    case 'category': return `event type ${atom.value}`;
    case 'topic': return `topic ${atom.value}`;
    case 'experience': return atom.value.replaceAll('_', ' ');
    case 'content': return `${atom.value.replace('_', ' ')} content`;
  }
}
function describe(c: Condition): string {
  if (c.type === 'atom') return describeAtom(c.atom);
  if (c.type === 'not') return `NOT ${describe(c.child)}`;
  return c.children.map(describe).join(c.type === 'any' ? ' OR ' : ' AND ');
}

/** Item values a per-item field (category, topic, ...) holds in the previous plan. */
function previousValues(prev: Item[], kind: Kind): Map<string, 'want' | 'optional' | 'exclude'> {
  const out = new Map<string, 'want' | 'optional' | 'exclude'>();
  for (const item of prev.filter((x) => x.kind === kind)) {
    const negated = item.condition.type === 'not';
    for (const atom of atomsOf(item.condition))
      if ('value' in atom) out.set(atom.value, negated ? 'exclude' : item.preferred ? 'optional' : 'want');
  }
  return out;
}

export function buildFieldRequest(input: ParserInput) {
  const prev = input.previousState?.plan ?? null;
  const previous = items(prev);
  const has = (kind: Kind) => previous.some((x) => x.kind === kind);
  const ref = new Date(`${input.referenceDate}T12:00:00Z`);
  const numbers = numberCandidates(input.utterance);
  const state = {
    message: input.utterance,
    today: `${input.referenceDate}, ${WEEKDAYS[ref.getUTCDay()]} (Istanbul)`,
    numbersInMessage: numbers.map((n, i) => ({ ref: `n${i}`, text: n.text })),
    ...(prev ? {
      currentSearch: previous.map((x) => `${x.preferred ? 'preferred' : 'required'}: ${describe(x.condition)}`),
      currentSortOrder: prev.order,
    } : {}),
  };
  const context = '`message` is a request for events to attend in Istanbul.' + (prev ? ' It may refine `currentSearch`, the search the user already has.' : '')
    + ' Answer only from what the message states; never infer a condition it does not state.';
  // Field-level edit options exist only when the current search has that field.
  const edit = (kind: Kind | Kind[], noun: string) => {
    const present = (Array.isArray(kind) ? kind : [kind]).some(has);
    return {
      none: present ? `The message does not change the current ${noun} condition, or says to keep it ("aynı kalsın", "keep").` : `The message states no ${noun} condition.`,
      ...(present ? {
        remove: `The message drops the current ${noun} condition without a new one ("${noun} fark etmez", "any ${noun}", "kaldır").`,
        same: `The message changes only whether the current ${noun} condition is required or optional ("artık zorunlu", "tercih olsun", "make it optional"), with no new value.`,
      } : {}),
    };
  };
  const numberOptions = (absent: string) => ({ ...Object.fromEntries(numbers.map((n, i) => [`n${i}`, `\`numbersInMessage[${i}]\` ("${n.text}")`])), none: absent });
  const optional = (noun: string) => noulQ(`${context} Does the message make its ${noun} condition only optional — a wish, not a requirement ("olsa iyi olur", "tercihen", "mümkünse", "şart değil", "ideally", "if possible", "would be nice", "preferably"), or phrase the whole request as a preference ("tercih ederim", "I prefer")? Judge only the wording about the ${noun}: a wish about another condition does not count.`);
  const questions: Record<string, Question> = {};

  // Scope and whole-request gates.
  questions.unsupported = choice({ supportedConditions: SUPPORTED, question: `${context} Does the message require anything the search cannot check?` }, {
    supported: 'No. Every condition it states is in `supportedConditions`, including excluded types or topics ("konser olmayan"), going with a partner, friends or family, and edits to the current search (replacing or removing a condition, changing a price limit or its basis). General words such as "etkinlik", "bir şeyler", "gidebileceğim yerler", "öner", "something fun" are not conditions.',
    unsupported: 'Yes. It requires something outside `supportedConditions`: a guarantee (e.g. that a child will definitely be admitted), ratings or reviews, awards, occupancy or any percentage, language or subtitles, travel time, weather, parking, food, admission rules, seat positions, availability, fees, or a place relative to a landmark.',
  });
  // Vague references to the current search ("onu kaldır", "make that optional").
  if (prev && previous.length) {
    questions.vague = noulQ(`${context} Does the message point at a condition of \`currentSearch\` only with a vague word instead of naming its value ("o", "onu", "bunu", "şu koşul", "diğer", "bahsettiğim", "onlar gelmeyecek", "ikisinden biri", "that", "it", "they", "the other one", "that preference", "one of the two")?`);
    previous.forEach((_, i) => {
      questions[`refers_${i}`] = noulQ(`${context} Could the vague reference in \`message\` ("that day", "they", "the other district", "that preference", "it", "o", "onu", "onlar") denote \`currentSearch[${i}]\`? Judge only whether the kind fits: "that day" can be any date, "they"/"onlar" any companion, "that preference" only a condition marked preferred, "the other district" any district, "one of the two price limits" any price limit, "it"/"that condition" any condition. Yes for every condition that fits.`);
    });
    questions.vague_action = choice(`${context} What does the message do to the condition it refers to vaguely?`, {
      remove: 'Removes it or says it no longer applies: "kaldır", "sil", "çıkar", "gelmeyecek", "remove", "delete", "will not come".',
      make_preferred: 'Makes it optional: "tercihe çevir", "make it optional/a preference".',
      make_required: 'Makes it required: "zorunlu yap", "make it required".',
      replace: 'Gives it a new value: "onu 21.00 yap", "change it to Saturday".',
      keep: 'Keeps it.',
    });
  }
  questions.outside_istanbul = noulQ(`${context} Does the user ask for events in a city, region or country other than Istanbul (e.g. Ankara, İzmir, London)?`);
  if (prev) questions.reset = choice(`${context} Does the message discard the current search and start over?`, {
    continue: 'No: it adds to, keeps or edits the current search, or asks for other options.',
    reset: 'Yes: forget everything / start over / "hepsini unut", "sıfırla", "baştan başla", "yeni arama".',
  });
  questions.order = choice(`${context} How does the user want results sorted?`, {
    unchanged: prev ? 'The message does not mention sorting.' : 'The message does not mention sorting or ranking.',
    soonest: 'Soonest / earliest date first: "en yakın tarih", "en erken", "soonest".',
    cheapest: 'Cheapest first: "en ucuz", "ucuzdan pahalıya", "cheapest".',
    nearest: 'Closest to the user first: "bana en yakın", "yakınımda", "nearest", "closest".',
    none: 'Explicitly no particular order: "sıralama fark etmez", "any order".',
  });

  // Date: kind and parts (date-extraction cookbook). Code does the calendar math.
  questions.date = choice(`${context} Which date or days does the user want the events on? Read only what the message says.`, {
    ...edit('date', 'date'),
    today: 'Today or tonight: "bugün", "bu akşam", "bu gece", "today", "tonight" (also when another relative day follows as an alternative: "bugün ya da yarın").',
    tomorrow: 'Tomorrow: "yarın", "tomorrow" (also when another relative day follows as an alternative: "yarın ya da öbür gün").',
    day_after_tomorrow: 'The day after tomorrow: "öbür gün", "yarından sonra", "day after tomorrow".',
    days_later: 'One day a number of days from today: "iki gün sonra", "3 gün sonraki", "in 4 days", "5 days from now". The number is in `date_count`.',
    within_days: 'Any day from today up to a number of days ahead: "3 gün içinde", "önümüzdeki 5 gün", "within a week", "in the next 10 days". The number is in `date_count`.',
    weekday: 'A named day of the week: "cumartesi", "on Friday", "gelecek salı", "haftaya pazar". The day is in `date_weekday`, the week in `date_week`.',
    two_weekdays: 'Either of two weekday names: "cuma ya da cumartesi", "Friday or Saturday" (not relative words such as "yarın").',
    weekend: 'A weekend: "hafta sonu", "this weekend", "gelecek hafta sonu".',
    this_week: 'Any day of the current week: "bu hafta", "this week".',
    next_week: 'Any day of next week: "gelecek hafta", "haftaya", "next week".',
    calendar_date: 'One calendar day: "15 Ekim", "October 20", "20.10", or a day of this month without a month name ("ayın 20\'si", "on the 20th").',
    calendar_range: 'From one calendar day to another: "10-15 Ekim", "between 3 and 7 November", "20 Ekim\'den 25 Ekim\'e".',
    month: 'A whole month or part of one: "ekimde", "kasım sonu", "aralık başı", "early December".',
    past: 'A day before today: "dün", "geçen hafta", "yesterday".',
    other: 'Some other date wording that none of the options above describes.',
  });
  questions.date_alt = choice(`${context} If the message gives a second, alternative day in relative words ("yarın ya da öbür gün", "bugün veya yarın", "today or tomorrow"), which is the second day?`, {
    none: 'No second relative day.', today: 'Today.', tomorrow: 'Tomorrow.', day_after_tomorrow: 'The day after tomorrow.',
  });
  questions.date_count = choice(`${context} If the message counts days from today ("iki gün sonra", "3 gün içinde", "in 5 days"), how many days? "Bir hafta"/"a week" is 7, "iki hafta" is 14.`, { ...opts(range(1, 60)), none: 'No count of days is given.' });
  const weekdayOptions = { ...opts(WEEKDAYS.slice(1).concat('Sunday')), none: 'No weekday is named.' };
  questions.date_weekday = choice(`${context} Which day of the week does the message name for the events (the first one if several)?`, weekdayOptions);
  questions.date_weekday_2 = choice(`${context} If the message names a second, alternative day of the week ("cuma ya da cumartesi"), which one?`, weekdayOptions);
  questions.date_week = choice(`${context} If the message names a weekday or weekend, which week does it mean?`, {
    bare: 'No week word: "cumartesi", "on Saturday", "hafta sonu" — the coming one.',
    this: 'This week: "bu cumartesi", "this Saturday", "bu hafta sonu", "this weekend".',
    next: '"Gelecek/önümüzdeki cumartesi", "next Saturday", "next weekend", "gelecek hafta sonu".',
    following_week: 'Explicitly the following calendar week: "haftaya cumartesi", "Saturday next week", "gelecek haftanın cumartesi".',
  });
  questions.date_day = choice(`${context} If the message names a calendar date or the first day of a date range, which day of the month (1-31)?`, { ...opts(range(1, 31)), none: 'No day of the month is named.' });
  questions.date_month = choice(`${context} If the message names a calendar date, a month, or the first day of a date range, which month?`, { ...opts(MONTHS), none: 'No month is named.' });
  questions.date_day_end = choice(`${context} If the message names a range of calendar days, which day of the month ends it?`, { ...opts(range(1, 31)), none: 'No range end is named.' });
  questions.date_month_end = choice(`${context} If the message names a range of calendar days that ends in a different month, which month ends it?`, { ...opts(MONTHS), none: 'The range ends in the same month, or there is no range.' });
  questions.date_month_part = choice(`${context} If the message names a month, which part of it?`, {
    whole: 'The whole month: "ekimde", "in October".', start: 'The beginning: "ekim başı", "early October".',
    middle: 'The middle: "ekim ortası", "mid-October".', end: 'The end: "ekim sonu", "late October".',
  });
  questions.date_optional = optional('date');

  // Start time.
  questions.time = choice(`${context} What start time does the user want for the events?`, {
    ...edit('time', 'start time'),
    after: 'Starting after a clock time: "saat 8\'den sonra", "after 7 pm".',
    from: 'Starting at or after a clock time: "8\'den itibaren", "from 7", "en erken 19:00".',
    before: 'Starting before a clock time: "20:00\'den önce", "before 9".',
    until: 'Starting at the latest at a clock time: "en geç 21:00", "by 9 pm", "-e kadar".',
    between: 'Starting between two clock times: "19:00 ile 21:00 arası", "between 6 and 8 pm".',
    at: 'Starting exactly at a clock time: "saat 20:00\'de", "at 8 pm".',
    morning: 'In the morning: "sabah", "morning".',
    afternoon: 'In the afternoon: "öğleden sonra", "öğlen", "afternoon".',
    evening: 'In the evening or at night: "akşam", "gece", "evening", "tonight".',
  });
  const hours = opts(range(0, 23));
  questions.time_hour = choice(`${context} If the message names a clock time (the first one of a range), which hour is it on a 24-hour clock? Evening wording makes small hours afternoon/evening hours: "akşam 8" and "8 pm" are 20.`, { ...hours, none: 'No clock time is named.' });
  questions.time_minute = choice(`${context} If the message names a clock time (the first one of a range), which minute?`, { '00': 'On the hour or not stated.', '15': ':15', '30': ':30 or "buçuk"/"half past"', '45': ':45' });
  questions.time_hour_end = choice(`${context} If the message names a range of clock times, which hour ends it on a 24-hour clock? Evening wording makes small hours evening hours: "between 6 and 10 PM" ends at 22.`, { ...hours, none: 'No range of clock times.' });
  questions.time_minute_end = choice(`${context} If the message names a range of clock times, which minute ends it?`, { '00': 'On the hour or not stated.', '15': ':15', '30': ':30', '45': ':45' });
  questions.time_optional = optional('start time');

  // Place: the district is read by meaning, so unlisted neighbourhoods still resolve.
  questions.place = choice(`${context} Where in Istanbul does the user want the events? Places the user rules out are asked separately.`, {
    ...edit('location', 'place'),
    in: 'In or around one named Istanbul place: "Kadıköy\'de", "Taksim civarı", "near Bebek", "Avrupa yakasında".',
    either: 'In one of two or more named Istanbul places: "Kadıköy ya da Beşiktaş".',
    unknown: 'A wanted place is named, but it is not clear which part of Istanbul it is.',
  });
  questions.district = choice(`${context} Which Istanbul district is the (first) wanted place, or which district contains it? For example Taksim, Cihangir and Galata are in Beyoğlu; Moda and Fikirtepe in Kadıköy; Bebek and Ortaköy in Beşiktaş. Ignore places the user rules out.`, { ...opts(DISTRICTS), none: 'No district: no wanted place, or only a side of Istanbul (Avrupa/Anadolu yakası) is named.' });
  questions.district_2 = choice(`${context} If the message names a second, alternative wanted place, which district is it or contains it?`, { ...opts(DISTRICTS), none: 'No second place.' });
  questions.neighborhood = choice(`${context} Does the message name a wanted neighbourhood, street or area smaller than a district? Which one? Ignore places the user rules out.`, { ...opts(NEIGHBORHOODS), other: 'A smaller place that is not in this list.', none: 'No: only a district, a side, or no wanted place is named.' });
  questions.excluded_district = choice(`${context} Does the user rule out a whole Istanbul district ("Kadıköy dışında", "Şişli olmasın", "not in Beşiktaş")? Which one? A place being replaced ("X yerine Y", "Y instead of X") is not ruled out.`, { ...opts(DISTRICTS), none: 'No district is ruled out, or only a smaller place is.' });
  questions.excluded_neighborhood = choice(`${context} Does the user rule out a neighbourhood or area smaller than a district ("Taksim'de olmasın", "Taksim'i hariç tut", "not in Moda")? Which one? A place being replaced ("X yerine Y", "Y instead of X") is not ruled out.`, { ...opts(NEIGHBORHOODS), none: 'No smaller place is ruled out.' });
  questions.side = choice(`${context} Does the message limit the events to one side of Istanbul?`, { europe: 'European side: "Avrupa yakası", "European side".', asia: 'Asian side: "Anadolu yakası", "Asian side".', none: 'No side is named.' });
  questions.place_optional = optional('place');

  // Price: amounts are selected from the numbers found in the message.
  questions.budget = choice(`${context} What price limit does the user set for tickets?`, {
    ...edit('budget', 'price'),
    max: 'At most an amount / up to / does not exceed / a budget of / can spend: "en fazla 500 TL", "500 liraya kadar", "500 TL\'yi geçmesin", "aşmasın", "bütçem 1000", "max 500", or a plain amount with no comparison word ("1000 tl kişi başı").',
    under: 'Strictly under an amount: "500 TL altı", "500 TL altında", "500\'den ucuz", "500\'den az", "under 500", "less than 500".',
    min: 'At least an amount: "en az 300 TL".',
    over: 'More than an amount: "300 TL üstü", "over 300".',
    around: 'About an amount: "500 TL civarı", "around 500". "Civarı"/"around" changes only the word right before it: "Taksim civarı" is about a place, not the price.',
    between: 'Between two amounts: "300 ile 600 TL arası", "300-600 TL".',
    free: 'Free events only: "ücretsiz", "bedava", "free".',
    vague: 'Cheap or affordable without an amount: "ucuz", "uygun fiyatlı", "affordable".',
  });
  questions.budget_amount = choice(`${context} Which number in \`numbersInMessage\` is the price amount? For a single limit ("üst sınır 900", "max 900", "en fazla 500") it is that amount; for a range of two amounts, the lower one.`, numberOptions('No price amount is given.'));
  questions.budget_amount_2 = choice(`${context} Only when the message gives two amounts as a price range ("300 ile 600 arası"): which number in \`numbersInMessage\` is the upper end?`, numberOptions('No range of two amounts.'));
  questions.budget_basis = choice(`${context} What does the price amount apply to, according to the wording? Do not guess from the number of attendees.`, {
    per_person: 'Each person: "kişi başı", "per person", "kişi başına".',
    per_ticket: 'Each ticket: "bilet başına", "per ticket", "bilet fiyatı".',
    group_total: 'The whole group: "toplam", "total", "hepimiz için", "ikimiz için".',
    unstated: 'The wording does not say.',
  });
  questions.budget_currency = choice(`${context} In which currency is the price amount?`, { lira: 'Turkish lira, or no currency named: "TL", "lira", "₺".', other: 'Another currency: dollars, euros, pounds.' });
  questions.budget_optional = optional('price');

  // Attendees.
  questions.party = choice(`${context} Does the message state how many people will attend? Only a stated number counts: going with a partner, "istiyorum", "bul" or "we" state no number.`, {
    ...edit('party', 'number of people'),
    total: 'A number of attendees, also as a new total: "iki kişilik", "3 kişiyiz", "üç kişi olacağız", "dört değil üç kişi", "for four", "tek başıma" (1). The number is in `party_count`.',
    more: 'Some people join the current group, given as how many join: "iki kişi daha geliyor", "two more are coming".',
    fewer: 'Some of the current group drop out, given as how many: "bir kişi gelemiyor", "one cannot come".',
  });
  questions.party_count = choice(`${context} If the message states a number of attendees, what is it? If it says how many people join or drop out, how many?`, { ...opts(range(1, 20)), none: 'No number of people.' });
  questions.age = choice(`${context} Which number in \`numbersInMessage\` is the age of someone attending ("7 yaşında", "12-year-old")?`, numberOptions('No age is given.'));
  for (const [value, text] of Object.entries(COMPANIONS)) {
    const was = previousValues(previous, 'companion').has(value);
    questions[`companion_${value}`] = choice(`${context} Does the user say they will attend with ${text}?`, {
      no: was ? 'The message does not change this.' : 'No, or not mentioned.',
      yes: 'Yes.',
      ...(was ? { removed: 'They will no longer come.' } : {}),
    });
  }

  // Event types, topics, experiences, content and moods: one judgment per item.
  const item = (kind: Kind, value: string, text: string, opposite = false, note = '') => {
    const was = previousValues(previous, kind).has(value);
    return choice(`${context} Does the message itself name ${text}? Judge only its words: a related item, the companion or the occasion does not count, and excluding something else does not exclude this.${note}`, {
      no: 'The message does not name it.',
      want: opposite ? 'The user requires it, or rules out its opposite ("kalabalık olmasın" requires uncrowded).' : 'The user asks for it, or accepts it as one of the options.',
      optional: 'The user would only like it: "olsa iyi olur", "tercihen", "tercih ederim", "ideally", "I prefer", "as a preference".',
      exclude: 'The user rules it out: "olmasın", "hariç", "dışında", "istemiyorum", "olmayan", "no", "not", "except".',
      ...(was ? { removed: 'The user drops it from the current search: "konser koşulunu kaldır", "remove the concert condition", "artık şart değil".' } : {}),
    });
  };
  for (const [value, text] of Object.entries(CATEGORIES)) questions[`category_${value}`] = item('category', value, `the event type ${text}`, false, ' A topic or genre alone ("caz", "jazz", "fotoğrafçılık") does not name an event type.');
  questions.dance_activity = noulQ(`${context} Does the user want to dance themselves, rather than watch a dance or ballet performance?`);
  const topics = Object.keys(TOPIC_TERMS);
  const topicOptions = { ...opts(topics, (t) => `${t} (${TOPIC_TERMS[t].slice(0, 3).join(', ')})`), other: 'Another topic or genre not in this list.', none: 'No topic or genre.' };
  const topicNote = 'An event type itself (stand-up, concert, theatre, workshop, course) is not a topic, and "tarih" meaning a date is not history.';
  questions.topic = choice(`${context} Which topic or genre does the message name for the events (the first one)? ${topicNote}`, topicOptions);
  questions.topic_2 = choice(`${context} If the message names a second topic or genre, which one? ${topicNote}`, topicOptions);
  questions.topics_both = noulQ(`${context} If the message names two topics or genres, must one event have both ("hem caz hem fotoğrafçılık", "both jazz and photography") rather than either one?`);
  questions.topic_role = choice(`${context} How does the message treat the topic or genre it names? ${topicNote}`, {
    want: 'The user asks for it.', optional: 'The user would only like it: "tercihen", "olsa iyi olur", "as a preference", "I prefer".', exclude: 'The user rules it out.',
    ...(has('topic') ? { removed: 'The user drops the current topic.' } : {}),
    none: 'No topic or genre is named.',
  });
  for (const [value, text] of Object.entries(EXPERIENCES)) questions[`experience_${value}`] = item('experience', value, text, true);
  for (const [value, text] of Object.entries(CONTENT)) questions[`content_${value}`] = item('content', value, text);
  for (const [value, text] of Object.entries(MOODS)) questions[`mood_${value}`] = item('mood', value, text);
  questions.quiet_required = noulQ(`${context} Does the user make a quiet or calm environment a firm requirement ("kesinlikle sessiz", "must be quiet"), rather than a mood for the outing?`);
  questions.beginner_guarantee = noulQ(`${context} Does the user require an explicit confirmation that no prior experience is needed, rather than just prefer beginner-friendly events?`);

  return { state, questions, numbers, previous };
}

export type FieldRequest = ReturnType<typeof buildFieldRequest>;

function validAnswers(questions: Record<string, Question>, response: JevResponse): boolean {
  if (!response?.answers || typeof response.answers !== 'object') return false;
  const probability = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
  return Object.entries(questions).every(([id, question]) => {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type) return false;
    if (question.type === 'noul') return answer.type === 'noul' && probability(answer.noul);
    return answer.type === 'choice' && Object.hasOwn(question.criteria, answer.choice) && probability(answer.confidence)
      && Boolean(answer.probabilities) && Object.entries(answer.probabilities).every(([key, p]) => Object.hasOwn(question.criteria, key) && probability(p));
  });
}

class Unreadable extends Error {}

export function composeFields(input: ParserInput, built: FieldRequest, response: JevResponse): ParseResult {
  const a = response.answers;
  const debug: Debug = {
    mentions: [],
    answers: Object.fromEntries(Object.entries(a ?? {}).map(([k, v]) => [k, v.type === 'choice'
      ? Object.entries(v.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 2).filter(([, p], i) => i === 0 || p >= 0.1).map(([o, p]) => `${o}:${p.toFixed(2)}`).join('/')
      : (v as NoulAnswer).noul.toFixed(2)])),
    usage: response.usage,
  };
  const whole = [{ start: 0, end: input.utterance.length, text: input.utterance }];
  const refuse = (reason: string): ParseResult => ({ status: 'unsupported', reason, unresolvedSpans: whole, debug });
  if (!validAnswers(built.questions, response)) return refuse('invalid or incomplete provider judgments');
  const pick = (id: string) => (a[id] as ChoiceAnswer).choice;
  const dist = (id: string) => (a[id] as ChoiceAnswer).probabilities;
  const noul = (id: string) => (a[id] as NoulAnswer).noul;
  const numberAt = (id: string) => {
    const ref = pick(id);
    return ref === 'none' ? null : built.numbers[Number(ref.slice(1))]?.value ?? null;
  };

  if (noul('outside_istanbul') > 0.5) return refuse('unsupported outside_location');
  if ((dist('unsupported').unsupported ?? 0) > 0.6) return refuse('condition outside supported vocabulary');

  const today = new Date(`${input.referenceDate}T12:00:00Z`);
  const ref = input.referenceDate;
  const reset = input.previousState ? (dist('reset').reset ?? 0) >= 0.8 : false;
  const basePrevious = reset ? [] : built.previous;

  // Alternatives come only from designated ambiguities: budget basis and "next <weekday>".
  type Slot = { options: unknown[] };
  const slots: Slot[] = [];
  const slot = (key: string, options: unknown[], registry: Map<string, number>) => {
    if (!registry.has(key)) registry.set(key, slots.push({ options }) - 1);
    return registry.get(key)!;
  };
  const registry = new Map<string, number>();

  const build = (choose: (slot: number) => unknown): Plan => {
    // A vague reference ("onu kaldır") acts on one current condition; several
    // plausible referents become alternatives. Field-level edits then defer to it.
    let previous = basePrevious;
    let vague = false;
    if (basePrevious.length && built.questions.vague && noul('vague') > 0.4) {
      const scores = basePrevious.map((_, i) => noul(`refers_${i}`));
      const top = Math.max(...scores);
      const action = pick('vague_action');
      const targets = scores.flatMap((s, i) => s >= Math.max(0.25, top - 0.15)
        && !(action === 'make_required' && !basePrevious[i].preferred) && !(action === 'make_preferred' && basePrevious[i].preferred) ? [i] : []);
      if (targets.length) {
        vague = true;
        const target = targets.length > 1 ? choose(slot('vague', targets, registry)) as number : targets[0];
        previous = basePrevious.flatMap((x, i) => i !== target ? [x]
          : action === 'remove' ? []
          : action === 'make_preferred' || action === 'make_required' ? [{ ...x, preferred: action === 'make_preferred' }]
          : [x]);
      }
    }
    // Under a vague reference, field-level edits and unreadable values defer to it.
    const fieldPick = (id: string) => { const v = pick(id); return vague && ['remove', 'same', 'other', 'unknown', 'past'].includes(v) ? 'none' : v; };
    // Field results: undefined = unchanged, [] = removed, otherwise new conditions.
    const fields = new Map<string, Array<{ condition: Condition; preferred: boolean }>>();
    const strength = (id: string) => noul(id) > 0.5;
    const sameStrength = (kinds: Kind[], optionalId: string) => {
      // Strength change of an existing condition without a new value.
      const preferred = strength(optionalId);
      return previous.filter((x) => kinds.includes(x.kind)).map((x) => ({ condition: x.condition, preferred }));
    };

    // --- Date.
    const nextWeekday = (day: number, skip: boolean) => addDays(today, (day - today.getUTCDay() + 7) % 7 + (skip ? 7 : 0));
    const weekdayIndex = (name: string) => WEEKDAYS.indexOf(name);
    const weekdayDate = (day: number, week: string): Date => {
      if (week === 'following_week') return nextWeekday(day, true);
      if (week === 'next') {
        const near = nextWeekday(day, false), far = addDays(near, 7);
        const inThisWeek = (near.getTime() - today.getTime()) / 86400000 < 7 - ((today.getUTCDay() + 6) % 7);
        if (inThisWeek && iso(near) !== ref) return choose(slot(`next_${day}`, [near, far], registry)) as Date;
        return iso(near) === ref ? far : near;
      }
      return nextWeekday(day, false);
    };
    const resolveYear = (month: number, day: number) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), month - 1, day, 12));
      if (d.getUTCMonth() !== month - 1) throw new Unreadable('date');
      return iso(d) < ref && today.getTime() - d.getTime() > 60 * 86400000 ? new Date(Date.UTC(today.getUTCFullYear() + 1, month - 1, day, 12)) : d;
    };
    const dateKind = fieldPick('date');
    let dates: Array<{ from: Date; to: Date }> | null = null;
    const count = pick('date_count') === 'none' ? null : Number(pick('date_count'));
    const month = MONTHS.indexOf(pick('date_month')) + 1;
    const day = pick('date_day') === 'none' ? null : Number(pick('date_day'));
    switch (dateKind) {
      case 'today': dates = [{ from: today, to: today }]; break;
      case 'tomorrow': dates = [{ from: addDays(today, 1), to: addDays(today, 1) }]; break;
      case 'day_after_tomorrow': dates = [{ from: addDays(today, 2), to: addDays(today, 2) }]; break;
      case 'days_later': if (!count) throw new Unreadable('date'); dates = [{ from: addDays(today, count), to: addDays(today, count) }]; break;
      case 'within_days': if (!count) throw new Unreadable('date'); dates = [{ from: today, to: addDays(today, count) }]; break;
      case 'weekday': case 'two_weekdays': {
        const names = [pick('date_weekday'), ...(dateKind === 'two_weekdays' ? [pick('date_weekday_2')] : [])];
        if (names.some((n) => n === 'none')) throw new Unreadable('date');
        dates = names.map((n) => { const d = weekdayDate(weekdayIndex(n), pick('date_week')); return { from: d, to: d }; });
        break;
      }
      case 'weekend': {
        const week = pick('date_week');
        const saturday = week === 'this' && today.getUTCDay() === 0 ? addDays(today, -1) : weekdayDate(6, week);
        dates = [{ from: saturday < today ? today : saturday, to: addDays(saturday, 1) }];
        break;
      }
      case 'this_week': dates = [{ from: today, to: nextWeekday(0, false) }]; break;
      case 'next_week': {
        const monday = nextWeekday(1, false);
        const start = iso(monday) === ref ? addDays(monday, 7) : monday;
        dates = [{ from: start, to: addDays(start, 6) }];
        break;
      }
      case 'calendar_date': {
        if (!day) throw new Unreadable('date');
        let d: Date;
        if (month) d = resolveYear(month, day);
        else {
          // A day of the month without a month: this month, or next month once it has passed.
          d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), day, 12));
          if (iso(d) < ref) d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, day, 12));
          if (d.getUTCDate() !== day) throw new Unreadable('date');
        }
        dates = [{ from: d, to: d }];
        break;
      }
      case 'calendar_range': {
        const endDay = pick('date_day_end') === 'none' ? null : Number(pick('date_day_end'));
        const endMonth = pick('date_month_end') === 'none' ? month : MONTHS.indexOf(pick('date_month_end')) + 1;
        if (!month || !day || !endDay) throw new Unreadable('date');
        const from = resolveYear(month, day);
        let to = new Date(Date.UTC(from.getUTCFullYear(), endMonth - 1, endDay, 12));
        if (to < from) to = new Date(Date.UTC(from.getUTCFullYear() + 1, endMonth - 1, endDay, 12));
        dates = [{ from, to }];
        break;
      }
      case 'month': {
        if (!month) throw new Unreadable('date');
        const year = resolveYear(month, 28).getUTCFullYear();
        const last = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
        const [first, final] = { whole: [1, last], start: [1, 10], middle: [11, 20], end: [21, last] }[pick('date_month_part') as 'whole'];
        let from = new Date(Date.UTC(year, month - 1, first, 12));
        const to = new Date(Date.UTC(year, month - 1, final, 12));
        if (iso(to) < ref) return refusePlan('past date');
        if (iso(from) < ref) from = today;
        dates = [{ from, to }];
        break;
      }
      case 'past': return refusePlan('past date');
      case 'other': throw new Unreadable('date');
    }
    const alt = pick('date_alt');
    if (dates && dates.length === 1 && ['today', 'tomorrow', 'day_after_tomorrow'].includes(dateKind) && alt !== 'none') {
      const d = addDays(today, { today: 0, tomorrow: 1, day_after_tomorrow: 2 }[alt as 'today']);
      if (iso(d) !== iso(dates[0].from)) dates.push({ from: d, to: d });
    }
    if (dates) {
      if (dates.some((d) => iso(d.to) < ref)) return refusePlan('past date');
      const atoms = dates.map((d) => ({ type: 'atom' as const, atom: { kind: 'date' as const, from: iso(d.from), to: iso(d.to) } }));
      fields.set('date', [{ condition: atoms.length > 1 ? { type: 'any', children: atoms } : atoms[0], preferred: strength('date_optional') }]);
    } else if (dateKind === 'remove') fields.set('date', []);
    else if (dateKind === 'same') fields.set('date', sameStrength(['date'], 'date_optional'));

    // --- Start time.
    const timeKind = fieldPick('time');
    const clock = (h: string, m: string) => h === 'none' ? null : `${h.padStart(2, '0')}:${m}`;
    const t1 = clock(pick('time_hour'), pick('time_minute')), t2 = clock(pick('time_hour_end'), pick('time_minute_end'));
    const periods: Record<string, [string, string]> = { morning: ['06:00', '11:59'], afternoon: ['12:00', '17:59'], evening: ['18:00', '23:59'] };
    let time: Extract<Atom, { kind: 'time' }> | null = null;
    if (periods[timeKind]) time = { kind: 'time', from: periods[timeKind][0], to: periods[timeKind][1] };
    else if (['after', 'from', 'before', 'until', 'at', 'between'].includes(timeKind)) {
      if (!t1 || (timeKind === 'between' && !t2)) throw new Unreadable('time');
      time = timeKind === 'after' ? { kind: 'time', from: t1, fromExclusive: true }
        : timeKind === 'from' ? { kind: 'time', from: t1 }
        : timeKind === 'before' ? { kind: 'time', to: t1, toExclusive: true }
        : timeKind === 'until' ? { kind: 'time', to: t1 }
        : timeKind === 'at' ? { kind: 'time', from: t1, to: t1 }
        : t1 <= t2! ? { kind: 'time', from: t1, to: t2! } : (() => { throw new Unreadable('time'); })();
    }
    if (time) fields.set('time', [{ condition: { type: 'atom', atom: time }, preferred: strength('time_optional') }]);
    else if (timeKind === 'remove') fields.set('time', []);
    else if (timeKind === 'same') fields.set('time', sameStrength(['time'], 'time_optional'));

    // --- Place. Neighbourhoods map to their district through the shared place table.
    let placeKind = fieldPick('place');
    // Confident place parts outweigh a missed presence answer when nothing is being edited.
    if (placeKind === 'none' && !previous.some((x) => x.kind === 'location')
      && ((dist('district')[pick('district')] ?? 0) >= 0.8 && pick('district') !== 'none' || (pick('neighborhood') !== 'none' && pick('neighborhood') !== 'other' && (dist('neighborhood')[pick('neighborhood')] ?? 0) >= 0.6)))
      placeKind = 'in';
    const placeEntries = (negated: boolean) => previous.filter((x) => x.kind === 'location' && (x.condition.type === 'not') === negated)
      .map((x) => ({ condition: x.condition, preferred: x.preferred }));
    let wantedPlaces = placeEntries(false), excludedPlaces = placeEntries(true), placeChanged = false;
    const excludedNeighborhood = pick('excluded_neighborhood'), excludedDistrict = pick('excluded_district');
    if (placeKind === 'in' || placeKind === 'either') {
      const preferred = strength('place_optional');
      const out: Array<{ condition: Condition; preferred: boolean }> = [];
      const neighborhood = pick('neighborhood');
      const listed = neighborhood !== 'none' && neighborhood !== 'other' && neighborhood !== excludedNeighborhood ? neighborhood : null;
      const listedPlace = listed ? placeOf(fold(listed).trim()) : null;
      const districtOf = (name: string) => name === 'none' ? null : name;
      let district = districtOf(pick('district'));
      if (listedPlace?.district) district = DISTRICTS.find((d) => fold(d) === listedPlace.district) ?? district;
      const side = pick('side');
      const area = (name: string | null): Atom | null => name ? { kind: 'location', name, precision: 'district' }
        : side !== 'none' ? { kind: 'location', name: side === 'asia' ? 'Anadolu yakası' : 'Avrupa yakası', precision: 'side' }
        : listedPlace?.side ? { kind: 'location', name: listedPlace.side === 'asia' ? 'Anadolu yakası' : 'Avrupa yakası', precision: 'side' } : null;
      const first = area(district);
      if (!first) throw new Unreadable('place');
      const second = placeKind === 'either' ? area(districtOf(pick('district_2'))) : null;
      if (placeKind === 'either' && !second) throw new Unreadable('place');
      const condition: Condition = second && JSON.stringify(second) !== JSON.stringify(first)
        ? { type: 'any', children: [{ type: 'atom', atom: first }, { type: 'atom', atom: second }] }
        : { type: 'atom', atom: first };
      out.push({ condition, preferred });
      // Events record districts, not neighbourhoods: the neighbourhood ranks results.
      if (listed && placeKind === 'in') out.push({ condition: { type: 'atom', atom: { kind: 'location', name: listed, precision: 'neighborhood' } }, preferred: true });
      wantedPlaces = out;
      placeChanged = true;
    } else if (placeKind === 'unknown') throw new Unreadable('place');
    else if (placeKind === 'remove') { wantedPlaces = []; excludedPlaces = []; placeChanged = true; }
    else if (placeKind === 'same') { wantedPlaces = wantedPlaces.map((x) => ({ ...x, preferred: strength('place_optional') })); placeChanged = true; }
    // A ruled-out neighbourhood excludes only itself, not its whole district.
    const excluded: Atom | null = excludedNeighborhood !== 'none' ? { kind: 'location', name: excludedNeighborhood, precision: 'neighborhood' }
      : excludedDistrict !== 'none' ? { kind: 'location', name: excludedDistrict, precision: 'district' } : null;
    if (excluded) { excludedPlaces = [...excludedPlaces, { condition: { type: 'not', child: { type: 'atom', atom: excluded } }, preferred: false }]; placeChanged = true; }
    if (placeChanged) fields.set('location', [...wantedPlaces, ...excludedPlaces]);

    // --- Attendees (needed before the budget basis default).
    const partyKind = fieldPick('party');
    const partyCount = pick('party_count') === 'none' ? null : Number(pick('party_count'));
    const oldParty = previous.flatMap((x) => atomsOf(x.condition)).find((x) => x.kind === 'party');
    if (partyKind === 'total' || partyKind === 'more' || partyKind === 'fewer') {
      if (!partyCount) throw new Unreadable('party');
      const base = oldParty?.kind === 'party' ? oldParty.count : null;
      const total = partyKind === 'total' ? partyCount : base === null ? null : base + (partyKind === 'more' ? partyCount : -partyCount);
      if (!total || total < 1) throw new Unreadable('party');
      fields.set('party', [{ condition: { type: 'atom', atom: { kind: 'party', count: total } }, preferred: false }]);
    } else if (partyKind === 'remove') fields.set('party', []);
    const age = numberAt('age');
    if (age !== null && Number.isInteger(age) && age >= 0 && age <= 120)
      fields.set('age', [{ condition: { type: 'atom', atom: { kind: 'age', years: age } }, preferred: false }]);

    // --- Per-item fields.
    type Role = 'want' | 'optional' | 'exclude';
    const itemField = (kind: Kind, values: string[], answer: (value: string) => string, atom: (value: string) => Atom | null) => {
      const before = previousValues(previous, kind);
      const after = new Map(before);
      let changed = false;
      for (const value of values) {
        const r = vague && answer(value) === 'removed' ? 'no' : answer(value);
        if (r === 'no') continue;
        changed = true;
        if (r === 'removed') after.delete(value); else after.set(value, r as Role);
      }
      if (!changed) return;
      const out: Array<{ condition: Condition; preferred: boolean }> = [];
      const group = (role: Role) => [...after].filter(([, r]) => r === role).map(([v]) => atom(v)).filter((x): x is Atom => x !== null)
        .map((x) => ({ type: 'atom' as const, atom: x }));
      const any = (children: Condition[]): Condition => children.length > 1 ? { type: 'any', children } : children[0];
      // One event has one type or topic: wanted options are alternatives.
      const alternatives = kind === 'category' || kind === 'topic' || kind === 'location';
      for (const role of ['want', 'optional'] as const) {
        const children = group(role);
        if (!children.length) continue;
        if (alternatives) out.push({ condition: any(children), preferred: role === 'optional' });
        else for (const child of children) out.push({ condition: child, preferred: role === 'optional' });
      }
      const excluded = group('exclude');
      if (excluded.length) out.push({ condition: { type: 'not', child: any(excluded) }, preferred: false });
      fields.set(kind, out);
    };
    const specific = ['concert', 'theatre', 'standup', 'dance'].some((v) => ['want', 'optional'].includes(pick(`category_${v}`)));
    itemField('category', Object.keys(CATEGORIES), (v) => v === 'show' && specific && pick('category_show') !== 'exclude' ? 'no' : pick(`category_${v}`), (v) => v === 'dance' && noul('dance_activity') > 0.5 ? null : { kind: 'category', value: v as Category });
    if (pick('category_dance') !== 'no' && pick('category_dance') !== 'removed' && noul('dance_activity') > 0.5) {
      const topic = { condition: { type: 'atom' as const, atom: { kind: 'topic' as const, value: 'dancing' } }, preferred: pick('category_dance') === 'optional' };
      fields.set('topic', [...(fields.get('topic') ?? []), topic]);
    }
    const roleDist = dist('topic_role');
    let topicRole = vague && pick('topic_role') === 'removed' ? 'none' : pick('topic_role');
    if (topicRole === 'none' && pick('topic') !== 'none' && pick('topic') !== 'other')
      topicRole = (['want', 'optional', 'exclude'] as const).reduce((a, b) => (roleDist[b] ?? 0) > (roleDist[a] ?? 0) ? b : a);
    const named = [pick('topic'), pick('topic_2')].filter((t) => t !== 'none' && t !== 'other');
    if (topicRole === 'removed') fields.set('topic', []);
    else if (topicRole !== 'none' && named.length) {
      const children = [...new Set(named)].map((value) => ({ type: 'atom' as const, atom: { kind: 'topic' as const, value } }));
      const both = children.length > 1 && topicRole !== 'exclude' && noul('topics_both') > 0.5;
      const condition: Condition = children.length > 1 ? { type: 'any', children } : children[0];
      if (both) fields.set('topic', [...(fields.get('topic') ?? []), ...children.map((child) => ({ condition: child as Condition, preferred: topicRole === 'optional' }))]);
      else fields.set('topic', [...(fields.get('topic') ?? []), topicRole === 'exclude' ? { condition: { type: 'not', child: condition }, preferred: false } : { condition, preferred: topicRole === 'optional' }]);
    }
    itemField('companion', Object.keys(COMPANIONS), (v) => ({ no: 'no', yes: 'want', removed: 'removed' } as Record<string, string>)[pick(`companion_${v}`)], (v) => ({ kind: 'companion', value: v as 'partner' }));
    itemField('experience', Object.keys(EXPERIENCES), (v) => pick(`experience_${v}`), (v) => ({ kind: 'experience', value: v as 'quiet' }));
    itemField('content', Object.keys(CONTENT), (v) => pick(`content_${v}`), (v) => ({ kind: 'content', value: v as 'profanity' }));
    itemField('mood', Object.keys(MOODS), (v) => pick(`mood_${v}`), (v) => ({ kind: 'mood', value: v as 'calm' }));
    // Product policy: providers never state subjective qualities, so these rank instead of filter.
    for (const kind of ['experience', 'mood'] as const) {
      const list = fields.get(kind);
      if (!list) continue;
      fields.set(kind, list.flatMap((x) => {
        if (x.condition.type !== 'atom' || x.preferred) return [x];
        const atom = x.condition.atom;
        if (atom.kind === 'experience' && atom.value === 'romantic') return [{ ...x, preferred: true }];
        if (atom.kind === 'experience' && atom.value === 'beginner_friendly' && noul('beginner_guarantee') < 0.5) return [{ ...x, preferred: true }];
        if (atom.kind === 'mood') {
          if (atom.value === 'calm' && noul('quiet_required') >= 0.5) return [{ condition: { type: 'atom', atom: { kind: 'experience', value: 'quiet' } }, preferred: false }];
          return [{ ...x, preferred: true }];
        }
        return [x];
      }));
    }

    // --- Price.
    const budgetKind = fieldPick('budget');
    const oldBudget = previous.flatMap((x) => atomsOf(x.condition)).find((x) => x.kind === 'budget');
    if (['max', 'under', 'min', 'over', 'around', 'between', 'free'].includes(budgetKind)) {
      if (budgetKind !== 'free' && pick('budget_currency') === 'other') return refusePlan('unsupported amount');
      const groupDescribed = fields.has('party') || fields.has('companion') || previous.some((x) => x.kind === 'party' || x.kind === 'companion');
      const stated = pick('budget_basis');
      const basis = (budgetKind === 'free' ? 'per_person'
        : stated !== 'unstated' ? stated
        : oldBudget?.kind === 'budget' ? oldBudget.basis
        : !groupDescribed ? 'per_ticket'
        : choose(slot('basis', ['per_person', 'per_ticket', 'group_total'], registry))) as 'per_person';
      const preferred = strength('budget_optional');
      const atom = (comparison: 'lt' | 'lte' | 'gt' | 'gte' | 'approx', amount: number): Condition => ({ type: 'atom', atom: { kind: 'budget', comparison, amount, currency: 'TRY', basis } });
      if (budgetKind === 'free') fields.set('budget', [{ condition: atom('lte', 0), preferred }]);
      else {
        // A single limit read as a range end is still the amount.
        const amount = numberAt('budget_amount') ?? (budgetKind !== 'between' ? numberAt('budget_amount_2') : null);
        if (amount === null) throw new Unreadable('budget');
        if (budgetKind === 'between') {
          const high = numberAt('budget_amount_2');
          if (high === null) throw new Unreadable('budget');
          fields.set('budget', [{ condition: atom('gte', Math.min(amount, high)), preferred }, { condition: atom('lte', Math.max(amount, high)), preferred }]);
        } else {
          const comparison = ({ max: 'lte', under: 'lt', min: 'gte', over: 'gt', around: 'approx' } as const)[budgetKind as 'max'];
          fields.set('budget', [{ condition: atom(comparison, amount), preferred }]);
        }
      }
    } else if (budgetKind === 'remove') fields.set('budget', []);
    else if (budgetKind === 'same') {
      // A basis-only edit ("kişi başı değil toplam") keeps the amount.
      const stated = pick('budget_basis');
      fields.set('budget', previous.filter((x) => x.kind === 'budget').map((x) => ({
        condition: stated === 'unstated' ? x.condition : mapAtoms(x.condition, (atom) => atom.kind === 'budget' ? { ...atom, basis: stated as 'per_person' } : atom),
        preferred: strength('budget_optional'),
      })));
    }

    // --- Compose: unchanged fields keep their previous conditions.
    const hard: Condition[] = [], preferences: Condition[] = [];
    const order: Kind[] = ['date', 'time', 'location', 'party', 'age', 'companion', 'topic', 'mood', 'experience', 'content', 'category', 'budget'];
    for (const kind of order) {
      const next = fields.get(kind);
      const list = next ?? previous.filter((x) => x.kind === kind).map((x) => ({ condition: x.condition, preferred: x.preferred }));
      for (const x of list) (x.preferred ? preferences : hard).push(stripIds(x.condition));
    }
    const sort = pick('order');
    const currentOrder = reset ? 'none' : input.previousState?.plan.order ?? 'none';
    const planOrder = (sort === 'unchanged' ? currentOrder : sort) as Order;
    return { hard: { type: 'all', children: hard }, preferences, order: planOrder };
  };

  // Each slot combination yields one plan; distinct plans become alternatives.
  const plans: Plan[] = [];
  const seen = new Set<string>();
  let refusal: string | null = null;
  const run = (chosen: number[]) => {
    const plan = build((s) => slots[s].options[chosen[s] ?? 0]);
    if (isRefusal(plan)) { refusal = plan.reason; return; }
    const key = JSON.stringify(plan);
    if (!seen.has(key)) { seen.add(key); plans.push(plan); }
  };
  try {
    run([]);
    if (refusal) return refuse(refusal);
    const combos = (index: number, chosen: number[]): void => {
      if (plans.length >= 8) return;
      if (index === slots.length) { run(chosen); return; }
      for (let k = 0; k < slots[index].options.length; k++) combos(index + 1, [...chosen, k]);
    };
    if (slots.length) { plans.length = 0; seen.clear(); combos(0, []); }
  } catch (error) {
    if (error instanceof Unreadable) return { status: 'unsupported', reason: `unreadable ${error.message}`, unresolvedSpans: whole, debug };
    throw error;
  }
  const interpretations: Interpretation[] = [];
  for (const plan of plans) {
    const operations = operationsFor(input, reset, plan);
    try { interpretations.push({ operations, resultingPlan: applyOperations(input.previousState, operations) }); } catch { /* invalid branch */ }
  }
  if (!interpretations.length) return refuse('no valid interpretation');
  if (interpretations.length === 1) return { status: 'accepted', ...interpretations[0], debug };
  return { status: 'ambiguous', alternatives: interpretations, reason: 'designated ambiguity', debug };
}

// A refusal travels through `build` as a plan-shaped marker.
type Refusal = Plan & { refusal: true; reason: string };
function refusePlan(reason: string): Refusal {
  return { hard: { type: 'all', children: [] }, preferences: [], order: 'none', refusal: true, reason };
}
const isRefusal = (plan: Plan): plan is Refusal => (plan as Refusal).refusal === true;

function stripIds(c: Condition): Condition {
  if (c.type === 'atom') return { type: 'atom', atom: c.atom };
  if (c.type === 'not') return { type: 'not', child: stripIds(c.child) };
  return { type: c.type, children: c.children.map(stripIds) };
}
function mapAtoms(c: Condition, f: (atom: Atom) => Atom): Condition {
  if (c.type === 'atom') return { type: 'atom', atom: f(c.atom) };
  if (c.type === 'not') return { type: 'not', child: mapAtoms(c.child, f) };
  return { type: c.type, children: c.children.map((child) => mapAtoms(child, f)) };
}

/** Operations that turn the previous plan into `plan`: keep identical conditions, remove the rest, add new ones. */
function operationsFor(input: ParserInput, reset: boolean, plan: Plan): Operation[] {
  const ops: Operation[] = [];
  const prev = reset ? null : input.previousState?.plan ?? null;
  if (reset) ops.push({ op: 'reset' });
  const key = (c: Condition, preferred: boolean) => `${preferred}:${JSON.stringify(stripIds(c))}`;
  const wanted = [...(plan.hard.type === 'all' ? plan.hard.children : []).map((c) => key(c, false)), ...plan.preferences.map((c) => key(c, true))];
  const kept = new Set<string>();
  for (const x of items(prev)) {
    const k = key(x.condition, x.preferred);
    if (wanted.includes(k) && !kept.has(k)) kept.add(k);
    else ops.push({ op: 'remove', targetId: x.condition.id! });
  }
  for (const [list, strength] of [[plan.hard.type === 'all' ? plan.hard.children : [], 'hard'], [plan.preferences, 'preferred']] as const)
    for (const c of list) if (!kept.has(key(c, strength === 'preferred'))) ops.push({ op: 'add', strength, condition: c });
  const currentOrder = prev?.order ?? 'none';
  if (plan.order !== currentOrder) ops.push({ op: 'order', value: plan.order });
  return ops;
}
