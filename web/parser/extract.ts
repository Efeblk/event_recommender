/**
 * Code-side candidate extraction. Every mention is a literal source span plus a
 * value computed in code. Extraction over-proposes on purpose: Jev decides what
 * each mention means (required, preferred, excluded, an edit target, or noise).
 */
import type { Category } from './contract.ts';
import {
  CATEGORY_TERMS, COMPANION_TERMS, CONTENT_TERMS, CURRENCIES, DISTRICTS, EXPERIENCE_TERMS, fold, MONTHS,
  NEIGHBORHOODS, NUMBER_WORDS, OUTSIDE_ISTANBUL, TOPIC_TERMS, WEEKDAYS,
} from './lexicon.ts';

export type MentionKind = 'amount' | 'date' | 'time' | 'party' | 'companion' | 'location' | 'outside_location'
  | 'category' | 'topic' | 'experience' | 'content';

interface Base { id: string; start: number; end: number; text: string }
export type Mention = Base & (
  | { kind: 'amount'; amount: number; currency: 'TRY' | 'OTHER' }
  | { kind: 'date'; from: string; to: string; past: boolean; alternatives?: Array<{ from: string; to: string }> }
  | { kind: 'time'; clock: string }
  | { kind: 'party'; count: number }
  | { kind: 'companion'; value: 'partner' | 'friends' | 'family' | 'children' }
  | { kind: 'location'; name: string; precision: 'district' | 'neighborhood' }
  | { kind: 'outside_location'; name: string }
  | { kind: 'category'; value: Category }
  | { kind: 'topic'; value: string }
  | { kind: 'experience'; value: string }
  | { kind: 'content'; value: 'profanity' | 'sexual_content' }
);
type Draft = Omit<Mention, 'id'>;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
/** Turkish inflection after a stem (folded text, so ı→i, ü→u, ö→o, ş→s, ç→c, ğ→g). */
const SUFFIX = "(?:'?[a-z]{0,9})";
const SHORT_SUFFIX = "(?:'?(?:s|es|l[ae]r|[iu]|y[iu]|[iu]n|n[iu]n|[dt][ae]|[dt][ae]n|y?[ae]|y?l[ae]|s[iu]|l[ae]r[iu]|l[ae]r[dt][ae]|ci|cu|lik|luk|li|lu|siz|suz)?)";

function termRegex(term: string): RegExp {
  const pattern = escape(term).replace(/[ -]/gu, '[\\s-]?');
  const suffix = term.length >= 5 && !/[ -]/u.test(term) ? SUFFIX : SHORT_SUFFIX;
  return new RegExp(`${B}${pattern}${suffix}${E}`, 'gu');
}

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);

function parseNumber(raw: string): number | null {
  const s = raw.trim();
  if (/^\d{1,3}(?:[.,]\d{3})+$/u.test(s)) return Number(s.replace(/[.,]/gu, ''));
  if (/^\d+(?:[.,]\d{1,2})?$/u.test(s)) return Number(s.replace(',', '.'));
  // Word numbers: "iki bin beş yüz", "two thousand".
  let total = 0, current = 0, seen = false;
  for (const word of s.split(/\s+/u)) {
    const value = NUMBER_WORDS[word];
    if (value === undefined) return null;
    seen = true;
    if (value === 1000) { total += (current || 1) * 1000; current = 0; }
    else if (value === 100) current = (current || 1) * 100;
    else current += value;
  }
  return seen ? total + current : null;
}

const NUMBER_WORD_ALT = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|');
const NUM = `(?:\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:[.,]\\d{1,2})?|(?:(?:${NUMBER_WORD_ALT})(?:\\s+(?:${NUMBER_WORD_ALT}))*))`;
const CURRENCY_ALT = Object.keys(CURRENCIES).sort((a, b) => b.length - a.length).map(escape).join('|');

export interface Extraction { mentions: Mention[]; folded: string }

export function extract(text: string, referenceDate: string): Extraction {
  const f = fold(text);
  const drafts: Draft[] = [];
  const taken = new Array<boolean>(text.length).fill(false);
  const free = (start: number, end: number) => !taken.slice(start, end).some(Boolean);
  const claim = (start: number, end: number) => { for (let i = start; i < end; i++) taken[i] = true; };
  const add = (draft: Draft, claimSpan = true) => {
    if (!free(draft.start, draft.end)) return false;
    drafts.push(draft);
    if (claimSpan) claim(draft.start, draft.end);
    return true;
  };
  const span = (start: number, end: number) => ({ start, end, text: text.slice(start, end) });
  const today = new Date(`${referenceDate}T12:00:00Z`);

  // --- Amounts with an explicit currency (claimed before times/party).
  const amountRe = new RegExp(`${B}(?:(${CURRENCY_ALT})\\s?(${NUM})|(${NUM})\\s?(${CURRENCY_ALT}))(?:'?[a-z]{0,6})?${E}`, 'gu');
  for (const m of f.matchAll(amountRe)) {
    const raw = m[2] ?? m[3];
    const amount = parseNumber(raw);
    if (amount === null) continue;
    const currency = CURRENCIES[(m[1] ?? m[4]).trim()] ?? 'TRY';
    add({ kind: 'amount', amount, currency, ...span(m.index!, m.index! + m[0].length) });
  }

  // --- Times.
  const hourWithMeridiem = (h: number, meridiem: string | undefined, context: string) => {
    if (meridiem?.startsWith('p') && h < 12) return h + 12;
    if (meridiem?.startsWith('a')) return h === 12 ? 0 : h;
    if (/(?:aksam|gece|evening|night|tonight)/u.test(context) && h < 12) return h + 12;
    if (/(?:sabah|ogle|morning)/u.test(context)) return h;
    return h >= 1 && h <= 9 ? h + 12 : h;
  };
  const timeRes: RegExp[] = [
    new RegExp(`${B}([01]?\\d|2[0-3])[:.]([0-5]\\d)(?:\\s?(am|pm|a\\.m\\.|p\\.m\\.))?(?:'?[a-z]{0,5})?${E}`, 'gu'),
    new RegExp(`${B}(1[0-2]|0?[1-9])\\s?(am|pm|a\\.m\\.|p\\.m\\.)${E}`, 'gu'),
    new RegExp(`${B}(?:saat|aksam|gece|sabah|at|after|before|until|from|by|around|starting)\\s+(?:saat\\s+)?(1\\d|2[0-3]|0?\\d)(?![\\d.:])(?:'?[a-z]{0,5})?${E}`, 'gu'),
    new RegExp(`${B}(1\\d|2[0-3]|0?\\d)'(?:[dt][ae]n|[ae]|y[ae]|[dt][ae])${E}`, 'gu'),
  ];
  for (const [index, re] of timeRes.entries()) {
    for (const m of f.matchAll(re)) {
      const start = m.index!, end = start + m[0].length;
      if (!free(start, end)) continue;
      const context = f.slice(Math.max(0, start - 12), end + 6);
      const h = Number(m[1]);
      const minutes = index === 0 ? Number(m[2]) : 0;
      const meridiem = index === 0 ? m[3] : index === 1 ? m[2] : undefined;
      // Bare apostrophe hours need clock context ("7'den sonra", "21'e kadar").
      if (index === 3 && !/(?:sonra|once|kadar|itibaren|baslayan|aksam|gece|saat)/u.test(f.slice(end, end + 14) + f.slice(Math.max(0, start - 8), start))) continue;
      const hour = index === 0 && h >= 13 ? h : hourWithMeridiem(h, meridiem, context);
      if (hour > 23) continue;
      add({ kind: 'time', clock: `${pad(hour)}:${pad(minutes)}`, ...span(start, end) });
    }
  }

  // --- Dates.
  const weekdayAlt = Object.keys(WEEKDAYS).sort((a, b) => b.length - a.length).join('|');
  const monthAlt = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
  const ref = iso(today);
  const dateDraft = (start: number, end: number, from: Date, to: Date, alternatives?: Array<{ from: string; to: string }>) =>
    add({ kind: 'date', from: iso(from), to: iso(to), past: iso(to) < ref, ...(alternatives ? { alternatives } : {}), ...span(start, end) });
  const nextWeekday = (day: number, skipWeek: boolean) => {
    let delta = (day - today.getUTCDay() + 7) % 7;
    if (skipWeek) delta += 7;
    return addDays(today, delta);
  };
  const resolveYear = (month: number, day: number) => {
    let d = new Date(Date.UTC(today.getUTCFullYear(), month - 1, day, 12));
    if (iso(d) < ref && (today.getTime() - d.getTime()) > 60 * 86400000) d = new Date(Date.UTC(today.getUTCFullYear() + 1, month - 1, day, 12));
    return d;
  };
  // Explicit day-month ranges and dates.
  const dm = `(\\d{1,2})(?:'?[a-z]{0,4})?\\s*(?:-|–|ile|and|to|until|ve)\\s*(\\d{1,2})(?:'?[a-z]{0,4})?\\s+(${monthAlt})`;
  for (const m of f.matchAll(new RegExp(`${B}${dm}(?:'?[a-z]{0,6})?(?:\\s+(?:arasi|arasinda|between))?${E}`, 'gu'))) {
    const month = MONTHS[m[3]];
    dateDraft(m.index!, m.index! + m[0].length, resolveYear(month, Number(m[1])), resolveYear(month, Number(m[2])));
  }
  for (const m of f.matchAll(new RegExp(`${B}(?:between\\s+)?(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|–|and|to|until|through)\\s*(?:(?:${monthAlt})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?${E}`, 'gu'))) {
    const month = MONTHS[m[1]];
    dateDraft(m.index!, m.index! + m[0].length, resolveYear(month, Number(m[2])), resolveYear(month, Number(m[3])));
  }
  for (const m of f.matchAll(new RegExp(`${B}(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlt})(?:'?[a-z]{0,6})?${E}|${B}(${monthAlt})\\s+(\\d{1,2})(?:st|nd|rd|th)?${E}`, 'gu'))) {
    const month = MONTHS[m[2] ?? m[3]], day = Number(m[1] ?? m[4]);
    if (day < 1 || day > 31) continue;
    const d = resolveYear(month, day);
    dateDraft(m.index!, m.index! + m[0].length, d, d);
  }
  for (const m of f.matchAll(new RegExp(`${B}(\\d{4})-(\\d{2})-(\\d{2})${E}|${B}(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{4}))?${E}`, 'gu'))) {
    const [y, mo, d] = m[1] ? [Number(m[1]), Number(m[2]), Number(m[3])] : [Number(m[6] ?? today.getUTCFullYear()), Number(m[5]), Number(m[4])];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    // "20.00" etc. are clocks, already claimed above.
    const date = new Date(Date.UTC(y, mo - 1, d, 12));
    dateDraft(m.index!, m.index! + m[0].length, date, date);
  }
  // Relative words.
  const rel: Array<[RegExp, () => [Date, Date] | null]> = [
    [/(?:obur gun|ertesi gun|day after tomorrow)/u, () => [addDays(today, 2), addDays(today, 2)]],
    [/(?:yarin(?:ki)?|tomorrow(?:'s)?)/u, () => [addDays(today, 1), addDays(today, 1)]],
    [/(?:bugun(?:ku)?|bu aksam|bu gece|today(?:'s)?|tonight(?:'s)?|this evening)/u, () => [today, today]],
    [/(?:dun(?:ku)?|yesterday(?:'s)?|evvelsi gun)/u, () => [addDays(today, -1), addDays(today, -1)]],
    [/(?:gecen hafta(?:ki)?|last week(?:'s)?)/u, () => [addDays(today, -7 - ((today.getUTCDay() + 6) % 7)), addDays(today, -1 - ((today.getUTCDay() + 6) % 7))]],
    [/(?:gelecek hafta(?:ya)?|onumuzdeki hafta|haftaya|next week)(?!\s*(?:sonu|end|ici))/u, () => {
      const monday = nextWeekday(1, false); const m = iso(monday) === ref ? addDays(monday, 7) : monday;
      return [m, addDays(m, 6)];
    }],
    [/(?:bu hafta(?!\s*(?:sonu|ici))|this week(?!end))/u, () => [today, nextWeekday(0, false)]],
  ];
  for (const [pattern, resolve] of rel) {
    for (const m of f.matchAll(new RegExp(`${B}${pattern.source}(?:'?[a-z]{0,5})?${E}`, 'gu'))) {
      const r = resolve();
      if (r) dateDraft(m.index!, m.index! + m[0].length, r[0], r[1]);
    }
  }
  // Weekend / weekday names with optional this/next/last modifiers.
  const modifier = '(?:(bu|this|gelecek|onumuzdeki|next|haftaya|coming|gecen|last|ilk|first)\\s+)?';
  for (const m of f.matchAll(new RegExp(`${B}${modifier}(hafta\\s?sonu|weekend|${weekdayAlt})(?:'?[a-z]{0,6})?${E}`, 'gu'))) {
    const mod = m[1] ?? '';
    const isWeekend = /^(?:hafta\s?sonu|weekend)$/u.test(m[2]);
    const day = isWeekend ? 6 : WEEKDAYS[m[2]];
    const start = m.index!, end = start + m[0].length;
    const span = (d: Date) => (isWeekend ? [d, addDays(d, 1)] : [d, d]) as [Date, Date];
    if (/^(?:gecen|last)$/u.test(mod)) {
      const delta = ((today.getUTCDay() - day + 7) % 7) || 7;
      const [a, b] = span(addDays(today, -delta));
      dateDraft(start, end, a, b);
    } else if (/^(?:haftaya)$/u.test(mod)) {
      const [a, b] = span(nextWeekday(day, true));
      dateDraft(start, end, a, b);
    } else if (/^(?:gelecek|onumuzdeki|next|coming)$/u.test(mod)) {
      // "next Saturday" during the same week can mean this coming one or the following one.
      const near = nextWeekday(day, false), far = addDays(near, 7);
      const [a, b] = span(near), [c, d] = span(far);
      const inThisWeek = (near.getTime() - today.getTime()) / 86400000 < 7 - ((today.getUTCDay() + 6) % 7);
      if (inThisWeek && iso(near) !== ref) dateDraft(start, end, a, b, [{ from: iso(a), to: iso(b) }, { from: iso(c), to: iso(d) }]);
      else dateDraft(start, end, iso(near) === ref ? c : a, iso(near) === ref ? d : b);
    } else {
      const [a, b] = span(nextWeekday(day, false));
      dateDraft(start, end, a, b);
    }
  }

  // --- Outside-Istanbul and Istanbul locations (before generic vocabulary).
  const places: Array<[string, Draft['kind'], 'district' | 'neighborhood' | null]> = [
    ...OUTSIDE_ISTANBUL.map((n) => [n, 'outside_location', null] as [string, Draft['kind'], null]),
    ...NEIGHBORHOODS.map((n) => [n, 'location', 'neighborhood'] as [string, Draft['kind'], 'neighborhood']),
    ...DISTRICTS.map((n) => [n, 'location', 'district'] as [string, Draft['kind'], 'district']),
  ];
  places.sort((a, b) => b[0].length - a[0].length);
  for (const [name, kind, precision] of places) {
    for (const m of f.matchAll(termRegex(fold(name)))) {
      const s = m.index!, e = s + m[0].length;
      // Proper names: the original should be capitalised unless the whole message is lowercase.
      if (text[s] !== text[s].toLocaleUpperCase('tr-TR') && text !== text.toLocaleLowerCase('tr-TR')) continue;
      if (kind === 'outside_location') add({ kind, name, ...span(s, e) });
      else add({ kind: 'location', name, precision: precision!, ...span(s, e) });
    }
  }

  // --- Closed vocabularies, longest term first.
  const vocab: Array<[string, (s: number, e: number) => Draft]> = [];
  const push = <K extends string>(table: Record<K, string[]>, make: (key: K, s: number, e: number) => Draft) => {
    for (const [key, terms] of Object.entries(table) as Array<[K, string[]]>) for (const term of terms) vocab.push([term, (s, e) => make(key, s, e)]);
  };
  push(EXPERIENCE_TERMS, (value, s, e) => ({ kind: 'experience', value, ...span(s, e) }));
  push(CONTENT_TERMS, (value, s, e) => ({ kind: 'content', value: value as 'profanity', ...span(s, e) }));
  push(COMPANION_TERMS, (value, s, e) => ({ kind: 'companion', value: value as 'partner', ...span(s, e) }));
  push(CATEGORY_TERMS, (value, s, e) => ({ kind: 'category', value, ...span(s, e) }));
  push(TOPIC_TERMS, (value, s, e) => ({ kind: 'topic', value, ...span(s, e) }));
  vocab.sort((a, b) => b[0].length - a[0].length);
  for (const [term, make] of vocab) for (const m of f.matchAll(termRegex(term))) add(make(m.index!, m.index! + m[0].length));

  // --- Party size: "dört kişiyiz", "4 kişi", "three people", "four of us", "üçümüz".
  const partyRes = [
    new RegExp(`${B}(${NUM})\\s*(?:kisi(?:[a-z]{0,6})|kisilik|people|persons|person|adults|yetiskin(?:[a-z]{0,4})|of us)${E}`, 'gu'),
    new RegExp(`${B}(iki|uc|dord|bes|alti|yedi|sekiz)(?:imiz|umuz|miz|muz)${E}`, 'gu'),
    new RegExp(`${B}(?:party|group) of (${NUM})${E}`, 'gu'),
  ];
  for (const [index, re] of partyRes.entries()) {
    for (const m of f.matchAll(re)) {
      const count = index === 1 ? ({ iki: 2, uc: 3, dord: 4, bes: 5, alti: 6, yedi: 7, sekiz: 8 } as Record<string, number>)[m[1]] : parseNumber(m[1]);
      if (!count || !Number.isInteger(count) || count < 1 || count > 1000) continue;
      add({ kind: 'party', count, ...span(m.index!, m.index! + m[0].length) });
    }
  }

  // --- Bare amounts with spending context but no currency ("bütçe 800", "800'ün altında").
  for (const m of f.matchAll(new RegExp(`${B}(\\d{2,6}(?:[.,]\\d{3})?)(?:'?[a-z]{0,6})?${E}`, 'gu'))) {
    const s = m.index!, e = s + m[0].length;
    if (!free(s, e)) continue;
    const context = f.slice(Math.max(0, s - 25), Math.min(f.length, e + 25));
    if (!/(?:butce|fiyat|ucret|bilet|budget|price|cost|spend|harca|para|ticket)/u.test(context)) continue;
    const amount = parseNumber(m[1]);
    if (amount !== null) add({ kind: 'amount', amount, currency: 'TRY', ...span(s, e) });
  }

  drafts.sort((a, b) => a.start - b.start);
  // A generic head noun right after a specific type names that same event ("stand-up gösterileri", "jazz concerts").
  for (let i = drafts.length - 1; i > 0; i--) {
    const d = drafts[i], prev = drafts[i - 1];
    if (d.kind === 'category' && d.value === 'show' && ['category', 'topic'].includes(prev.kind) && /^\s{0,2}$/u.test(text.slice(prev.end, d.start))) drafts.splice(i, 1);
  }
  return { folded: f, mentions: drafts.map((d, i) => ({ ...d, id: `m${i}` }) as Mention) };
}

/** Clause-like segments used as candidate spans for unsupported conditions. */
export function segments(text: string): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = [];
  const f = fold(text);
  const boundary = /[,;.!?]+|\s(?:ve|ama|fakat|ancak|veya|ya da|and|but|or)\s/gu;
  let last = 0;
  const push = (s: number, e: number) => {
    while (s < e && /\s/u.test(text[s])) s++;
    while (e > s && /[\s,;.!?]/u.test(text[e - 1])) e--;
    if (e > s) out.push({ start: s, end: e, text: text.slice(s, e) });
  };
  for (const m of f.matchAll(boundary)) {
    // Do not split decimal numbers / clocks such as 20.00 or 1.200.
    if (/^[.,]$/u.test(m[0]) && /\d/u.test(text[m.index! - 1] ?? '') && /\d/u.test(text[m.index! + 1] ?? '')) continue;
    push(last, m.index!);
    last = m.index! + m[0].length;
  }
  push(last, text.length);
  return out;
}
