import type { EventRecord } from './types.ts';
import { CATEGORIES } from './types.ts';
import type { SourcePage } from './storage-contract.ts';
export const MAX_SOURCE_PAGE_EVENTS = 1000;
export const MAX_IMPORT_ENVELOPE_EVENTS = 2000;
export const MAX_EVENT_PRICE = Number.MAX_SAFE_INTEGER / 100;
export const MAX_IMPORT_TRANSIT_GRACE_MS = 60_000;
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
      /^\/tr-tr\/(muzik|tiyatro|gosteri|etkinlik|sinema|futbol|spor|opera-bale|egitim|seminer|eglence)\/[^/]+$/.test(url.pathname)
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
): SourcePage[] {
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
    const page = raw as { url?: unknown; events?: unknown; retiredAt?: unknown; quarantinedAt?: unknown; quarantineReason?: unknown } | null;
    const source = sourceOf(page?.url);
    if (
      !page ||
      !source ||
      typeof page.url !== 'string' ||
      urls.has(page.url) ||
      !Array.isArray(page.events) ||
      page.events.length > MAX_SOURCE_PAGE_EVENTS
    )
      throw new Error('Invalid source page');
    urls.add(page.url);
    const url = page.url;
    if (!page.events.length) {
      const quarantined = page.quarantinedAt !== undefined || page.quarantineReason !== undefined;
      if (page.retiredAt !== undefined && quarantined) throw new Error('Invalid empty source page');
      if (quarantined) {
        const stamp = typeof page.quarantinedAt === 'string' ? Date.parse(page.quarantinedAt) : NaN;
        if (page.quarantineReason !== 'session_time_conflict' || !Number.isFinite(stamp) ||
            new Date(stamp).toISOString() !== page.quarantinedAt || stamp > now.getTime() + 300000 ||
            stamp < now.getTime() - 72 * 3600000)
          throw new Error('Invalid source quarantine');
        return { url, events: [], quarantinedAt: page.quarantinedAt as string, quarantineReason: 'session_time_conflict' };
      }
      const retired = typeof page.retiredAt === 'string' ? Date.parse(page.retiredAt) : NaN;
      if (!Number.isFinite(retired) || new Date(retired).toISOString() !== page.retiredAt ||
          retired > now.getTime() + 300000 || retired < now.getTime() - 72 * 3600000)
        throw new Error('Invalid source retirement');
      return { url, events: [], retiredAt: page.retiredAt as string };
    }
    if (page.retiredAt !== undefined || page.quarantinedAt !== undefined || page.quarantineReason !== undefined)
      throw new Error('Nonempty inactive source');
    const events = page.events.map((rawEvent: unknown) => {
      const e = rawEvent as Record<string, unknown> | null;
      if (!e || ++count > MAX_IMPORT_ENVELOPE_EVENTS) throw new Error('Invalid event');
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
      if (e.sourceSessionIds !== undefined && (!Array.isArray(e.sourceSessionIds) || e.sourceSessionIds.length > 100 || e.sourceSessionIds.some((id) => typeof id !== 'string' || !id.length || id.length > 100)))
        throw new Error('Invalid source session IDs');
      for (const [key, max] of Object.entries({ sourceCategory: 250, sourceVersion: 40, extraction: 80 }))
        if (e[key] !== undefined && (typeof e[key] !== 'string' || (e[key] as string).length > max))
          throw new Error('Invalid source metadata');
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
        start < now.getTime() - MAX_IMPORT_TRANSIT_GRACE_MS ||
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
            e.price > MAX_EVENT_PRICE))
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
        ...(e.sourceSessionIds !== undefined ? { sourceSessionIds: e.sourceSessionIds } : {}),
        ...(e.sourceCategory !== undefined ? { sourceCategory: e.sourceCategory } : {}),
        ...(e.sourceVersion !== undefined ? { sourceVersion: e.sourceVersion } : {}),
        ...(e.extraction !== undefined ? { extraction: e.extraction } : {}),
      } as EventRecord;
    });
    return { url, events };
  });
}
