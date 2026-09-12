import {
  CATEGORIES,
  emptyFilters,
  type EventRecord,
  type Filters,
} from './types.ts';
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
  const result = {
    ...emptyFilters,
    ...Object.fromEntries(
      Object.keys(emptyFilters).map((k) => [k, f[k] ?? null]),
    ),
  } as Filters;
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo)
    throw new Error('Bitiş tarihi başlangıçtan önce olamaz.');
  return result;
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
    if (money)
      f.maxPrice = Number(money[1].replaceAll('.', '').replace(',', '.'));
    if (/ucretsiz|bedava/.test(q)) f.maxPrice = 0;
  }
  if (/her (tur|kategori)|kategori.*(kaldir|fark etmez)/.test(q))
    f.category = null;
  else if (/stand[ -]?up|komedi|gulecek|gulelim/.test(q))
    f.category = 'Stand-up';
  else if (/tiyatro|sahne oyunu/.test(q)) f.category = 'Tiyatro';
  else if (/konser|muzik|caz|jazz|rock|akustik/.test(q)) f.category = 'Konser';
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
  event.productionKey || event.url;
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
