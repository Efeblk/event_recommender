import type { IntentState } from './input-state.ts';
import {
  findInputSpellingCandidates,
  type InputSpellingCandidate,
} from './input-spelling.ts';
import { addDays, todayInIstanbul, validDay } from './search.ts';
import { harvestInputPropositions, type InputPropositionScope } from './input-propositions.ts';

export interface Span<T> {
  id: string;
  text: string;
  value: T;
  sourceSpans?: Array<{ start: number; end: number }>;
  scope?: InputPropositionScope;
  sourceMessage?: 'current' | 'pending';
  role?: 'optional-location';
  operation?: { kind: 'delta'; delta: number };
}
export type NumberSpan = Span<number>;
export interface DateValue {
  dateFrom: string;
  dateTo: string;
}
export interface TimeValue {
  startTimeFrom?: string;
  startTimeTo?: string;
  startTimeFromExclusive?: boolean;
  startTimeToExclusive?: boolean;
}
export interface InputCandidatePool {
  spellingCandidates?: InputSpellingCandidate[];
  amounts: NumberSpan[];
  parties: NumberSpan[];
  dates: Span<DateValue>[];
  times: Span<TimeValue>[];
  districts: Span<string>[];
  interests: Span<string>[];
  ages: NumberSpan[];
  overflow: boolean;
}

const LIMIT = 16;
const fold = (value: string) =>
  value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
const words: Record<string, number> = {
  sifir: 0,
  zero: 0,
  bir: 1,
  one: 1,
  iki: 2,
  two: 2,
  uc: 3,
  three: 3,
  dort: 4,
  four: 4,
  bes: 5,
  five: 5,
  alti: 6,
  six: 6,
  yedi: 7,
  seven: 7,
  sekiz: 8,
  eight: 8,
  dokuz: 9,
  nine: 9,
  on: 10,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  yirmi: 20,
  twenty: 20,
  otuz: 30,
  thirty: 30,
  kirk: 40,
  forty: 40,
  elli: 50,
  fifty: 50,
  altmis: 60,
  sixty: 60,
  yetmis: 70,
  seventy: 70,
  seksen: 80,
  eighty: 80,
  doksan: 90,
  ninety: 90,
};
const months: Record<string, number> = {
  ocak: 1,
  january: 1,
  jan: 1,
  subat: 2,
  february: 2,
  feb: 2,
  mart: 3,
  march: 3,
  mar: 3,
  nisan: 4,
  april: 4,
  apr: 4,
  mayis: 5,
  may: 5,
  haziran: 6,
  june: 6,
  jun: 6,
  temmuz: 7,
  july: 7,
  jul: 7,
  agustos: 8,
  august: 8,
  aug: 8,
  eylul: 9,
  september: 9,
  sep: 9,
  sept: 9,
  ekim: 10,
  october: 10,
  oct: 10,
  kasim: 11,
  november: 11,
  nov: 11,
  aralik: 12,
  december: 12,
  dec: 12,
};
const weekdays: Record<string, number> = {
  pazar: 0,
  sunday: 0,
  sun: 0,
  pazartesi: 1,
  monday: 1,
  mon: 1,
  sali: 2,
  tuesday: 2,
  tue: 2,
  tues: 2,
  carsamba: 3,
  wednesday: 3,
  wed: 3,
  persembe: 4,
  thursday: 4,
  thu: 4,
  thurs: 4,
  cuma: 5,
  friday: 5,
  fri: 5,
  cumartesi: 6,
  saturday: 6,
  sat: 6,
};
const districts: Record<string, string> = {
  adalar: 'Adalar',
  arnavutkoy: 'Arnavutköy',
  atasehir: 'Ataşehir',
  avcilar: 'Avcılar',
  bagcilar: 'Bağcılar',
  bahcelievler: 'Bahçelievler',
  bakirkoy: 'Bakırköy',
  basaksehir: 'Başakşehir',
  bayrampasa: 'Bayrampaşa',
  besiktas: 'Beşiktaş',
  beykoz: 'Beykoz',
  beylikduzu: 'Beylikdüzü',
  beyoglu: 'Beyoğlu',
  buyukcekmece: 'Büyükçekmece',
  catalca: 'Çatalca',
  cekmekoy: 'Çekmeköy',
  esenler: 'Esenler',
  esenyurt: 'Esenyurt',
  eyupsultan: 'Eyüpsultan',
  fatih: 'Fatih',
  gaziosmanpasa: 'Gaziosmanpaşa',
  gungoren: 'Güngören',
  kadikoy: 'Kadıköy',
  kagithane: 'Kağıthane',
  kartal: 'Kartal',
  kucukcekmece: 'Küçükçekmece',
  maltepe: 'Maltepe',
  pendik: 'Pendik',
  sancaktepe: 'Sancaktepe',
  sariyer: 'Sarıyer',
  silivri: 'Silivri',
  sultanbeyli: 'Sultanbeyli',
  sultangazi: 'Sultangazi',
  sile: 'Şile',
  sisli: 'Şişli',
  tuzla: 'Tuzla',
  umraniye: 'Ümraniye',
  uskudar: 'Üsküdar',
  zeytinburnu: 'Zeytinburnu',
};

function dayOf(day: string) {
  return new Date(`${day}T12:00:00Z`).getUTCDay();
}
function weekdayOnOrAfter(today: string, target: number, forceNext = false) {
  let delta = (target - dayOf(today) + 7) % 7;
  if (forceNext && delta === 0) delta = 7;
  return addDays(today, delta);
}
function calendarDate(year: number, month: number, day: number) {
  const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return validDay(value) ? value : null;
}
function inferYear(month: number, day: number, today: string) {
  const [year, currentMonth, currentDay] = today.split('-').map(Number);
  return month < currentMonth || (month === currentMonth && day < currentDay)
    ? year + 1
    : year;
}
/** Normalize for matching while retaining offsets into the original UTF-16 text. */
function normalizedSource(source: string) {
  let text = '';
  const starts: number[] = [],
    ends: number[] = [];
  for (const match of source.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const normalized = fold(match[0]).replace(/[\u2018\u2019]/g, "'");
    for (let i = 0; i < normalized.length; i++) {
      starts.push(match.index!);
      ends.push(match.index! + match[0].length);
    }
    text += normalized;
  }
  return {
    text,
    range: (start: number, end: number) => ({
      start: starts[start] ?? source.length,
      end: ends[end - 1] ?? source.length,
    }),
    slice: (start: number, end: number) =>
      source.slice(
        starts[start] ?? source.length,
        ends[end - 1] ?? source.length,
      ),
  };
}
function numericAmount(raw: string) {
  const match = /^(\d[\d.,]*)(?:\s*(k|bin))?$/.exec(raw.trim());
  if (!match) return null;
  const token = match[1],
    scale = match[2] ? 1000 : 1;
  let normalized: string;
  // Both local conventions are supported, but separators must form a complete
  // number. Never recover a valid-looking suffix of a malformed amount.
  if (/^\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(token))
    normalized = token.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(?:,\d{3})+\.\d{1,2}$/.test(token))
    normalized = token.replace(/,/g, '');
  else if (
    /^\d{1,3}(?:\.\d{3})+$/.test(token) ||
    /^\d{1,3}(?:,\d{3})+$/.test(token)
  )
    normalized = token.replace(/[.,]/g, '');
  else if (/^\d+(?:[.,]\d{1,2})?$/.test(token))
    normalized = token.replace(',', '.');
  else return null;
  const value = Number(normalized) * scale;
  return Number.isFinite(value) && value >= 0 && value <= 100000 ? value : null;
}
function wordNumber(raw: string) {
  const tokens = fold(raw).split(/\s+/).filter(Boolean);
  let total = 0,
    current = 0,
    saw = false;
  let previousNumber: number | null = null,
    hadThousand = false,
    hadHundred = false;
  for (const token of tokens) {
    if (token === 'bin' || token === 'thousand') {
      if (hadThousand || (saw && current === 0)) return null;
      total += Math.max(current, 1) * 1000;
      current = 0;
      saw = true;
      hadThousand = true;
      hadHundred = false;
      previousNumber = null;
    } else if (token === 'yuz' || token === 'hundred') {
      if (hadHundred || current > 19 || previousNumber === 0) return null;
      current = Math.max(current, 1) * 100;
      saw = true;
      hadHundred = true;
      previousNumber = null;
    } else if (words[token] != null) {
      const next = words[token];
      if (
        previousNumber !== null &&
        !(
          previousNumber >= 10 &&
          previousNumber % 10 === 0 &&
          next >= 1 &&
          next <= 9
        )
      )
        return null;
      current += next;
      saw = true;
      previousNumber = next;
    } else return null;
  }
  const value = total + current;
  return saw && value <= 100000 ? value : null;
}
function push<T>(array: Span<T>[], prefix: string, text: string, value: T, extra: Partial<Span<T>> = {}) {
  const clean = text.trim();
  if (
    !clean ||
    array.some(
      (item) =>
        item.text === clean &&
        JSON.stringify(item.value) === JSON.stringify(value),
    )
  )
    return false;
  if (array.length >= LIMIT) return true;
  array.push({ id: `${prefix}${array.length}`, text: clean, value, ...extra });
  return false;
}

export function buildInputCandidates(
  message: string,
  now: Date,
  previous: IntentState,
): InputCandidatePool {
  if (!(now instanceof Date) || !Number.isFinite(now.valueOf()))
    throw new Error('Invalid candidate time.');
  if (typeof message !== 'string' || !message.trim() || message.length > 1200)
    throw new Error('Invalid candidate message.');
  const pool: InputCandidatePool = {
    spellingCandidates: findInputSpellingCandidates(message),
    amounts: [],
    parties: [],
    dates: [],
    times: [],
    districts: [],
    interests: [],
    ages: [],
    overflow: false,
  };
  const add = <T>(
    key: keyof InputCandidatePool,
    prefix: string,
    text: string,
    value: T,
    extra: Partial<Span<T>> = {},
  ) => {
    if (push(pool[key] as Span<T>[], prefix, text, value, extra)) pool.overflow = true;
  };
  const source = normalizedSource(message),
    q = source.text,
    today = todayInIstanbul(now);

  const original = (match: RegExpMatchArray) =>
    source.slice(match.index!, match.index! + match[0].length);
  const numberWords = `(?:${Object.keys(words)
    .sort((a, b) => b.length - a.length)
    .join('|')})`;
  const countToken = `(?:\\d+|${numberWords}(?:[ -]+${numberWords})*)`;
  const boundaryStart = '(?<![\\p{L}\\p{N}_])',
    boundaryEnd = '(?![\\p{L}\\p{N}_])';
  const scan = (pattern: string) => q.matchAll(new RegExp(pattern, 'gu'));
  const amountRanges: Array<[number, number]> = [];
  for (const match of scan(
    `(?<![\\p{L}\\p{N}_-])(?:ucretsiz|bedava|free)(?:\\s+(?:events?|etkinlik(?:ler)?))?${boundaryEnd}`,
  ))
    add('amounts', 'a', original(match), 0);
  // A single lexical token is consumed even when its separator format is bad.
  // Adjacent date/time separators and letters prevent suffix-number recovery.
  const numericToken =
    '(?<![\\p{L}\\p{N}_.,:/+\\-])(?:\u20ba\\s*)?\\d[\\d.,]*(?:\\s*(?:k|bin))?(?:\\s*(?:tl|try|lira|\u20ba))?(?![\\p{L}\\p{N}_:/-])';
  for (const match of scan(numericToken)) {
    const raw = match[0].trim().replace(/[.,]$/, '');
    const sourceRange = source.range(match.index!, match.index! + match[0].length);
    if (/^[\u2018\u2019']\p{L}+/u.test(message.slice(sourceRange.end))) continue;
    if (/^\s*(?:kisi(?:yiz|lik)?|people|persons?|adults?|yetiskin|cocuk|children|child|kids?)\b/u.test(q.slice(match.index! + match[0].length))) continue;
    const explicit =
      /(?:tl|try|lira|\u20ba|k|bin)$/.test(raw) || raw.startsWith('\u20ba');
    const localContext = q.slice(Math.max(0, match.index! - 32), match.index! + match[0].length + 32);
    const budgetContext = previous.filters.maxPrice != null ||
      /\b(?:butce|budget|kisi basi|per person|each|toplam|total|instead|under|below|up to|at most|en fazla|en cok)\b/.test(localContext);
    if (!explicit && !budgetContext) continue;
    const number = raw
      .replace(/^\u20ba\s*/, '')
      .replace(/\s*(?:tl|try|lira|\u20ba)$/, '');
    const value = numericAmount(number);
    amountRanges.push([match.index!, match.index! + match[0].length]);
    if (value == null) pool.overflow = true;
    else add('amounts', 'a', original(match), value);
  }
  // Colloquial Turkish commonly attaches the dative suffix directly to an
  // upper bound ("bilet başı 1100e kadar"). Keep this narrow budget context
  // so an arbitrary suffixed number cannot become a price candidate.
  for (const match of message.matchAll(
    /(?<![\p{L}\p{N}_])(?:bilet\s+başı|kişi\s+başı)\s+(\d[\d.,]*)(?:'?(?:e|a|ye|ya))\s+kadar(?![\p{L}\p{N}_])/giu,
  )) {
    const value = numericAmount(match[1]);
    if (value == null) pool.overflow = true;
    else add('amounts', 'a', match[0], value);
  }
  const wordToken = `(?:${numberWords}|bin|thousand|yuz|hundred)`;
  for (const match of scan(
    `${boundaryStart}(${wordToken}(?:[ -]+${wordToken})*)\\s+(?:tl|lira)${boundaryEnd}`,
  )) {
    const value = wordNumber(match[1].replace(/-/g, ' '));
    if (value == null) pool.overflow = true;
    else add('amounts', 'a', original(match), value);
  }

  const partyMatches: Array<{
    text: string;
    value: number;
    index: number;
    end: number;
    kind: string;
  }> = [];
  const partyPattern = `${boundaryStart}(${countToken})\\s*(kisi(?:yiz|lik)?|people|persons?|adults?|yetiskin|cocuk|children|child|kids?)${boundaryEnd}`;
  for (const match of scan(partyPattern)) {
    const following = q.slice(match.index! + match[0].length);
    if (/^\s+(?:daha\s+katildi|more\s+(?:are\s+|is\s+)?joining|joined|gelmiyor|gelemiyor|katilmayacak|ayrildi|is\s+not\s+coming|are\s+not\s+coming|dropped\s+out|cancelled)\b/u.test(following)) continue;
    const value = /^\d+$/.test(match[1])
      ? Number(match[1])
      : wordNumber(match[1].replace(/-/g, ' '));
    if (value != null && value >= 1 && value <= 100) {
      partyMatches.push({
        text: original(match),
        value,
        index: match.index!,
        end: match.index! + match[0].length,
        kind: match[2],
      });
      add('parties', 'p', original(match), value);
    } else pool.overflow = true;
  }
  // Only disjoint adult/child counts are safely additive. Corrections, totals,
  // repeated counts and alternatives must never create a manufactured sum.
  if (partyMatches.length === 2) {
    const [first, last] = partyMatches;
    const adult = /^(?:adults?|yetiskin)$/;
    const child = /^(?:cocuk|children|child|kids?)$/;
    if (
      ((adult.test(first.kind) && child.test(last.kind)) ||
        (child.test(first.kind) && adult.test(last.kind))) &&
      /^\s*(?:(?:ve|and|plus|\+)\s*)?$/.test(q.slice(first.end, last.index))
    ) {
      const value = first.value + last.value;
      if (value <= 100)
        add('parties', 'p', source.slice(first.index, last.end), value);
      else pool.overflow = true;
    }
  }
  for (const match of scan(
    `${boundaryStart}(?:sevgilimle|partnerimle|esimle|kiz arkadasimla|erkek arkadasimla|ikimiz|the two of us|with my (?:girlfriend|boyfriend|partner|wife|husband))${boundaryEnd}`,
  ))
    add('parties', 'p', original(match), 2);
  for (const match of scan(
    `${boundaryStart}we(?:'re| are)\\s+(${countToken})(?:\\s+of\\s+us)?${boundaryEnd}`,
  )) {
    const value = /^\d+$/.test(match[1])
      ? Number(match[1])
      : wordNumber(match[1].replace(/-/g, ' '));
    if (value != null && value >= 1 && value <= 100)
      add('parties', 'p', original(match), value);
    else pool.overflow = true;
  }
  for (const match of scan(
    `${boundaryStart}(${countToken})\\s+of\\s+us${boundaryEnd}`,
  )) {
    if (/we(?:'re| are)\\s+$/u.test(q.slice(Math.max(0, match.index! - 8), match.index!))) continue;
    const value = /^\d+$/.test(match[1])
      ? Number(match[1])
      : wordNumber(match[1].replace(/-/g, ' '));
    if (value != null && value >= 1 && value <= 100)
      add('parties', 'p', original(match), value);
    else pool.overflow = true;
  }
  const addPartyDelta = (match: RegExpMatchArray, magnitude: number, direction: 1 | -1) => {
    const delta = direction * magnitude;
    const resolved = previous.filters.partySize == null ? magnitude : previous.filters.partySize + delta;
    add('parties', 'p', original(match), resolved, { operation: { kind: 'delta', delta } });
  };
  for (const match of scan(
    `${boundaryStart}(${countToken})\\s+(?:kisi|people|persons?)\\s+(?:daha\\s+katildi|more\\s+(?:are\\s+|is\\s+)?joining|joined)${boundaryEnd}`,
  )) {
    const value = /^\\d+$/.test(match[1]) ? Number(match[1]) : wordNumber(match[1].replace(/-/g, ' '));
    if (value != null && value >= 1 && value <= 100) addPartyDelta(match, value, 1); else pool.overflow = true;
  }
  for (const match of scan(
    `${boundaryStart}(${countToken})\\s+(?:kisi|people|persons?)\\s+(?:gelmiyor|gelemiyor|katilmayacak|ayrildi|is\\s+not\\s+coming|are\\s+not\\s+coming|dropped\\s+out|cancelled)${boundaryEnd}`,
  )) {
    const value = /^\\d+$/.test(match[1]) ? Number(match[1]) : wordNumber(match[1].replace(/-/g, ' '));
    if (value != null && value >= 1 && value <= 100) addPartyDelta(match, value, -1); else pool.overflow = true;
  }
  for (const spelling of pool.spellingCandidates ?? []) {
    if (spelling.kind !== 'companion') continue;
    if (['sevgilimle', 'partnerimle'].includes(spelling.normalized)) {
      add('parties', 'p', spelling.text, 2);
      continue;
    }
    const prefix = message.slice(0, spelling.start);
    const count = /(?<![\p{L}\p{N}_.,:/+-])(\d{1,3})\s*$/u.exec(prefix);
    if (!count) continue;
    const value = Number(count[1]);
    if (value >= 1 && value <= 100) {
      const start = spelling.start - count[0].length;
      add('parties', 'p', message.slice(start, spelling.end), value);
    } else pool.overflow = true;
  }
  for (const match of scan(
    `${boundaryStart}(${countToken})[ -]*(?:yas(?:inda|indaki)?|year[ -]old)${boundaryEnd}`,
  )) {
    const value = /^\d+$/.test(match[1])
      ? Number(match[1])
      : wordNumber(match[1].replace(/-/g, ' '));
    if (value != null && value >= 0 && value <= 17)
      add('ages', 'g', original(match), value);
    else pool.overflow = true;
  }

  const dated: Array<{ start: number; end: number; from: string; to: string }> =
    [];
  const addDate = (match: RegExpMatchArray, from: string | null, to = from) => {
    if (from && to && validDay(from) && validDay(to) && from <= to) {
      add('dates', 'd', original(match), { dateFrom: from, dateTo: to });
      dated.push({
        start: match.index!,
        end: match.index! + match[0].length,
        from,
        to,
      });
    } else pool.overflow = true;
  };
  for (const match of scan(
    '(?<![\\p{L}\\p{N}_.:/-])\\d{4}-\\d{2}-\\d{2}(?![\\p{L}\\p{N}_.:/-])',
  ))
    addDate(match, validDay(match[0]) ? match[0] : null);
  for (const match of scan(
    '(?<![\\p{L}\\p{N}_.,:/-])(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2}|\\d{4}))?(?![\\p{L}\\p{N}_.,:/-])',
  )) {
    if (
      amountRanges.some(
        ([start, end]) => match.index! >= start && match.index! < end,
      )
    )
      continue;
    const after = q.slice(match.index! + match[0].length);
    if (
      match[3] == null &&
      match[0].includes('.') &&
      /^\s*(?:hours?|hrs?|minutes?|mins?|days?|saat|dakika|gun)(?!\p{L})/u.test(after)
    )
      continue;
    const a = Number(match[1]),
      b = Number(match[2]),
      rawYear = match[3] ? Number(match[3]) : null;
    const year =
      rawYear == null
        ? inferYear(b, a, today)
        : rawYear < 100
          ? 2000 + rawYear
          : rawYear;
    addDate(match, calendarDate(year, b, a));
    if (a <= 12 && b <= 12 && a !== b)
      addDate(
        match,
        calendarDate(rawYear == null ? inferYear(a, b, today) : year, a, b),
      );
  }
  const monthNames = Object.keys(months)
    .sort((a, b) => b.length - a.length)
    .join('|');
  for (const match of scan(
    `${boundaryStart}(\\d{1,2})\\s+(${monthNames})(?:\\s+(\\d{4}))?${boundaryEnd}`,
  )) {
    const month = months[match[2]],
      day = Number(match[1]);
    addDate(
      match,
      calendarDate(
        match[3] ? Number(match[3]) : inferYear(month, day, today),
        month,
        day,
      ),
    );
  }
  for (const match of scan(
    `${boundaryStart}(${monthNames})\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?${boundaryEnd}`,
  )) {
    const month = months[match[1]],
      day = Number(match[2]);
    addDate(
      match,
      calendarDate(
        match[3] ? Number(match[3]) : inferYear(month, day, today),
        month,
        day,
      ),
    );
  }
  for (const match of scan(
    `${boundaryStart}(?:bugun|today|tonight|bu\\s+(?:gece|aksam))${boundaryEnd}`,
  ))
    addDate(match, today);
  for (const match of scan(`${boundaryStart}(?:yarin|tomorrow)${boundaryEnd}`))
    addDate(match, addDays(today, 1));
  for (const match of scan(
    `${boundaryStart}(?:bu hafta sonu|bu haftasonu|this weekend)${boundaryEnd}`,
  )) {
    const start = dayOf(today) === 0 ? today : weekdayOnOrAfter(today, 6);
    addDate(match, start, dayOf(today) === 0 ? start : addDays(start, 1));
  }
  for (const match of scan(
    `${boundaryStart}(?:gelecek hafta|next week|haftaya)${boundaryEnd}`,
  )) {
    const start = addDays(today, (1 - dayOf(today) + 7) % 7 || 7);
    addDate(match, start, addDays(start, 6));
  }
  const weekdayNames = Object.keys(weekdays)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const quotedRanges = [...message.matchAll(
    /["\u201c\u201d']([^"\u201c\u201d']{1,160})["\u201c\u201d']/gu,
  )].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  const weekdayAbbreviations: Record<string, number> = {
    pzt: 1,
    cmt: 6,
  };
  for (const match of scan(
    `${boundaryStart}(${Object.keys(weekdayAbbreviations).join('|')})\\.?${boundaryEnd}`,
  )) {
    const range = source.range(match.index!, match.index! + match[0].length);
    if (quotedRanges.some((quoted) => range.start >= quoted.start && range.end <= quoted.end))
      continue;
    addDate(match, weekdayOnOrAfter(today, weekdayAbbreviations[match[1]]));
  }
  for (const spelling of pool.spellingCandidates ?? []) {
    if (spelling.kind !== 'weekday') continue;
    const target = weekdays[spelling.normalized];
    if (target == null) continue;
    const preceding = dated.find((item) => {
      const range = source.range(item.start, item.end);
      return range.end <= spelling.start && /^\s*$/.test(message.slice(range.end, spelling.start));
    });
    if (preceding && /\d/.test(q.slice(preceding.start, preceding.end))) {
      if (dayOf(preceding.from) !== target) pool.overflow = true;
      continue;
    }
    const prefix = fold(message.slice(0, spelling.start));
    const inNextWeek = /(?:haftaya|gelecek hafta|next week)\s*$/.test(prefix);
    const base = inNextWeek ? addDays(today, (1 - dayOf(today) + 7) % 7 || 7) : today;
    const day = weekdayOnOrAfter(base, target, !inNextWeek && /(?:gelecek|next)\s*$/.test(prefix));
    add('dates', 'd', spelling.text, { dateFrom: day, dateTo: day });
  }
  const weekdayPattern = `${boundaryStart}(?:(bu|this|gelecek|next)\\s+)?(${weekdayNames})(?:'?(?:dan|den|tan|ten|ya|ye|na|ne)|\\s+gunu)?${boundaryEnd}`;
  for (const match of scan(weekdayPattern)) {
    const week = dated.find(
      (item) =>
        /^(?:next week|gelecek hafta|haftaya)$/.test(
          q.slice(item.start, item.end),
        ) &&
        item.end <= match.index! &&
        /^\s*$/.test(q.slice(item.end, match.index!)),
    );
    if (week) {
      const day = weekdayOnOrAfter(week.from, weekdays[match[2]]);
      add(
        'dates',
        'd',
        source.slice(week.start, match.index! + match[0].length),
        { dateFrom: day, dateTo: day },
      );
      continue;
    }
    // A weekday accompanying a complete calendar date qualifies that date; it
    // must not introduce a separate next-occurrence date into the choice pool.
    const preceding = dated.find(
      (item) =>
        /\d/.test(q.slice(item.start, item.end)) &&
        item.end <= match.index! &&
        /^\s*$/.test(q.slice(item.end, match.index!)),
    );
    if (preceding) {
      if (dayOf(preceding.from) !== weekdays[match[2]]) pool.overflow = true;
      continue;
    }
    addDate(
      match,
      weekdayOnOrAfter(
        today,
        weekdays[match[2]],
        /gelecek|next/.test(match[1] ?? ''),
      ),
    );
  }
  const ordered = [...dated].sort((a, b) => a.start - b.start);
  for (let index = 1; index < ordered.length; index++) {
    const first = ordered[index - 1],
      last = ordered[index];
    if (last.start < first.end) continue;
    const connector = q.slice(first.end, last.start);
    if (
      !/^\s*(?:through|until|to|ile|[-\u2013\u2014])\s*$/.test(connector) &&
      !(
        /^\s*$/.test(connector) &&
        /^\s+(?:kadar|arasi)\b/.test(q.slice(last.end))
      )
    )
      continue;
    if (first.from <= last.to)
      add('dates', 'd', source.slice(first.start, last.end), {
        dateFrom: first.from,
        dateTo: last.to,
      });
    else pool.overflow = true;
  }

  const formatTime = (hour: number, minute: number) =>
    `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const clockPattern = `(?:${boundaryStart}|(?<=\\band))(?:(no later than|no earlier than|between|after|before|from|until|by|at)\\s*)?(?:(saat)\\s*)?(\\d{1,2})(?::(\\d{1,2}))?\\s*(am|pm)?(?:'?(?:den|dan|ten|tan|e|a|ye|ya|de|da|te|ta))?(?:\\s*(sonra(?:si)?|itibaren|kadar|once(?:si)?))?(?![\\p{L}\\p{N}_:/]|[.,]\\d)`;
  const clocks: Array<{
    start: number;
    end: number;
    value: string;
    constraint: TimeValue;
  }> = [];
  for (const match of scan(clockPattern)) {
    if (!match[1] && !match[2] && match[4] == null && !match[5] && !match[6])
      continue;
    let hour = Number(match[3]);
    const minute = Number(match[4] ?? 0);
    // Reject ambiguous 12-hour expressions, malformed minutes, invalid AM/PM.
    if (
      minute > 59 ||
      (match[4] != null && match[4].length !== 2) ||
      hour > 23 ||
      (match[5] && (hour < 1 || hour > 12)) ||
      (!match[5] && match[4] == null && hour >= 1 && hour <= 12)
    ) {
      pool.overflow = true;
      continue;
    }
    if (match[5] === 'pm' && hour < 12) hour += 12;
    if (match[5] === 'am' && hour === 12) hour = 0;
    const value = formatTime(hour, minute),
      direction = [match[1], match[6]].filter(Boolean).join(' ');
    let constraint: TimeValue;
    if (/before|once/.test(direction))
      constraint = { startTimeTo: value, startTimeToExclusive: true };
    else if (/until|by|kadar|no later than/.test(direction))
      constraint = { startTimeTo: value, startTimeToExclusive: false };
    else if (/after|sonra/.test(direction))
      constraint = { startTimeFrom: value, startTimeFromExclusive: true };
    else if (/from|itibaren|between|no earlier than/.test(direction))
      constraint = { startTimeFrom: value, startTimeFromExclusive: false };
    else
      constraint = {
        startTimeFrom: value,
        startTimeTo: value,
        startTimeFromExclusive: false,
        startTimeToExclusive: false,
      };
    add('times', 't', original(match), constraint);
    clocks.push({
      start: match.index!,
      end: match.index! + match[0].length,
      value,
      constraint,
    });
  }
  for (let index = 1; index < clocks.length; index++) {
    const first = clocks[index - 1],
      last = clocks[index];
    const connector = q.slice(first.end, last.start);
    const directional =
      first.constraint.startTimeFrom &&
      !first.constraint.startTimeTo &&
      last.constraint.startTimeTo &&
      !last.constraint.startTimeFrom &&
      /^\s*(?:(?:and|ve)\s*)?$/.test(connector);
    const between =
      /^between\s*/.test(q.slice(first.start, first.end)) &&
      /^\s*and\s*$/.test(connector);
    if (
      !directional &&
      !between &&
      !/^\s*(?:-|\u2013|\u2014|to|ile)\s*$/.test(connector)
    )
      continue;
    if (
      first.value > last.value ||
      (first.value === last.value &&
        directional &&
        (first.constraint.startTimeFromExclusive ||
          last.constraint.startTimeToExclusive))
    ) {
      pool.overflow = true;
      continue;
    }
    add(
      'times',
      't',
      source.slice(first.start, last.end),
      directional
        ? { ...first.constraint, ...last.constraint }
        : {
            startTimeFrom: first.value,
            startTimeTo: last.value,
            startTimeFromExclusive: false,
            startTimeToExclusive: false,
          },
    );
  }
  for (const match of scan(
    `${boundaryStart}(?:aksam(?:i|in)?|evening|tonight|gece(?:si)?|night)${boundaryEnd}`,
  ))
    add('times', 't', original(match), {
      startTimeFrom: '18:00',
      startTimeFromExclusive: false,
    });

  const districtNames = Object.keys(districts)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const districtPattern = `${boundaryStart}(${districtNames})(?:'?(?:da|de|ta|te|dan|den|tan|ten|ya|ye|a|e|nda|nde|na|ne))?${boundaryEnd}`;
  for (const match of scan(districtPattern))
    add('districts', 'l', original(match), districts[match[1]]);
  for (const spelling of pool.spellingCandidates ?? []) {
    if (spelling.kind !== 'district') continue;
    const value = districts[spelling.normalized];
    if (value) add('districts', 'l', spelling.text, value);
  }

  const hardRanges: Array<{ start: number; end: number }> = [];
  for (const item of [
    ...pool.amounts, ...pool.parties, ...pool.dates, ...pool.times,
    ...pool.districts, ...pool.ages,
  ]) {
    if (item.sourceSpans?.length) {
      hardRanges.push(...item.sourceSpans);
      continue;
    }
    let offset = 0;
    while ((offset = message.indexOf(item.text, offset)) >= 0) {
      hardRanges.push({ start: offset, end: offset + item.text.length });
      offset += item.text.length;
    }
  }
  for (const harvested of harvestInputPropositions(message, hardRanges)) {
    if (pool.interests.length >= LIMIT) {
      pool.overflow = true;
      continue;
    }
    const candidate: Span<string> = {
      id: `i${pool.interests.length}`,
      text: harvested.text,
      value: harvested.text,
      sourceSpans: [{ start: harvested.start, end: harvested.end }],
      scope: harvested.scope,
    };
    pool.interests.push(candidate);
  }
  for (const target of pool.interests) {
    if (target.scope?.ownership?.kind !== 'operation-target') continue;
    target.scope.ownership.references = pool.interests
      .filter((candidate) =>
        candidate.scope?.ownership?.kind === 'operation-replacement' &&
        candidate.scope.proposition.start === target.scope!.proposition.start &&
        candidate.scope.proposition.end === target.scope!.proposition.end)
      .map(({ id }) => id);
  }
  return pool;

}
