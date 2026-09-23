import {
  CATEGORIES,
  emptyFilters,
  type EventRecord,
  type Filters,
  type Category,
} from './types.ts';
import { positiveCategoryText, requestedCategories } from './intent.ts';
export const normalize = (s: string) =>
  s
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
export function todayInIstanbul(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function addDays(day: string, count: number) {
  return new Date(Date.parse(day + 'T12:00:00Z') + count * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function validDay(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v
  );
}
export function validateFilters(value: unknown): Filters {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Filtreler geçersiz.');
  const f = value as Record<string, unknown>;
  for (const key of ['dateFrom', 'dateTo'])
    if (f[key] != null && !validDay(f[key]))
      throw new Error('Tarih biçimi geçersiz.');
  if (
    f.maxPrice != null &&
    (typeof f.maxPrice !== 'number' ||
      !Number.isFinite(f.maxPrice) ||
      f.maxPrice < 0 ||
      f.maxPrice > 100000)
  )
    throw new Error('Bütçe 0–100.000 TL arasında olmalı.');
  if (f.category != null && !CATEGORIES.includes(f.category as never))
    throw new Error('Kategori geçersiz.');
  if (
    f.excludedCategories != null &&
    (!Array.isArray(f.excludedCategories) ||
      f.excludedCategories.some(
        (category) => !CATEGORIES.includes(category as never),
      ))
  )
    throw new Error('Hariç tutulan kategori geçersiz.');
  const result = {
    ...emptyFilters,
    ...Object.fromEntries(
      Object.keys(emptyFilters).map((k) => [k, f[k] ?? null]),
    ),
  } as Filters;
  const exclusions = [
    ...new Set((f.excludedCategories as Category[] | undefined) ?? []),
  ].filter((category) => category !== result.category);
  if (exclusions.length) result.excludedCategories = exclusions;
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo)
    throw new Error('Bitiş tarihi başlangıçtan önce olamaz.');
  return result;
}

export type ConstraintIssue =
  | 'budget_ambiguous'
  | 'date_ambiguous'
  | 'unsupported_location'
  | 'constraint_ambiguous';

const categoryTerms: Array<[Category, RegExp, RegExp]> = [
  [
    'Stand-up',
    /\b(?:stand[ -]?up|komedi|gulecek|gulelim)\b/,
    /\b(?:stand[ -]?up|komedi)\b/,
  ],
  ['Tiyatro', /\b(?:tiyatro|sahne oyunu)\b/, /\b(?:tiyatro|sahne oyunu)\b/],
  [
    'Konser',
    /\b(?:konser|muzik|caz|jazz|rock|akustik)\b/,
    /\b(?:konser|(?<!elektronik )muzik)\b/,
  ],
];

function parseCategories(q: string, previous: Filters) {
  let category = previous.category;
  const excluded = new Set(previous.excludedCategories ?? []);
  if (
    /her (?:tur|kategori)|kategori.*(?:kaldir|fark etmez|onemli degil)/.test(q)
  )
    return {
      category: null,
      excludedCategories: [] as Category[],
      ambiguous: false,
    };

  const negated = new Set<Category>();
  for (const [candidate, , exclusionTerms] of categoryTerms) {
    const suffix = '(?:istemiyorum|istemem|olmasin|haric|degil|disinda)';
    const hardNegation = new RegExp(
      `(${exclusionTerms.source})\\s+${suffix}`,
      'g',
    );
    if (hardNegation.test(q)) negated.add(candidate);
  }
  for (const candidate of negated) {
    excluded.add(candidate);
    if (category === candidate) category = null;
  }
  const positiveText = positiveCategoryText(q);
  const distinct = requestedCategories(positiveText);
  const hasChoice = /\b(?:veya|ya da|yahut)\b/.test(positiveText);
  if (distinct.length === 1) {
    category = distinct[0];
    excluded.delete(category);
    if (
      new RegExp(
        `\\b(?:sadece|yalniz)\\s+${categoryTerms.find(([c]) => c === category)![1].source}`,
      ).test(positiveText)
    )
      excluded.clear();
  }
  return {
    category,
    excludedCategories: [...excluded],
    ambiguous: distinct.length > 1 && (hasChoice || !negated.size),
  };
}

function budgetIssue(q: string): ConstraintIssue | null {
  if (
    /butce.*(?:yok|sinir.*yok|kaldir)|fiyat.*(?:onemli degil|fark etmez)|butcesiz|ucretsiz|bedava/.test(
      q,
    )
  )
    return null;
  if (/\bbutce(?:m|miz)?\s*-\s*\d/.test(q)) return 'budget_ambiguous';
  const currencyAmounts = [
    ...q.matchAll(
      /\b\d[\d.]*(?:,\d{1,2})?\s*(?:(?:tl|lira)(?=\s|$|[.,!?])|₺)/g,
    ),
  ];
  const bareBudget = q.match(/\bbutce(?:m|miz)?\s*(\d[\d.]*(?:,\d{1,2})?)/);
  const amounts = currencyAmounts.length
    ? currencyAmounts.map((match) => match[0])
    : bareBudget
      ? [bareBudget[1]]
      : [];
  if (amounts.length > 1) return 'budget_ambiguous';
  if (!amounts.length) return null;
  const amount = Number(
    amounts[0]
      .replace(/\s*(?:tl|lira|₺).*$/, '')
      .replaceAll('.', '')
      .replace(',', '.'),
  );
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000)
    return 'budget_ambiguous';
  if (/-\s*\d[\d.]*(?:,\d{1,2})?\s*(?:tl|lira|₺)/.test(q))
    return 'budget_ambiguous';
  const total = /\b(?:toplam|toplamda|butun grup|hepimiz icin)\b/.test(q);
  const perPerson = /\bkisi basi\b/.test(q);
  const numericParty = q.match(/\b([1-9]\d?)\s*kisi\b/);
  const wordParty = q.match(
    /\b(bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on)\s+kisi\b/,
  );
  const hasParty = Boolean(numericParty || wordParty);
  if (total && perPerson) return 'budget_ambiguous';
  if (total) return hasParty ? null : 'budget_ambiguous';
  if (hasParty && !perPerson) return 'budget_ambiguous';
  return null;
}

function unsupportedLocation(q: string) {
  const cities = [
    'adana',
    'adiyaman',
    'afyon',
    'afyonkarahisar',
    'agri',
    'aksaray',
    'amasya',
    'ankara',
    'antalya',
    'ardahan',
    'artvin',
    'aydin',
    'balikesir',
    'bartin',
    'batman',
    'bayburt',
    'bilecik',
    'bingol',
    'bitlis',
    'bolu',
    'burdur',
    'bursa',
    'canakkale',
    'cankiri',
    'corum',
    'denizli',
    'diyarbakir',
    'duzce',
    'edirne',
    'elazig',
    'erzincan',
    'erzurum',
    'eskisehir',
    'gaziantep',
    'giresun',
    'gumushane',
    'hakkari',
    'hatay',
    'igdir',
    'isparta',
    'izmir',
    'kahramanmaras',
    'karabuk',
    'karaman',
    'kars',
    'kastamonu',
    'kayseri',
    'kilis',
    'kirikkale',
    'kirklareli',
    'kirsehir',
    'kocaeli',
    'konya',
    'kutahya',
    'malatya',
    'manisa',
    'maras',
    'mardin',
    'mersin',
    'mugla',
    'mus',
    'nevsehir',
    'nigde',
    'ordu',
    'osmaniye',
    'rize',
    'sakarya',
    'samsun',
    'siirt',
    'sinop',
    'sivas',
    'sanliurfa',
    'sirnak',
    'tekirdag',
    'tokat',
    'trabzon',
    'tunceli',
    'urfa',
    'usak',
    'van',
    'yalova',
    'yozgat',
    'zonguldak',
  ];
  return cities.some((city) => {
    const matches = [...q.matchAll(new RegExp(`\\b${city}\\b`, 'g'))];
    return matches.some((match) => {
      const index = match.index ?? 0;
      const after = q.slice(
        index + match[0].length,
        index + match[0].length + 24,
      );
      const before = q.slice(Math.max(0, index - 14), index);
      if (city === 'van' && /^\s+gogh\b/.test(after)) return false;
      return (
        !/^(?:['’]?[a-z]{0,5})?\s*(?:degil|haric|disinda|istemiyorum)\b/.test(
          after,
        ) && !/(?:degil|haric|disinda)\s*$/.test(before)
      );
    });
  });
}

function dateIssue(q: string): ConstraintIssue | null {
  const iso = [...q.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]);
  if (iso.length)
    return iso.length <= 2 && iso.every(validDay) ? null : 'date_ambiguous';
  if (/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/.test(q)) return 'date_ambiguous';
  if (
    /\b\d{1,2}\s+(?:ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b/.test(
      q,
    )
  )
    return 'date_ambiguous';
  if (/\bgelecek hafta\b/.test(q)) return 'date_ambiguous';
  if (
    /\b(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\s+(?:degil|haric)\b/.test(
      q,
    )
  )
    return 'date_ambiguous';
  const dateSalient =
    /\b(?:tarih|gun|hafta|haftasonu|ay|ayin|bugun|yarin|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\b/.test(
      q,
    ) || /\bbu aksam\b/.test(q);
  if (!dateSalient) return null;
  if (/tarih.*(?:fark etmez|kaldir)|herhangi bir gun/.test(q)) return null;
  const supported =
    /\b(?:bugun|bu aksam|yarin|hafta sonu|haftasonu|bu hafta|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\b/.test(
      q,
    );
  return supported ? null : 'date_ambiguous';
}
export function parseFilters(
  message: string,
  previous: Filters = emptyFilters,
  now = new Date(),
): Filters {
  const q = normalize(message);
  const f = { ...previous };
  const today = todayInIstanbul(now);
  if (
    /butce.*(yok|sinir.*yok|kaldir)|fiyat.*(onemli degil|fark etmez)|butcesiz/.test(
      q,
    )
  )
    f.maxPrice = null;
  else {
    const money =
      q.match(/(\d[\d.]*(?:,\d{1,2})?)\s*(?:tl|₺|lira)/) ||
      q.match(/butce(?:m|miz)?\s*(\d[\d.]*)/);
    if (money) {
      let amount = Number(money[1].replaceAll('.', '').replace(',', '.'));
      if (/\b(?:toplam|toplamda|butun grup|hepimiz icin)\b/.test(q)) {
        const numericParty = q.match(/\b([1-9]\d?)\s*kisi\b/);
        const wordParty = q.match(
          /\b(bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on)\s+kisi\b/,
        );
        const wordNumbers: Record<string, number> = {
          bir: 1,
          iki: 2,
          uc: 3,
          dort: 4,
          bes: 5,
          alti: 6,
          yedi: 7,
          sekiz: 8,
          dokuz: 9,
          on: 10,
        };
        const partySize = numericParty
          ? Number(numericParty[1])
          : wordParty
            ? wordNumbers[wordParty[1]]
            : null;
        if (partySize) amount /= partySize;
      }
      f.maxPrice = amount;
    }
    if (/ucretsiz|bedava/.test(q)) f.maxPrice = 0;
  }
  const parsedCategories = parseCategories(q, f);
  f.category = parsedCategories.category;
  f.excludedCategories = parsedCategories.excludedCategories;
  if (/tarih.*(fark etmez|kaldir)|herhangi bir gun/.test(q)) {
    f.dateFrom = null;
    f.dateTo = null;
  } else if (/yarin/.test(q)) {
    f.dateFrom = addDays(today, 1);
    f.dateTo = f.dateFrom;
  } else if (/bugun|bu aksam/.test(q)) {
    f.dateFrom = today;
    f.dateTo = today;
  } else if (/hafta sonu|haftasonu/.test(q)) {
    const day = new Date(today + 'T12:00:00Z').getUTCDay();
    const delta = day === 0 ? 0 : (6 - day + 7) % 7;
    f.dateFrom = addDays(today, delta);
    f.dateTo = addDays(f.dateFrom, day === 0 ? 0 : 1);
    if (/gelecek|onumuzdeki/.test(q) && day >= 6) {
      f.dateFrom = addDays(today, (6 - day + 7) % 7 || 7);
      f.dateTo = addDays(f.dateFrom, 1);
    }
  } else if (/bu hafta/.test(q)) {
    const day = new Date(today + 'T12:00:00Z').getUTCDay();
    f.dateFrom = today;
    f.dateTo = addDays(today, (7 - day) % 7);
  } else {
    const iso = q.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
    if (iso?.length && iso.every(validDay)) {
      f.dateFrom = iso[0];
      f.dateTo = iso[1] || iso[0];
    } else {
      const weekdays = [
        'pazar',
        'pazartesi',
        'sali',
        'carsamba',
        'persembe',
        'cuma',
        'cumartesi',
      ];
      const found = weekdays.findIndex((d) => new RegExp(`\\b${d}\\b`).test(q));
      if (found >= 0) {
        f.dateFrom = addDays(
          today,
          (found - new Date(today + 'T12:00:00Z').getUTCDay() + 7) % 7,
        );
        f.dateTo = f.dateFrom;
      }
    }
  }
  return validateFilters(f);
}

export function interpretConstraints(
  message: string,
  previous: Filters = emptyFilters,
  now = new Date(),
): { filters: Filters; issue: ConstraintIssue | null } {
  const q = normalize(message);
  const previousFilters = validateFilters(previous);
  const category = parseCategories(q, previous);
  let issue: ConstraintIssue | null = null;
  if (unsupportedLocation(q)) issue = 'unsupported_location';
  else if (budgetIssue(q)) issue = 'budget_ambiguous';
  else if (dateIssue(q)) issue = 'date_ambiguous';
  else if (category.ambiguous) issue = 'constraint_ambiguous';
  if (issue) return { filters: previousFilters, issue };
  try {
    return {
      filters: parseFilters(message, previousFilters, now),
      issue: null,
    };
  } catch {
    const dateLike =
      /\b(?:tarih|gun|hafta|ay|bugun|yarin|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\b/.test(
        q,
      ) || /\b\d{4}-\d{2}-\d{2}\b/.test(q);
    const budgetLike = /\b(?:butce|fiyat|tl|lira|ucretsiz|bedava)\b|₺/.test(q);
    return {
      filters: previousFilters,
      issue: dateLike
        ? 'date_ambiguous'
        : budgetLike
          ? 'budget_ambiguous'
          : 'constraint_ambiguous',
    };
  }
}
export function isEligible(
  e: EventRecord,
  f: Filters,
  now = new Date(),
): boolean {
  const start = Date.parse(e.startsAt),
    checked = Date.parse(e.checkedAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(checked) ||
    start < now.getTime() ||
    checked < now.getTime() - 72 * 3600000 ||
    checked > now.getTime() + 300000 ||
    e.city !== 'İstanbul' ||
    e.availability !== 'available'
  )
    return false;
  const day = todayInIstanbul(new Date(start));
  return (
    (!f.dateFrom || day >= f.dateFrom) &&
    (!f.dateTo || day <= f.dateTo) &&
    (!f.category || e.category === f.category) &&
    !(f.excludedCategories ?? []).includes(e.category as Category) &&
    (f.maxPrice === null ||
      (e.price !== null && e.currency === 'TRY' && e.price <= f.maxPrice))
  );
}
export function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
const stop = new Set([
  'bir',
  'biraz',
  'icin',
  'olsun',
  'bana',
  'gore',
  'olan',
  'var',
  'neler',
  'ne',
  'bu',
  've',
  'ile',
  'etkinlik',
  'istiyorum',
  'plan',
  'daha',
  'tl',
  'lira',
  'hafta',
  'sonu',
]);
export function rankEvents(
  events: EventRecord[],
  query: string,
  queryVector: number[] | null = null,
  vectors = new Map<string, number[]>(),
) {
  const tokens = normalize(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !stop.has(t));
  return events
    .map((e) => {
      const text = normalize(
        e.title + ' ' + e.description + ' ' + e.venue + ' ' + e.category,
      );
      const lexical =
        tokens.reduce((sum, t) => sum + (text.includes(t) ? 1 : 0), 0) /
        Math.max(tokens.length, 1);
      const vector = vectors.get(e.id);
      return {
        event: e,
        score:
          lexical * 0.35 +
          (queryVector && vector ? cosine(queryVector, vector) * 0.65 : 0),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score || a.event.startsAt.localeCompare(b.event.startsAt),
    )
    .map((x) => x.event);
}
export const productionIdentity = (event: EventRecord) =>
  event.canonicalProductionKey || event.productionKey || event.url;
export function uniqueEvents(events: EventRecord[], limit = 5) {
  const seen = new Set<string>();
  return events
    .filter((e) => {
      const key = productionIdentity(e);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
export function sourceReason(e: EventRecord, f: Filters) {
  return [
    f.category
      ? `${e.category} tercihinle eşleşiyor.`
      : `${e.category} kategorisinden bir seçenek.`,
    f.maxPrice !== null
      ? `İlan edilen başlangıç fiyatı kişi başı bütçene uyuyor.`
      : null,
    f.dateFrom ? 'Seçtiğin tarih aralığında.' : null,
  ]
    .filter(Boolean)
    .join(' ');
}
