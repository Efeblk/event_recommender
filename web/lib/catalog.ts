import type { EventRecord } from './types.ts';
import { CATEGORIES } from './types.ts';
import { parseAttendanceTiming } from './event-timing.ts';
import type { SourcePage } from './storage-contract.ts';
import { isSourceQuarantineReason } from '../../contracts/source-evidence.ts';
import {
  PROVIDER_LISTING_VERSION,
  validateProviderListing,
  type ProviderListingV1,
} from '../../contracts/listing.ts';
import {
  categoryForEvent,
  categoryFromSource,
} from '../../contracts/category.ts';
export const MAX_SOURCE_PAGE_EVENTS = 1000;
export const MAX_IMPORT_ENVELOPE_EVENTS = 2000;
export const MAX_EVENT_PRICE = Number.MAX_SAFE_INTEGER / 100;
export const MAX_IMPORT_TRANSIT_GRACE_MS = 60_000;

function cleanListingText(value: string | undefined): string {
  return (value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

/** Keep retained evidence richer than EventRecord, but bind every field
 * projected by collector/extract.listingToEvent to that compatibility record. */
function providerListingMatchesEvent(
  listing: ProviderListingV1,
  event: Record<string, unknown>,
  source: EventRecord['source'],
  pageUrl: string,
  attendanceTiming: EventRecord['attendanceTiming'],
): boolean {
  const availablePrices = listing.tiers
    .filter(
      (tier) =>
        tier.availability === 'available' && typeof tier.price === 'number',
    )
    .map((tier) => tier.price as number);
  const price = availablePrices.length ? Math.min(...availablePrices) : null;
  const currency = listing.tiers.find((tier) => tier.currency)?.currency ?? 'TRY';
  const listingAttendance = parseAttendanceTiming(listing.attendanceTiming);
  const currentCategory = categoryForEvent(
    listing.category,
    listing.title,
    listing.description,
  );
  const retainedCategory = categoryFromSource(listing.category);
  // Retained provider-listing.v1 records predate the two narrowly verified
  // format repairs. The materializer applies these same repairs before search.
  // Preserve the immutable raw category here; keep every other transition
  // strict so an arbitrary category cannot cross the import boundary.
  const categoryMatches =
    event.category === currentCategory ||
    (currentCategory === 'Stand-up' &&
      retainedCategory === 'Tiyatro' &&
      event.category === 'Tiyatro') ||
    (currentCategory === 'Gezi' &&
      retainedCategory === 'Sergi' &&
      event.category === 'Sergi');
  return (
    listing.listingId.slice(0, 24) === event.id &&
    listing.provider === source &&
    listing.url === pageUrl &&
    listing.startsAt === event.startsAt &&
    listing.observedAt === event.checkedAt &&
    cleanListingText(listing.title).slice(0, 250) === event.title &&
    cleanListingText(listing.description).slice(0, 5000) ===
      event.description &&
    cleanListingText(listing.venue.name).slice(0, 250) === event.venue &&
    cleanListingText(listing.venue.district) === event.district &&
    cleanListingText(listing.venue.address).slice(0, 500) === event.address &&
    (listing.city || 'İstanbul') === event.city &&
    price === event.price &&
    currency === event.currency &&
    (listing.imageUrl ?? '') === event.imageUrl &&
    categoryMatches &&
    listing.availability === event.availability &&
    sameStrings(event.sourceSessionIds, listing.providerSessionIds) &&
    event.sourceCategory === listing.category &&
    event.sourceVersion === PROVIDER_LISTING_VERSION &&
    event.extraction === listing.extractorVersion &&
    JSON.stringify(listingAttendance) === JSON.stringify(attendanceTiming)
  );
}

/** Remove preparation-only evidence from records crossing a public API boundary. */
export function publicEventRecord(event: EventRecord): EventRecord {
  const {
    preparedSearch: _preparedSearch,
    providerListing: _providerListing,
    ...publicEvent
  } = event;
  return publicEvent;
}
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
        if (!isSourceQuarantineReason(page.quarantineReason) || !Number.isFinite(stamp) ||
            new Date(stamp).toISOString() !== page.quarantinedAt || stamp > now.getTime() + 300000 ||
            stamp < now.getTime() - 72 * 3600000)
          throw new Error('Invalid source quarantine');
        return { url, events: [], quarantinedAt: page.quarantinedAt as string, quarantineReason: page.quarantineReason };
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
      const attendanceTiming = parseAttendanceTiming(e.attendanceTiming);
      const providerListing = e.providerListing === undefined ? undefined : validateProviderListing(e.providerListing);
      if (
        providerListing &&
        !providerListingMatchesEvent(
          providerListing,
          e,
          source,
          url,
          attendanceTiming,
        )
      )
        throw new Error('Provider listing does not match imported event');
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
        ...(attendanceTiming ? { attendanceTiming } : {}),
        ...(providerListing ? { providerListing } : {}),
      } as EventRecord;
    });
    return { url, events };
  });
}
