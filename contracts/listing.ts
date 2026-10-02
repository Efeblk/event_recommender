import { parseAttendanceTiming, type AttendanceTiming } from './timing.ts';
import { sha256Hex } from './hash.ts';

export const PROVIDER_LISTING_VERSION = 'provider-listing.v1' as const;

export const PROVIDERS = ['biletinial', 'biletix', 'bubilet'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type ListingAvailability = 'available' | 'sold_out' | 'cancelled' | 'unknown';

export interface RawObjectRefV1 {
  sha256: string;
  key: string;
  bytes: number;
}

export interface SupplementaryRawObservationV1 {
  url: string;
  fetchedAt: string;
  rawObjectRef: RawObjectRefV1;
}

export type TimezoneEvidenceV1 =
  | { kind: 'explicit_offset'; sourceValue: string }
  | { kind: 'unix_epoch_ms'; sourceValue: string }
  | { kind: 'istanbul_wall_time'; sourceValue: string };

export interface ProviderTicketTierV1 {
  providerTierId?: string;
  name?: string;
  price: number | null;
  currency: string;
  availability: ListingAvailability;
  rawAvailability?: string;
}

export interface ProviderListingV1 {
  contractVersion: typeof PROVIDER_LISTING_VERSION;
  listingId: string;
  provider: Provider;
  providerEventId?: string;
  providerSessionIds: string[];
  url: string;
  title: string;
  description: string;
  category: string;
  startsAt: string;
  timezoneEvidence: TimezoneEvidenceV1;
  venue: {
    name: string;
    providerVenueId?: string;
    address?: string;
    district?: string;
    geo?: { lat: number; lon: number };
  };
  tiers: ProviderTicketTierV1[];
  availability: ListingAvailability;
  attendanceTiming?: AttendanceTiming;
  observedAt: string;
  extractorVersion: string;
  rawObjectRef: RawObjectRefV1;
  supplementaryRawObjectRefs?: RawObjectRefV1[];
  supplementaryRawObservations?: SupplementaryRawObservationV1[];
  imageUrl?: string;
  city?: string;
}

const MAX_RAW_BYTES = 32 * 1024 * 1024;
const AVAILABILITIES = ['available', 'sold_out', 'cancelled', 'unknown'] as const;
const exactKeys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
};
const boundedString = (value: unknown, max: number, allowEmpty = false): value is string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0);
const canonicalIso = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function providerListingIdentityMaterial(value: Pick<ProviderListingV1, 'provider' | 'providerEventId' | 'providerSessionIds' | 'url' | 'startsAt'>): string {
  const sourceIdentity = value.providerEventId || value.url;
  const sessions = [...new Set(value.providerSessionIds.map(String))].sort();
  return `${value.provider}\n${sourceIdentity}\n${sessions.length ? sessions.join(',') : value.startsAt}`;
}

export function expectedProviderListingId(value: Pick<ProviderListingV1, 'provider' | 'providerEventId' | 'providerSessionIds' | 'url' | 'startsAt'>): string {
  return sha256Hex(providerListingIdentityMaterial(value));
}

function validateRawObjectRef(value: unknown): asserts value is RawObjectRefV1 {
  if (!record(value) || !exactKeys(value, ['sha256', 'key', 'bytes']) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      value.key !== `bodies/${value.sha256}.bin` || !Number.isSafeInteger(value.bytes) ||
      (value.bytes as number) < 0 || (value.bytes as number) > MAX_RAW_BYTES)
    throw new Error('Invalid provider listing raw object reference');
}

function validateTimezoneEvidence(value: unknown): asserts value is TimezoneEvidenceV1 {
  if (!record(value) || !exactKeys(value, ['kind', 'sourceValue']) ||
      !['explicit_offset', 'unix_epoch_ms', 'istanbul_wall_time'].includes(String(value.kind)) ||
      !boundedString(value.sourceValue, 200)) throw new Error('Invalid provider listing timezone evidence');
  if (value.kind === 'explicit_offset' && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value.sourceValue as string))
    throw new Error('Invalid provider listing timezone evidence');
  if (value.kind === 'unix_epoch_ms' && !/^\d{1,16}$/.test(value.sourceValue as string))
    throw new Error('Invalid provider listing timezone evidence');
  if (value.kind === 'istanbul_wall_time' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value.sourceValue as string))
    throw new Error('Invalid provider listing timezone evidence');
}

function validateTier(value: unknown): asserts value is ProviderTicketTierV1 {
  if (!record(value) || !exactKeys(value, ['price', 'currency', 'availability'], ['providerTierId', 'name', 'rawAvailability']) ||
      (value.providerTierId !== undefined && !boundedString(value.providerTierId, 500)) ||
      (value.name !== undefined && !boundedString(value.name, 100_000, true)) ||
      !(value.price === null || typeof value.price === 'number' && Number.isFinite(value.price) && value.price >= 0 && value.price <= Number.MAX_SAFE_INTEGER / 100) ||
      typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency) ||
      !AVAILABILITIES.includes(value.availability as ListingAvailability) ||
      (value.rawAvailability !== undefined && !boundedString(value.rawAvailability, 1000, true)))
    throw new Error('Invalid provider listing tier');
}

function validateVenue(value: unknown): asserts value is ProviderListingV1['venue'] {
  if (!record(value) || !exactKeys(value, ['name'], ['providerVenueId', 'address', 'district', 'geo']) ||
      !boundedString(value.name, 100_000) ||
      (value.providerVenueId !== undefined && !boundedString(value.providerVenueId, 500)) ||
      (value.address !== undefined && !boundedString(value.address, 500_000, true)) ||
      (value.district !== undefined && !boundedString(value.district, 100_000, true)))
    throw new Error('Invalid provider listing venue');
  if (value.geo !== undefined) {
    if (!record(value.geo) || !exactKeys(value.geo, ['lat', 'lon']) || typeof value.geo.lat !== 'number' || !Number.isFinite(value.geo.lat) || value.geo.lat < -90 || value.geo.lat > 90 || typeof value.geo.lon !== 'number' || !Number.isFinite(value.geo.lon) || value.geo.lon < -180 || value.geo.lon > 180)
      throw new Error('Invalid provider listing venue');
  }
}

/** Validates an untrusted ProviderListing without truncating or normalizing source evidence. */
export function validateProviderListing(value: unknown): ProviderListingV1 {
  const required = ['contractVersion', 'listingId', 'provider', 'providerSessionIds', 'url', 'title', 'description', 'category', 'startsAt', 'timezoneEvidence', 'venue', 'tiers', 'availability', 'observedAt', 'extractorVersion', 'rawObjectRef'];
  const optional = ['providerEventId', 'attendanceTiming', 'supplementaryRawObjectRefs', 'supplementaryRawObservations', 'imageUrl', 'city'];
  if (!record(value) || !exactKeys(value, required, optional) || value.contractVersion !== PROVIDER_LISTING_VERSION ||
      typeof value.listingId !== 'string' || !/^[a-f0-9]{64}$/.test(value.listingId) || !PROVIDERS.includes(value.provider as Provider) ||
      (value.providerEventId !== undefined && !boundedString(value.providerEventId, 500)) ||
      !Array.isArray(value.providerSessionIds) || value.providerSessionIds.length > 1000 || value.providerSessionIds.some((id) => !boundedString(id, 500)) || new Set(value.providerSessionIds).size !== value.providerSessionIds.length ||
      !boundedString(value.url, 2048) || !boundedString(value.title, 100_000) || !boundedString(value.description, 4_000_000, true) || !boundedString(value.category, 10_000) ||
      !canonicalIso(value.startsAt) || !AVAILABILITIES.includes(value.availability as ListingAvailability) || !canonicalIso(value.observedAt) || !boundedString(value.extractorVersion, 200) ||
      (value.imageUrl !== undefined && !boundedString(value.imageUrl, 2048)) || (value.city !== undefined && !boundedString(value.city, 1000)))
    throw new Error('Invalid provider listing');
  let parsedUrl: URL;
  try { parsedUrl = new URL(value.url as string); } catch { throw new Error('Invalid provider listing URL'); }
  const expectedHost = { biletinial: 'biletinial.com', biletix: 'www.biletix.com', bubilet: 'www.bubilet.com.tr' }[value.provider as Provider];
  if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== expectedHost || parsedUrl.username || parsedUrl.password)
    throw new Error('Invalid provider listing URL');
  if (value.listingId !== expectedProviderListingId(value as unknown as ProviderListingV1))
    throw new Error('Invalid provider listing identity');
  validateTimezoneEvidence(value.timezoneEvidence);
  validateVenue(value.venue);
  if (!Array.isArray(value.tiers) || value.tiers.length > 10_000) throw new Error('Invalid provider listing tiers');
  value.tiers.forEach(validateTier);
  validateRawObjectRef(value.rawObjectRef);
  if (value.supplementaryRawObjectRefs !== undefined) {
    if (!Array.isArray(value.supplementaryRawObjectRefs) || value.supplementaryRawObjectRefs.length > 1000) throw new Error('Invalid provider listing supplementary raw references');
    value.supplementaryRawObjectRefs.forEach(validateRawObjectRef);
    if (new Set(value.supplementaryRawObjectRefs.map((ref) => ref.sha256)).size !== value.supplementaryRawObjectRefs.length)
      throw new Error('Invalid provider listing supplementary raw references');
  }
  if (value.supplementaryRawObservations !== undefined) {
    if (!Array.isArray(value.supplementaryRawObservations) || value.supplementaryRawObservations.length > 1000)
      throw new Error('Invalid provider listing supplementary raw observations');
    const observations = value.supplementaryRawObservations as unknown[];
    const keys = new Set<string>();
    for (const observation of observations) {
      if (!record(observation) || !exactKeys(observation, ['url', 'fetchedAt', 'rawObjectRef']) || !boundedString(observation.url, 2048) || !canonicalIso(observation.fetchedAt))
        throw new Error('Invalid provider listing supplementary raw observations');
      let url: URL; try { url = new URL(observation.url as string); } catch { throw new Error('Invalid provider listing supplementary raw observations'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid provider listing supplementary raw observations');
      validateRawObjectRef(observation.rawObjectRef);
      const key = `${observation.url}\n${observation.fetchedAt}\n${observation.rawObjectRef.sha256}`;
      if (keys.has(key)) throw new Error('Invalid provider listing supplementary raw observations');
      keys.add(key);
    }
    const refHashes = new Set((value.supplementaryRawObjectRefs ?? []).map((ref) => ref.sha256));
    const observationHashes = new Set((value.supplementaryRawObservations as SupplementaryRawObservationV1[]).map((item) => item.rawObjectRef.sha256));
    if (refHashes.size !== observationHashes.size || [...refHashes].some((hash) => !observationHashes.has(hash)))
      throw new Error('Invalid provider listing supplementary raw observations');
  } else if (value.supplementaryRawObjectRefs !== undefined) {
    throw new Error('Invalid provider listing supplementary raw observations');
  }
  if (value.attendanceTiming !== undefined) parseAttendanceTiming(value.attendanceTiming);
  return value as unknown as ProviderListingV1;
}
