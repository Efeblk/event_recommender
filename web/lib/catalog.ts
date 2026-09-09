import type { EventRecord } from './types.ts';
import { CATEGORIES } from './types.ts';
export function sourceOf(raw: unknown): EventRecord['source'] | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    if (
      url.hostname === 'biletinial.com' &&
      /^\/tr-tr\/(muzik|tiyatro|gosteri|etkinlik)\/[^/]+$/.test(url.pathname)
    )
      return 'biletinial';
    if (
      url.hostname === 'www.bubilet.com.tr' &&
      /^\/istanbul\/etkinlik\/[^/]+$/.test(url.pathname)
    )
      return 'bubilet';
    if (
      url.hostname === 'www.biletix.com' &&
      /^\/etkinlik\/[A-Z0-9]+\/ISTANBUL\/tr$/.test(url.pathname)
    )
      return 'biletix';
  } catch {
    /* Invalid source. */
  }
  return null;
}
export function validateImport(
  value: unknown,
  now = new Date(),
): { url: string; events: EventRecord[] }[] {
  const payload = value as { schemaVersion?: unknown; pages?: unknown } | null;
  if (
    !payload ||
    payload.schemaVersion !== 1 ||
    !Array.isArray(payload.pages) ||
    !payload.pages.length ||
    payload.pages.length > 100
  )
    throw new Error('Invalid collection envelope');
  const ids = new Set<string>(),
    urls = new Set<string>();
  let count = 0;
  return payload.pages.map((raw: unknown) => {
    const page = raw as { url?: unknown; events?: unknown } | null;
    const source = sourceOf(page?.url);
    if (
      !page ||
      !source ||
      typeof page.url !== 'string' ||
      urls.has(page.url) ||
      !Array.isArray(page.events) ||
      !page.events.length ||
      page.events.length > 300
    )
      throw new Error('Invalid source page');
    urls.add(page.url);
    const url = page.url;
    const events = page.events.map((rawEvent: unknown) => {
      const e = rawEvent as Record<string, unknown> | null;
      if (!e || ++count > 2000) throw new Error('Invalid event');
      const limits: Record<string, number> = {
        id: 100,
        title: 250,
        description: 5000,
        venue: 250,
        district: 250,
        address: 500,
        startsAt: 40,
        checkedAt: 40,
        imageUrl: 2000,
      };
      for (const [key, max] of Object.entries(limits))
        if (typeof e[key] !== 'string' || e[key].length > max)
          throw new Error('Invalid event field');
      const start = Date.parse(e.startsAt as string),
        checked = Date.parse(e.checkedAt as string);
      if (
        !e.id ||
        !e.title ||
        !e.venue ||
        ids.has(e.id as string) ||
        e.url !== url ||
        e.source !== source ||
        e.city !== 'İstanbul' ||
        !CATEGORIES.includes(e.category as never) ||
        !['available', 'unknown', 'cancelled', 'sold_out'].includes(
          e.availability as string,
        )
      )
        throw new Error('Invalid event identity');
      if (
        !Number.isFinite(start) ||
        new Date(start).toISOString() !== e.startsAt ||
        start < now.getTime() ||
        start > now.getTime() + 730 * 86400000 ||
        !Number.isFinite(checked) ||
        new Date(checked).toISOString() !== e.checkedAt ||
        checked > now.getTime() + 300000 ||
        checked < now.getTime() - 72 * 3600000
      )
        throw new Error('Invalid event freshness');
      if (
        e.currency !== 'TRY' ||
        (e.price !== null &&
          (typeof e.price !== 'number' ||
            !Number.isFinite(e.price) ||
            e.price < 0 ||
            e.price > 50000))
      )
        throw new Error('Invalid price');
      if (e.imageUrl && !(e.imageUrl as string).startsWith('https://'))
        throw new Error('Invalid image');
      ids.add(e.id as string);
      // Explicitly pick the public contract; ignore arbitrary extra fields.
      return {
        id: e.id,
        title: e.title,
        description: e.description,
        startsAt: e.startsAt,
        checkedAt: e.checkedAt,
        venue: e.venue,
        district: e.district,
        address: e.address,
        city: 'İstanbul',
        currency: 'TRY',
        price: e.price,
        url,
        imageUrl: e.imageUrl,
        category: e.category,
        availability: e.availability,
        source,
      } as EventRecord;
    });
    return { url, events };
  });
}
