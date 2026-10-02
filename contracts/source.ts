const SOURCE = 'https://biletinial.com';
const MAX_SOURCE_PRICE_TRY = Number.MAX_SAFE_INTEGER / 100;

export function jsonLd(html: string): Record<string, any>[] {
  const result: Record<string, any>[] = [];
  function visit(value: any) {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      result.push(value);
      if (value['@graph']) visit(value['@graph']);
      if (value.subEvent) visit(value.subEvent);
    }
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* another block may be valid */ }
  }
  return result;
}

export function safeSourceUrl(raw: string): string | null {
  try {
    const url = new URL(raw, SOURCE);
    return url.protocol === 'https:' && !url.username && !url.password &&
      ((url.hostname === 'biletinial.com' && /^\/tr-tr\/(muzik|tiyatro|gosteri|etkinlik|sinema|futbol|spor|opera-bale|egitim|seminer|eglence)\/[^/]+$/.test(url.pathname)) ||
       (url.hostname === 'www.bubilet.com.tr' && /^\/istanbul\/etkinlik\/[^/]+$/.test(url.pathname)))
      ? url.origin + url.pathname : null;
  } catch { return null; }
}

const clean = (value: unknown, max = 5000) => typeof value === 'string'
  ? value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().slice(0, max)
  : '';
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const validDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
async function idFor(text: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
    .map((value) => value.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

/** Legacy EventRecord parser retained as a dependency-free shared compatibility helper. */
export async function parseEvents(html: string, url: string, category: string, now = new Date()): Promise<any[]> {
  if (!safeSourceUrl(url)) throw new Error('Unsupported source URL');
  const result: any[] = [];
  for (const event of jsonLd(html)) {
    if (Array.isArray(event.subEvent) && event.subEvent.length) continue;
    const type = event['@type'];
    if (!(typeof type === 'string' && type.endsWith('Event')) && !(Array.isArray(type) && type.some((item) => String(item).endsWith('Event')))) continue;
    const location = object(event.location), address = object(location.address);
    const locality = clean(address.addressLocality);
    if (!/istanbul|İstanbul/i.test(locality + ' ' + clean(address.addressRegion))) continue;
    const title = clean(event.name, 250), venue = clean(location.name, 250), start = clean(event.startDate);
    if (!title || !venue || !validDay(start.slice(0, 10)) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:\d{2})$/.test(start) || !Number.isFinite(Date.parse(start)) || Date.parse(start) < now.getTime()) continue;
    const offers = Array.isArray(event.offers) ? event.offers.map(object) : [object(event.offers)];
    const status = clean(event.eventStatus), cancelled = /Cancelled|Postponed|Rescheduled/.test(status);
    const available = offers.filter((offer) => /(?:^|\/)(InStock|LimitedAvailability)$/.test(clean(offer.availability)));
    const unavailable = offers.filter((offer) => /SoldOut|OutOfStock|Discontinued/.test(clean(offer.availability)));
    const soldOut = offers.length > 0 && unavailable.length === offers.length;
    const prices = available.filter((offer) => offer.price !== null && offer.price !== undefined && offer.price !== '' && offer.priceCurrency === 'TRY')
      .map((offer) => Number(offer.price)).filter((price) => Number.isFinite(price) && price >= 0 && price <= MAX_SOURCE_PRICE_TRY);
    const image = Array.isArray(event.image) ? event.image[0] : typeof event.image === 'object' ? object(event.image).url : event.image;
    const startsAt = new Date(start).toISOString();
    result.push({
      id: await idFor(url + '|' + startsAt + '|' + venue), title, description: clean(event.description), startsAt, venue,
      city: 'İstanbul', district: locality, address: clean(address.streetAddress, 500), price: prices.length ? Math.min(...prices) : null,
      currency: 'TRY', url, imageUrl: typeof image === 'string' && image.startsWith('https://') ? image : '', category: /stand[ -]?up/i.test(title) ? 'Stand-up' : category,
      availability: cancelled ? 'cancelled' : soldOut ? 'sold_out' : available.length ? 'available' : 'unknown', checkedAt: now.toISOString(),
    });
  }
  return [...new Map(result.map((event) => [event.id, event])).values()];
}
