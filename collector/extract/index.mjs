import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { PROVIDER_LISTING_VERSION, expectedProviderListingId, validateProviderListing } from '../../contracts/listing.ts';
import { categoryForEvent } from '../../contracts/category.ts';
import { jsonLd } from '../../contracts/source.ts';
import { extract as extractLegacyEventRecords } from '../adapters.mjs';
import { verifiedBubiletDetailInventory } from '../bubilet.mjs';

export const EXTRACTOR_VERSION = Object.freeze({
  biletix: 'biletix-provider-listing.v1',
  bubilet: 'bubilet-provider-listing.v1',
  biletinial: 'biletinial-provider-listing.v1',
});

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const text = (value) => typeof value === 'string' ? value : '';
const cleaned = (value) => text(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const uniqueStrings = (values) => [...new Set(values.filter((value) => typeof value === 'string' || Number.isInteger(value)).map(String))];

export function rawObjectRefForBody(body) {
  if (typeof body !== 'string') throw new Error('raw_body_required');
  const hash = sha256(Buffer.from(body, 'utf8'));
  return { sha256: hash, key: `bodies/${hash}.bin`, bytes: Buffer.byteLength(body, 'utf8') };
}

function assertRawObjectRef(ref, body) {
  if (!ref || typeof ref !== 'object') throw new Error('raw_object_ref_required');
  const expected = rawObjectRefForBody(body);
  if (ref.sha256 !== expected.sha256 || ref.key !== expected.key || ref.bytes !== expected.bytes)
    throw new Error('raw_object_ref_mismatch');
  return { sha256: ref.sha256, key: ref.key, bytes: ref.bytes };
}

function suppliedResponse(input, url, { requireRetained = true } = {}) {
  const value = input instanceof Map ? input.get(url) : input?.[url];
  if (value === undefined) return null;
  const body = typeof value === 'string' ? value : value?.body;
  if (typeof body !== 'string') throw new Error(`supplementary_body_missing:${url}`);
  if (requireRetained && (!value || typeof value !== 'object' || !value.rawObjectRef || !value.fetchedAt || !value.url))
    throw new Error(`supplementary_response_not_retained:${url}`);
  const rawObjectRef = value?.rawObjectRef ? assertRawObjectRef(value.rawObjectRef, body) : rawObjectRefForBody(body);
  const fetchedAt = value?.fetchedAt;
  if (fetchedAt !== undefined && (!Number.isFinite(Date.parse(fetchedAt)) || new Date(Date.parse(fetchedAt)).toISOString() !== fetchedAt))
    throw new Error(`supplementary_fetched_at_invalid:${url}`);
  return { body, rawObjectRef, fetchedAt, url: value?.url ?? url };
}

function tierAvailability(raw, active) {
  if (/Cancelled|Postponed|Rescheduled/i.test(raw)) return 'cancelled';
  if (/SoldOut|OutOfStock|Discontinued|closed|s00_closed/i.test(raw)) return 'sold_out';
  if (active === true || /InStock|LimitedAvailability|onsale|s01_onsale/i.test(raw)) return 'available';
  return 'unknown';
}

function offerTiers(rawOffers) {
  const offers = Array.isArray(rawOffers) ? rawOffers : rawOffers && typeof rawOffers === 'object' ? [rawOffers] : [];
  return offers.map((offer) => {
    const rawAvailability = text(offer.availability);
    const numeric = offer.price === '' || offer.price == null ? null : Number(offer.price);
    return {
      ...(offer.sku == null && offer['@id'] == null ? {} : { providerTierId: String(offer.sku ?? offer['@id']) }),
      ...(typeof offer.name === 'string' ? { name: offer.name } : {}),
      price: Number.isFinite(numeric) && numeric >= 0 ? numeric : null,
      currency: text(offer.priceCurrency) || 'TRY',
      availability: tierAvailability(rawAvailability),
      ...(rawAvailability ? { rawAvailability } : {}),
    };
  });
}

function eventNodeFor(nodes, event) {
  return nodes.find((node) => {
    const type = [node?.['@type']].flat();
    if (!type.some((item) => typeof item === 'string' && item.endsWith('Event')) || Array.isArray(node.subEvent) && node.subEvent.length) return false;
    return Number.isFinite(Date.parse(node.startDate)) && new Date(node.startDate).toISOString() === event.startsAt && cleaned(node.location?.name) === event.venue;
  });
}

function geoFrom(node) {
  const latitude = Number(node?.location?.geo?.latitude), longitude = Number(node?.location?.geo?.longitude);
  return Number.isFinite(latitude) && latitude >= -90 && latitude <= 90 && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180
    ? { lat: latitude, lon: longitude } : undefined;
}

function optionalId(...values) {
  const value = values.find((candidate) => (typeof candidate === 'string' && candidate.trim()) || Number.isInteger(candidate));
  return value == null ? undefined : String(value);
}

function istanbulWallTime(instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

function timezoneEvidence(sourceValue, fallbackKind = 'explicit_offset') {
  if (typeof sourceValue === 'number') return { kind: 'unix_epoch_ms', sourceValue: String(sourceValue) };
  if (typeof sourceValue === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(sourceValue)) return { kind: 'explicit_offset', sourceValue };
  return { kind: fallbackKind, sourceValue: String(sourceValue) };
}

export function providerListingId({ provider, providerEventId, url, providerSessionIds, startsAt }) {
  return expectedProviderListingId({ provider, providerEventId, url, providerSessionIds, startsAt });
}

function commonListing(event, envelope, rawObjectRef, fields) {
  const providerSessionIds = uniqueStrings(fields.providerSessionIds ?? event.sourceSessionIds ?? []);
  const supplementaryRawObservations = [...new Map((fields.supplementaryRawObservations ?? []).map((observation) => [
    `${observation.url}\n${observation.fetchedAt}\n${observation.rawObjectRef.sha256}`, observation,
  ])).values()];
  const supplementaryRawObjectRefs = [...new Map(supplementaryRawObservations.map((observation) => [observation.rawObjectRef.sha256, observation.rawObjectRef])).values()];
  const listing = {
    contractVersion: PROVIDER_LISTING_VERSION,
    provider: envelope.provider,
    ...(fields.providerEventId ? { providerEventId: String(fields.providerEventId) } : {}),
    providerSessionIds,
    url: event.url,
    title: fields.title,
    description: fields.description,
    category: fields.category,
    startsAt: event.startsAt,
    timezoneEvidence: fields.timezoneEvidence,
    venue: fields.venue,
    tiers: fields.tiers,
    availability: event.availability,
    ...(event.attendanceTiming ? { attendanceTiming: event.attendanceTiming } : {}),
    observedAt: envelope.fetchedAt,
    extractorVersion: EXTRACTOR_VERSION[envelope.provider],
    rawObjectRef,
    ...(supplementaryRawObjectRefs.length ? { supplementaryRawObjectRefs } : {}),
    ...(supplementaryRawObservations.length ? { supplementaryRawObservations } : {}),
    ...(event.imageUrl ? { imageUrl: event.imageUrl } : {}),
    city: 'İstanbul',
  };
  listing.listingId = providerListingId(listing);
  return listing;
}

function biletixListings($, events, envelope, rawObjectRef) {
  let state;
  try { state = JSON.parse($('#ng-state').text()); } catch { throw new Error('schema_missing'); }
  const code = new URL(envelope.url).pathname.split('/')[2];
  const responses = Object.values(state).filter((entry) => entry?.b?.status === 'SUCCESS' && typeof entry.u === 'string');
  const detail = responses.map((response) => response.b.data).find((value) => value && !Array.isArray(value) && value.eventCode === code);
  const performances = responses.find((response) => response.u.includes(`/getPerformanceList/${code}/`))?.b?.data ?? [];
  return events.map((event) => {
    const rows = performances.filter((row) => row.eventCode === code && Number(row.performanceDate) === Date.parse(event.startsAt) && cleaned(row.venueName) === event.venue);
    const tiers = rows.map((row) => {
      const rawAvailability = text(row.status);
      return {
        ...(row.performanceCode == null ? {} : { providerTierId: String(row.performanceCode) }),
        ...(typeof (row.longName || row.shortName || row.description) === 'string' ? { name: row.longName || row.shortName || row.description } : {}),
        price: Number.isSafeInteger(row.minPrice) && row.minPrice >= 0 ? row.minPrice / 100 : null,
        currency: 'TRY', availability: tierAvailability(rawAvailability, row.active), ...(rawAvailability ? { rawAvailability } : {}),
      };
    });
    const description = [detail?.eventDescription, ...[detail?.info, detail?.eventRules].flat()].filter((value) => typeof value === 'string').join('\n');
    return commonListing(event, envelope, rawObjectRef, {
      providerEventId: detail?.eventCode ?? code,
      providerSessionIds: rows.map((row) => row.performanceCode),
      title: text(detail?.eventName) || event.title,
      description,
      category: text(detail?.subCategory || detail?.eventCategoryCode) || event.sourceCategory || event.category,
      timezoneEvidence: timezoneEvidence(rows[0]?.performanceDate),
      venue: {
        name: text(rows[0]?.venueName) || event.venue,
        ...(optionalId(rows[0]?.venueId, rows[0]?.venueCode, detail?.venueId, detail?.venueCode) ? { providerVenueId: optionalId(rows[0]?.venueId, rows[0]?.venueCode, detail?.venueId, detail?.venueCode) } : {}),
        ...(typeof detail?.venueTown === 'string' ? { district: detail.venueTown } : {}),
      },
      tiers,
    });
  });
}

async function bubiletListings($, events, envelope, rawObjectRef, get, supplementaryRefs) {
  const slug = new URL(envelope.url).pathname.split('/').at(-1);
  const inventory = await verifiedBubiletDetailInventory($, slug, get);
  const nodes = jsonLd(envelope.body), base = nodes.find((node) => node?.['@type'] === 'Event' && typeof node.name === 'string');
  return events.map((event) => {
    const rows = inventory.eventSessions.filter((row) => new Date(row.date).toISOString() === event.startsAt && cleaned(row.venueName) === event.venue);
    const node = eventNodeFor(nodes, event);
    const address = node?.location?.address;
    const tiers = rows.map((row) => ({
      ...(row.sessionId == null ? {} : { providerTierId: String(row.sessionId) }),
      ...(typeof row.sessionName === 'string' && row.sessionName ? { name: row.sessionName } : {}),
      price: typeof row.price === 'number' && Number.isFinite(row.price) && row.price >= 0 ? row.price : null,
      currency: 'TRY',
      availability: row.isMarkedSoldOut === true ? 'sold_out' : row.promoteOnly === false && row.isSelectable === true && row.isCombinedTicket !== true && row.isSeasonTicketRenewalOpen !== true ? 'available' : 'unknown',
      rawAvailability: row.isMarkedSoldOut === true ? 'isMarkedSoldOut' : row.promoteOnly === true ? 'promoteOnly' : row.isSelectable === true ? 'isSelectable' : 'unknown',
    }));
    const geo = geoFrom(node);
    return commonListing(event, envelope, rawObjectRef, {
      providerEventId: inventory.eventId,
      providerSessionIds: rows.map((row) => row.sessionId),
      title: text(base?.name) || event.title,
      description: text(base?.description),
      category: event.sourceCategory || event.category,
      timezoneEvidence: timezoneEvidence(rows[0]?.date ?? node?.startDate),
      venue: {
        name: text(rows[0]?.venueName) || text(node?.location?.name) || event.venue,
        ...(optionalId(rows[0]?.venueId, node?.location?.identifier, node?.location?.['@id']) ? { providerVenueId: optionalId(rows[0]?.venueId, node?.location?.identifier, node?.location?.['@id']) } : {}),
        ...(typeof address?.streetAddress === 'string' ? { address: address.streetAddress } : {}),
        ...(typeof address?.addressLocality === 'string' && !/^istanbul$/iu.test(address.addressLocality) ? { district: address.addressLocality } : {}),
        ...(geo ? { geo } : {}),
      }, tiers, supplementaryRawObservations: supplementaryRefs,
    });
  });
}

function biletinialListings(events, envelope, rawObjectRef, supplementaryRefs) {
  const nodes = jsonLd(envelope.body);
  const movie = nodes.find((node) => [node?.['@type']].flat().includes('Movie'));
  const eventId = envelope.body.match(/\bvar\s+eventId\s*=\s*(\d+)\s*;/)?.[1];
  return events.map((event) => {
    const node = eventNodeFor(nodes, event), address = node?.location?.address;
    const tiers = offerTiers(node?.offers);
    const rawStart = node?.startDate ?? event.startsAt;
    return commonListing(event, envelope, rawObjectRef, {
      providerEventId: eventId,
      providerSessionIds: event.sourceSessionIds,
      title: text(node?.name ?? movie?.name) || event.title,
      description: text(node?.description ?? movie?.description),
      category: event.sourceCategory || envelope.fallbackCategory || event.category,
      timezoneEvidence: event.extraction === 'cinema-public-session-html'
        ? { kind: 'istanbul_wall_time', sourceValue: istanbulWallTime(event.startsAt) }
        : timezoneEvidence(rawStart),
      venue: {
        name: text(node?.location?.name) || event.venue,
        ...(optionalId(node?.location?.identifier, node?.location?.['@id']) ? { providerVenueId: optionalId(node?.location?.identifier, node?.location?.['@id']) } : {}),
        ...(typeof address?.streetAddress === 'string' ? { address: address.streetAddress } : {}),
        ...(typeof (node?.districtName ?? node?.location?.districtName ?? address?.districtName ?? address?.addressLocality) === 'string'
          ? { district: node?.districtName ?? node?.location?.districtName ?? address?.districtName ?? address?.addressLocality } : {}),
        ...(geoFrom(node) ? { geo: geoFrom(node) } : {}),
      }, tiers, supplementaryRawObservations: supplementaryRefs,
    });
  });
}

async function extractWithGetter(envelope, options, suppliedGet) {
  if (!envelope || typeof envelope.body !== 'string' || typeof envelope.url !== 'string' || !EXTRACTOR_VERSION[envelope.provider]) throw new Error('invalid_raw_envelope');
  if (!Number.isFinite(Date.parse(envelope.fetchedAt))) throw new Error('invalid_fetched_at');
  // Pure replay verifies the body/ref binding. The Cheerio compatibility entry
  // receives a serialized DOM, while its ref intentionally names the exact
  // pre-decode response retained by the caller.
  const rawObjectRef = options.verifyPrimaryRawRef === false
    ? { sha256: envelope.rawObjectRef.sha256, key: envelope.rawObjectRef.key, bytes: envelope.rawObjectRef.bytes }
    : assertRawObjectRef(envelope.rawObjectRef, envelope.body);
  const $ = load(envelope.body), now = options.now ? new Date(options.now) : new Date(envelope.fetchedAt);
  if (!Number.isFinite(now.getTime())) throw new Error('invalid_extraction_time');
  const supplementaryRefs = [], get = async (url) => {
    const result = await suppliedGet(url);
    if (!result || typeof result.body !== 'string' || !result.fetchedAt || !result.url || !result.rawObjectRef)
      throw new Error(`supplementary_response_not_retained:${url}`);
    const ref = assertRawObjectRef(result.rawObjectRef, result.body);
    if (!Number.isFinite(Date.parse(result.fetchedAt)) || new Date(Date.parse(result.fetchedAt)).toISOString() !== result.fetchedAt)
      throw new Error(`supplementary_fetched_at_invalid:${url}`);
    supplementaryRefs.push({ url: result.url, fetchedAt: result.fetchedAt, rawObjectRef: ref });
    return result.body;
  };
  const fallbackCategory = options.fallbackCategory ?? envelope.fallbackCategory ?? null;
  const events = await extractLegacyEventRecords($, envelope.provider, envelope.url, fallbackCategory, now, { get });
  const listings = envelope.provider === 'biletix'
    ? biletixListings($, events, envelope, rawObjectRef)
    : envelope.provider === 'bubilet'
      ? await bubiletListings($, events, envelope, rawObjectRef, get, supplementaryRefs)
      : biletinialListings(events, envelope, rawObjectRef, supplementaryRefs);
  return listings.map(validateProviderListing);
}

/** Pure extraction: all provider responses must be supplied up front. */
export async function extractProviderListings(envelope, options = {}) {
  return extractWithGetter(envelope, options, async (url) => {
    const response = suppliedResponse(options.supplementaryResponses, url);
    if (!response) throw new Error(`supplementary_response_missing:${url}`);
    return response;
  });
}

/** Existing collector orchestration adapter. Network is delegated to the caller. */
export async function extractListings($, source, url, fallbackCategory, now = new Date(), options = {}) {
  const retainedPrimary = suppliedResponse(options.supplementaryResponses, url);
  if (!retainedPrimary) throw new Error(`primary_response_not_retained:${url}`);
  const body = retainedPrimary.body;
  const rawObjectRef = options.rawObjectRef ?? retainedPrimary.rawObjectRef;
  const envelope = { body, url, provider: source, fetchedAt: retainedPrimary.fetchedAt, rawObjectRef };
  return extractWithGetter(envelope, { fallbackCategory, now, verifyPrimaryRawRef: true }, async (requestUrl) => {
    const existing = suppliedResponse(options.supplementaryResponses, requestUrl);
    if (existing) return existing;
    if (typeof options.get !== 'function') throw new Error(`supplementary_response_missing:${requestUrl}`);
    const returned = await options.get(requestUrl);
    const retained = suppliedResponse(options.supplementaryResponses, requestUrl);
    if (retained) return retained;
    if (returned && typeof returned === 'object') return suppliedResponse({ [requestUrl]: returned }, requestUrl);
    throw new Error(`supplementary_response_not_retained:${requestUrl}`);
  });
}

/** Temporary bridge for the current snapshot/import path. */
export function listingToEvent(listing) {
  const prices = listing.tiers.filter((tier) => tier.availability === 'available' && typeof tier.price === 'number').map((tier) => tier.price);
  return {
    id: listing.listingId.slice(0, 24), title: cleaned(listing.title).slice(0, 250), description: cleaned(listing.description).slice(0, 5000),
    startsAt: listing.startsAt, venue: cleaned(listing.venue.name).slice(0, 250), city: listing.city || 'İstanbul',
    district: cleaned(listing.venue.district), address: cleaned(listing.venue.address).slice(0, 500), price: prices.length ? Math.min(...prices) : null,
    currency: listing.tiers.find((tier) => tier.currency)?.currency ?? 'TRY', url: listing.url, imageUrl: listing.imageUrl ?? '',
    category: categoryForEvent(listing.category, listing.title, listing.description), availability: listing.availability, checkedAt: listing.observedAt,
    source: listing.provider, sourceSessionIds: listing.providerSessionIds, sourceCategory: listing.category,
    sourceVersion: 'provider-listing.v1', extraction: listing.extractorVersion,
    providerListing: listing,
    ...(listing.attendanceTiming ? { attendanceTiming: listing.attendanceTiming } : {}),
  };
}
