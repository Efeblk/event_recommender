import { createHash } from 'node:crypto';
import { stableJson } from './source-adapter.mjs';

const normalize = value => String(value ?? '')
  .toLocaleLowerCase('tr-TR')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/ı/g, 'i')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, ' ');

const SOSYAL_SANATHANE = Object.freeze({
  key: 'reviewed:sosyal-sanathane-kadikoy:karma-five-option',
  title: 'Sosyal Sanathane Karma Workshop',
  description: 'Aynı oturumda heykel, resim, plak boyama, maske boyama veya bez çanta boyama seçeneklerinden biri sunulan iki saatlik karma workshop.',
  venue: normalize('Sosyal Sanathane (Kadıköy)'),
  address: normalize('Osmanağa, Canan Sk. No:51a, 34714 Kadıköy/İstanbul'),
  titles: new Set([
    normalize('Workshop: Sosyal Sanathane İstanbul | Etkinlik Takvimi'),
    normalize('Workshop: Etkinlik Takvimi - Sosyal Sanathane İstanbul'),
  ]),
});

/**
 * Return only source-reviewed preparation identity. This deliberately has no
 * organizer-prefix or token-similarity fallback: named activities at this same
 * venue and instant are separate attendee choices.
 */
export function supportedCanonicalIdentity(record) {
  if (record?.category !== 'Workshop' || normalize(record.city) !== 'istanbul') return undefined;
  if (normalize(record.venue) !== SOSYAL_SANATHANE.venue || normalize(record.address) !== SOSYAL_SANATHANE.address)
    return undefined;
  if (!SOSYAL_SANATHANE.titles.has(normalize(record.title))) return undefined;
  if (!['bubilet', 'biletinial'].includes(record.source)) return undefined;
  const expectedHost = record.source === 'bubilet' ? 'bubilet.com.tr' : 'biletinial.com';
  let host;
  try { host = new URL(record.url).hostname.toLocaleLowerCase('en-US'); }
  catch { return undefined; }
  if (host !== expectedHost && !host.endsWith(`.${expectedHost}`)) return undefined;
  return SOSYAL_SANATHANE;
}

/** Preserve literal source presentation while supplying deterministic canonical facts. */
export function normalizeSupportedCanonicalRecord(record) {
  const identity = supportedCanonicalIdentity(record);
  if (!identity) return structuredClone(record);
  const sourceObservedRecord = structuredClone(record);
  return {
    ...sourceObservedRecord,
    title: identity.title,
    description: identity.description,
    district: 'Kadıköy',
    imageUrl: '',
    canonicalProductionKey: identity.key,
    sourceObservedPresentation: {
      title: record.title,
      description: record.description,
      district: record.district,
      imageUrl: record.imageUrl,
    },
    sourceObservedRecord,
    sourceObservedRecordHash: createHash('sha256').update(stableJson(sourceObservedRecord)).digest('hex'),
  };
}

export function supportedSessionIdentityKey(record) {
  const identity = supportedCanonicalIdentity(record);
  const instant = Date.parse(record?.startsAt);
  return identity && Number.isFinite(instant)
    ? `${identity.key}\u001f${new Date(instant).toISOString()}`
    : undefined;
}

const preparedOrder = (a, b) =>
  (b.description?.length ?? 0) - (a.description?.length ?? 0) ||
  String(a.source ?? '').localeCompare(String(b.source ?? '')) ||
  String(a.id).localeCompare(String(b.id));

/** Merge already-prepared records only inside a reviewed session family. */
export function mergeSupportedPreparedEvents(events) {
  if (!Array.isArray(events) || events.length < 2) return events.map(event => structuredClone(event));
  const keys = new Set(events.map(supportedSessionIdentityKey));
  if (keys.size !== 1 || keys.has(undefined)) return events.map(event => structuredClone(event));
  const ordered = [...events].sort(preparedOrder);
  const representative = structuredClone(ordered[0]);
  const offers = new Map();
  const mergedIds = new Set();
  for (const event of ordered) {
    mergedIds.add(event.id);
    for (const id of event.mergedIds ?? []) mergedIds.add(id);
    for (const offer of event.offers?.length ? event.offers : [event]) {
      if (!offers.has(offer.id)) offers.set(offer.id, structuredClone(offer));
    }
  }
  const key = [...keys][0];
  const id = `session-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  mergedIds.add(id);
  return [{
    ...representative,
    id,
    canonicalProductionKey: SOSYAL_SANATHANE.key,
    offers: [...offers.values()].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    mergedIds: [...mergedIds].sort(),
  }];
}

function selectedAt(group, at) {
  let selected = [];
  for (const version of group.versions) {
    if (version.from > at) break;
    selected = version.events;
  }
  return selected;
}

/** Reconcile reviewed families in a frozen catalog without recomputing search artifacts. */
export function reconcileSupportedCatalog(catalog) {
  const copy = structuredClone(catalog);
  const reviewed = new Map();
  const untouched = [];
  for (const group of copy.groups) {
    const event = group.versions.flatMap(version => version.events)[0];
    const key = event && supportedSessionIdentityKey(event);
    if (!key) untouched.push(group);
    else (reviewed.get(key) ?? reviewed.set(key, []).get(key)).push(group);
  }
  const mergedGroups = [];
  for (const groups of reviewed.values()) {
    if (groups.length === 1) { mergedGroups.push(groups[0]); continue; }
    const boundaries = [...new Set(groups.flatMap(group => group.versions.map(version => version.from)))].sort((a, b) => a - b);
    const versions = [];
    let previous;
    for (const from of boundaries) {
      const events = groups.flatMap(group => selectedAt(group, from));
      const next = mergeSupportedPreparedEvents(events);
      const serialized = JSON.stringify(next);
      if (serialized !== previous) versions.push({ from, events: next });
      previous = serialized;
    }
    mergedGroups.push({ versions });
  }
  copy.groups = [...untouched, ...mergedGroups];
  return copy;
}
