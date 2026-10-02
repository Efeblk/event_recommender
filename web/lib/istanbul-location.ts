import { addressDistrict, isIstanbulDistrict, normalize } from './search.ts';
import type { EventRecord } from './types.ts';

export type IstanbulSide = 'europe' | 'asia';
export interface EventLocation {
  /** Normalized district name when precision is 'district'. */
  district: string | null;
  side: IstanbulSide | null;
  precision: 'district' | 'side' | 'unknown';
}
interface Place {
  district?: string;
  side: IstanbulSide;
}

const ASIAN_DISTRICTS = new Set([
  'adalar',
  'atasehir',
  'beykoz',
  'cekmekoy',
  'kadikoy',
  'kartal',
  'maltepe',
  'pendik',
  'sancaktepe',
  'sultanbeyli',
  'sile',
  'tuzla',
  'umraniye',
  'uskudar',
]);

/** Side of a normalized Istanbul district, or null for a non-district. */
export function districtSide(district: string): IstanbulSide | null {
  if (!isIstanbulDistrict(district)) return null;
  return ASIAN_DISTRICTS.has(district) ? 'asia' : 'europe';
}

const europe = (district?: string): Place => ({ district, side: 'europe' });
const asia = (district?: string): Place => ({ district, side: 'asia' });
/**
 * Neighborhoods from the parser lexicon and provider district labels. Areas
 * that span districts keep only their side.
 */
const NEIGHBORHOODS: Record<string, Place> = {
  moda: asia('kadikoy'),
  taksim: europe('beyoglu'),
  karakoy: europe('beyoglu'),
  galata: europe('beyoglu'),
  cihangir: europe('beyoglu'),
  nisantasi: europe('sisli'),
  bebek: europe('besiktas'),
  ortakoy: europe('besiktas'),
  etiler: europe('besiktas'),
  levent: europe(),
  maslak: europe('sariyer'),
  bomonti: europe('sisli'),
  harbiye: europe('sisli'),
  mecidiyekoy: europe('sisli'),
  kurtulus: europe('sisli'),
  ferikoy: europe('sisli'),
  tophane: europe('beyoglu'),
  balat: europe('fatih'),
  fener: europe('fatih'),
  sultanahmet: europe('fatih'),
  eminonu: europe('fatih'),
  kuzguncuk: asia('uskudar'),
  cengelkoy: asia('uskudar'),
  caddebostan: asia('kadikoy'),
  suadiye: asia('kadikoy'),
  bostanci: asia('kadikoy'),
  fenerbahce: asia('kadikoy'),
  goztepe: asia('kadikoy'),
  erenkoy: asia('kadikoy'),
  yeldegirmeni: asia('kadikoy'),
  'bagdat caddesi': asia(),
  istiklal: europe('beyoglu'),
  cevahir: europe('sisli'),
  kozyatagi: asia('kadikoy'),
  florya: europe('bakirkoy'),
  yesilkoy: europe('bakirkoy'),
  emirgan: europe('sariyer'),
  'arnavutkoy koyu': europe('besiktas'),
  rumelihisari: europe('sariyer'),
  anadoluhisari: asia('beykoz'),
  kanlica: asia('beykoz'),
  tarabya: europe('sariyer'),
  zorlu: europe('besiktas'),
  kalamis: asia('kadikoy'),
  acibadem: asia(),
  altunizade: asia('uskudar'),
  tesvikiye: europe('sisli'),
  gayrettepe: europe('besiktas'),
  esentepe: europe('sisli'),
  pera: europe('beyoglu'),
  sishane: europe('beyoglu'),
  tunel: europe('beyoglu'),
  kumkapi: europe('fatih'),
  cagaloglu: europe('fatih'),
  beyazit: europe('fatih'),
  vefa: europe('fatih'),
  balmumcu: europe('besiktas'),
  dolapdere: europe(),
  kasimpasa: europe('beyoglu'),
  haskoy: europe('beyoglu'),
  sutluce: europe('beyoglu'),
  kemerburgaz: europe('eyupsultan'),
  ayazaga: europe('sariyer'),
  bahariye: asia('kadikoy'),
  kucukyali: asia('maltepe'),
  yenibosna: europe('bahcelievler'),
};
const ADDRESS_NEIGHBORHOOD_PATTERNS = Object.keys(NEIGHBORHOODS).map(
  (name) =>
    [
      name,
      new RegExp(`\\b${name}\\b\\s*(?:(?:/|,)\\s*istanbul\\b|$)`),
    ] as const,
);

/** The single neighborhood written where an address names its district. */
function addressNeighborhood(address: string): Place | null {
  const normalized = normalize(address).trim();
  const matches = ADDRESS_NEIGHBORHOOD_PATTERNS.filter(([, pattern]) =>
    pattern.test(normalized),
  );
  return matches.length === 1 ? NEIGHBORHOODS[matches[0][0]] : null;
}

const SIDE_LABELS: Record<string, IstanbulSide> = {
  'istanbul avrupa': 'europe',
  'istanbul anadolu': 'asia',
  'avrupa yakasi': 'europe',
  'anadolu yakasi': 'asia',
};

/** The side named by a normalized label such as "anadolu yakasi". */
export function sideNamed(normalized: string): IstanbulSide | null {
  return SIDE_LABELS[normalized] ?? null;
}

/** A normalized district or known neighborhood name. */
export function placeOf(normalized: string): Place | null {
  const side = districtSide(normalized);
  if (side) return { district: normalized, side };
  return NEIGHBORHOODS[normalized] ?? null;
}

const unknown: EventLocation = {
  district: null,
  side: null,
  precision: 'unknown',
};
const atDistrict = (district: string): EventLocation => ({
  district,
  side: districtSide(district),
  precision: 'district',
});
const atSide = (side: IstanbulSide): EventLocation => ({
  district: null,
  side,
  precision: 'side',
});

/** A "/"-separated label such as "MALTEPE/KARTAL" that names one side only. */
function sharedSide(label: string): IstanbulSide | null {
  const parts = label.split('/').map((part) => part.trim());
  if (parts.length < 2) return null;
  const sides = new Set(parts.map((part) => placeOf(part)?.side ?? null));
  return sides.size === 1 && !sides.has(null) ? [...sides][0] : null;
}

/**
 * Venue location with explicit precision. Disagreeing evidence resolves to
 * unknown rather than to either value; a side label never upgrades to a
 * district.
 */
export function resolveEventLocation(event: EventRecord): EventLocation {
  const label = normalize(event.district ?? '').trim();
  const fromAddress = addressDistrict(event.address ?? '');
  const labelSide = SIDE_LABELS[label] ?? sharedSide(label);
  const labelPlace = labelSide ? null : placeOf(label);
  const addressPlace = fromAddress
    ? null
    : addressNeighborhood(event.address ?? '');
  const candidates: EventLocation[] = [labelPlace, addressPlace].flatMap(
    (place) =>
      place
        ? [place.district ? atDistrict(place.district) : atSide(place.side)]
        : [],
  );
  if (fromAddress) candidates.push(atDistrict(fromAddress));
  if (labelSide) candidates.push(atSide(labelSide));
  if (!candidates.length) return unknown;
  const sides = new Set(candidates.map((candidate) => candidate.side));
  const districts = new Set(
    candidates.flatMap((candidate) =>
      candidate.district ? [candidate.district] : [],
    ),
  );
  if (sides.size !== 1 || districts.size > 1) return unknown;
  return districts.size === 1
    ? atDistrict([...districts][0])
    : atSide([...sides][0]!);
}
