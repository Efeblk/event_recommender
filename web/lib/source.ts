import { validDay } from './search.ts';
import type { EventRecord } from './types.ts';
export const SOURCE = 'https://biletinial.com';
export const LISTINGS = [
  { path: '/tr-tr/muzik/istanbul', category: 'Konser' },
  { path: '/tr-tr/tiyatro/istanbul', category: 'Tiyatro' },
  { path: '/tr-tr/etkinlikleri/stand-up', category: 'Stand-up' },
];
export function jsonLd(html: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  function visit(x: unknown) {
    if (Array.isArray(x)) x.forEach(visit);
    else if (x && typeof x === 'object') {
      const o = x as Record<string, unknown>;
      result.push(o);
      if (o['@graph']) visit(o['@graph']);
    }
  }
  for (const m of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse(m[1]));
    } catch {
      /* Ignore an invalid block; never infer dates from display text. */
    }
  }
  return result;
}
export function safeSourceUrl(raw: string): string | null {
  try {
    const u = new URL(raw, SOURCE);
    return u.protocol === 'https:' &&
      u.hostname === 'biletinial.com' &&
      /^\/tr-tr\/(muzik|tiyatro|gosteri|etkinlik)\/[^/]+$/.test(u.pathname)
      ? u.origin + u.pathname
      : null;
  } catch {
    return null;
  }
}
export function listingUrls(html: string): string[] {
  const urls: string[] = [];
  for (const node of jsonLd(html)) {
    if (Array.isArray(node.itemListElement))
      for (const item of node.itemListElement) {
        const u = safeSourceUrl(String(item?.url ?? item?.item?.url ?? ''));
        if (u) urls.push(u);
      }
  }
  if (!urls.length)
    for (const match of html.matchAll(/href=["']([^"']+)["']/g)) {
      const u = safeSourceUrl(match[1].trim());
      if (u) urls.push(u);
    }
  return [...new Set(urls)];
}
const clean = (x: unknown, max = 5000) =>
  typeof x === 'string'
    ? x
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? (x as Record<string, unknown>)
    : {};
async function idFor(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 24);
}
export async function parseEvents(
  html: string,
  url: string,
  category: string,
  now = new Date(),
): Promise<EventRecord[]> {
  if (!safeSourceUrl(url)) throw new Error('Unsupported source URL');
  const result: EventRecord[] = [];
  for (const e of jsonLd(html)) {
    const type = e['@type'];
    if (
      !(typeof type === 'string' && type.endsWith('Event')) &&
      !(Array.isArray(type) && type.some((t) => String(t).endsWith('Event')))
    )
      continue;
    const location = obj(e.location),
      address = obj(location.address),
      locality = clean(address.addressLocality);
    if (
      !/istanbul|İstanbul/i.test(locality + ' ' + clean(address.addressRegion))
    )
      continue;
    const title = clean(e.name, 250),
      venue = clean(location.name, 250),
      start = clean(e.startDate);
    if (
      !title ||
      !venue ||
      !validDay(start.slice(0, 10)) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(start) ||
      !Number.isFinite(Date.parse(start)) ||
      Date.parse(start) < now.getTime()
    )
      continue;
    const offers = Array.isArray(e.offers)
      ? e.offers.map(obj)
      : [obj(e.offers)];
    const status = clean(e.eventStatus);
    const cancelled = /Cancelled|Postponed|Rescheduled/.test(status);
    const available = offers.filter(
      (o) => !/SoldOut|OutOfStock|Discontinued/.test(clean(o.availability)),
    );
    const soldOut = offers.length > 0 && available.length === 0;
    const prices = available
      .filter(
        (o) =>
          o.price !== null &&
          o.price !== undefined &&
          o.price !== '' &&
          o.priceCurrency === 'TRY',
      )
      .map((o) => Number(o.price))
      .filter((p) => Number.isFinite(p) && p >= 0 && p <= 100000);
    const image = Array.isArray(e.image)
      ? e.image[0]
      : typeof e.image === 'object'
        ? obj(e.image).url
        : e.image;
    const imageUrl =
      typeof image === 'string' && image.startsWith('https://') ? image : '';
    const startsAt = new Date(start).toISOString();
    result.push({
      id: await idFor(url + '|' + startsAt + '|' + venue),
      title,
      description: clean(e.description),
      startsAt,
      venue,
      city: 'İstanbul',
      district: locality,
      address: clean(address.streetAddress, 500),
      price: prices.length ? Math.min(...prices) : null,
      currency: 'TRY',
      url,
      imageUrl,
      category: /stand[ -]?up/i.test(title) ? 'Stand-up' : category,
      availability: cancelled
        ? 'cancelled'
        : soldOut
          ? 'sold_out'
          : 'available',
      checkedAt: now.toISOString(),
    });
  }
  return [...new Map(result.map((e) => [e.id, e])).values()];
}
export async function fetchPage(url: string) {
  const u = new URL(url);
  if (u.origin !== SOURCE) throw new Error('Source not allowed');
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'BiPlan/0.1 (Istanbul event discovery)',
      'Accept-Language': 'tr-TR,tr;q=0.9',
    },
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!res.ok) throw new Error(`Source returned ${res.status}`);
  const text = await res.text();
  if (text.length > 4_000_000) throw new Error('Source response too large');
  return text;
}
export interface SyncReport {
  pages: number;
  events: number;
  failures: { url: string; error: string }[];
  sources: { url: string; events: EventRecord[] }[];
}
export async function collect(limitPerCategory = 8): Promise<SyncReport> {
  const report: SyncReport = { pages: 0, events: 0, failures: [], sources: [] };
  const seen = new Set<string>();
  for (const listing of LISTINGS) {
    let urls: string[];
    const listingUrl = SOURCE + listing.path;
    try {
      urls = listingUrls(await fetchPage(listingUrl)).slice(
        0,
        limitPerCategory,
      );
      if (!urls.length) throw new Error('No event links found');
    } catch {
      report.failures.push({ url: listingUrl, error: 'Liste okunamadı' });
      continue;
    }
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      await new Promise((r) => setTimeout(r, 450));
      try {
        const html = await fetchPage(url);
        const nodes = jsonLd(html);
        if (!nodes.some((e) => String(e['@type']).includes('Event')))
          throw new Error('Missing event schema');
        const events = await parseEvents(html, url, listing.category);
        report.sources.push({ url, events });
        report.pages++;
        report.events += events.length;
      } catch {
        report.failures.push({ url, error: 'Etkinlik doğrulanamadı' });
      }
    }
  }
  return report;
}
