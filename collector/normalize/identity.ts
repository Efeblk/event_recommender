export const IDENTITY_NORMALIZATION_VERSION = "identity-normalization.v1" as const;

/** Locale-stable text used only for deterministic identity comparisons. */
export function normalizeIdentityText(value: string | null | undefined): string {
  return (value ?? "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function compactIdentityKey(value: string | null | undefined): string {
  return normalizeIdentityText(value).replace(/\s/g, "");
}

export function normalizeCategoryKey(value: string | null | undefined): string {
  const category = normalizeIdentityText(value);
  if (/\b(?:konser|muzik)\b/.test(category)) return "concert";
  if (/\b(?:tiyatro|oyun)\b/.test(category)) return "theatre";
  if (/\bstand up\b|\bstandup\b/.test(category)) return "standup";
  if (/\b(?:atolye|workshop)\b/.test(category)) return "workshop";
  return category;
}

const ISTANBUL_DISTRICTS = [
  "adalar",
  "arnavutkoy",
  "atasehir",
  "avcilar",
  "bagcilar",
  "bahcelievler",
  "bakirkoy",
  "basaksehir",
  "bayrampasa",
  "besiktas",
  "beykoz",
  "beylikduzu",
  "beyoglu",
  "buyukcekmece",
  "catalca",
  "cekmekoy",
  "esenler",
  "esenyurt",
  "eyupsultan",
  "fatih",
  "gaziosmanpasa",
  "gungoren",
  "kadikoy",
  "kagithane",
  "kartal",
  "kucukcekmece",
  "maltepe",
  "pendik",
  "sancaktepe",
  "sariyer",
  "sile",
  "silivri",
  "sisli",
  "sultanbeyli",
  "sultangazi",
  "tuzla",
  "umraniye",
  "uskudar",
  "zeytinburnu",
] as const;

export const ASIA_DISTRICTS: ReadonlySet<string> = new Set([
  "adalar",
  "atasehir",
  "beykoz",
  "cekmekoy",
  "kadikoy",
  "kartal",
  "maltepe",
  "pendik",
  "sancaktepe",
  "sultanbeyli",
  "sile",
  "tuzla",
  "umraniye",
  "uskudar",
]);
const DISTRICTS: ReadonlySet<string> = new Set(ISTANBUL_DISTRICTS);

// Providers put neighbourhoods in district fields (Biletix "MECİDİYEKÖY",
// "HARBİYE") and in venue names. Only unambiguous, single-district
// neighbourhoods are mapped; border areas such as Acıbadem or Fulya are not.
const NEIGHBOURHOOD_DISTRICTS: Readonly<Record<string, string>> = {
  ayazaga: "sariyer",
  bahariye: "kadikoy",
  bomonti: "sisli",
  bostanci: "kadikoy",
  caddebostan: "kadikoy",
  cihangir: "beyoglu",
  emirgan: "sariyer",
  galata: "beyoglu",
  harbiye: "sisli",
  karakoy: "beyoglu",
  kosuyolu: "kadikoy",
  kozyatagi: "kadikoy",
  kustepe: "sisli",
  maslak: "sariyer",
  mecidiyekoy: "sisli",
  moda: "kadikoy",
  nisantasi: "sisli",
  ortakoy: "besiktas",
  sishane: "beyoglu",
  sultanahmet: "fatih",
  taksim: "beyoglu",
  yenibosna: "bahcelievler",
};

function districtOfToken(token: string): string | undefined {
  if (DISTRICTS.has(token)) return token;
  return NEIGHBOURHOOD_DISTRICTS[token];
}

function locationTokens(text: string): string[] {
  return normalizeIdentityText(text).replace(/\beyup sultan\b/g, "eyupsultan").split(" ");
}

/** Prefer a precise source district, otherwise recover one stated in the address. */
export function normalizeDistrictKey(
  district: string | undefined,
  address: string | undefined,
): string {
  const normalized = normalizeIdentityText(district);
  if (normalized && normalized !== "istanbul anadolu" && normalized !== "istanbul avrupa")
    return locationTokens(normalized).map(districtOfToken).find(Boolean) ?? normalized;
  return addressDistrict(address) ?? normalized;
}

/** The district that ends a Turkish address (`…, Beyoğlu/İstanbul`), else the last one named. */
function addressDistrict(address: string | undefined): string | undefined {
  const tokens = locationTokens(address ?? "").filter((token) => !/^\d+$/.test(token));
  const city = tokens.lastIndexOf("istanbul");
  const beforeCity = city > 0 ? districtOfToken(tokens[city - 1]) : undefined;
  if (beforeCity) return beforeCity;
  for (let index = tokens.length - 1; index >= 0; index--) {
    const district = districtOfToken(tokens[index]);
    if (district) return district;
  }
  return undefined;
}

export interface LocationEvidence {
  /** Precise districts supported by any field; one wrong field cannot outvote the others. */
  districts: string[];
  sides: ("asia" | "europe")[];
}

export function locationEvidence(venue: {
  name: string;
  district?: string;
  address?: string;
}): LocationEvidence {
  const districts = new Set<string>();
  const sides = new Set<"asia" | "europe">();
  const field = normalizeIdentityText(venue.district);
  if (field === "istanbul anadolu") sides.add("asia");
  else if (field === "istanbul avrupa") sides.add("europe");
  else
    for (const token of locationTokens(field)) {
      const district = districtOfToken(token);
      if (district) districts.add(district);
    }
  const fromAddress = addressDistrict(venue.address);
  if (fromAddress) districts.add(fromAddress);
  for (const token of locationTokens(venue.name)) {
    const district = districtOfToken(token);
    if (district) districts.add(district);
  }
  for (const district of districts) sides.add(ASIA_DISTRICTS.has(district) ? "asia" : "europe");
  return { districts: [...districts].sort(), sides: [...sides].sort() };
}

/** Both listings state where they are, and no stated district or side overlaps. */
export function locationConflict(left: LocationEvidence, right: LocationEvidence): boolean {
  const disjoint = (a: readonly string[], b: readonly string[]) =>
    a.length > 0 && b.length > 0 && !a.some((value) => b.includes(value));
  return disjoint(left.districts, right.districts) || disjoint(left.sides, right.sides);
}

export interface NormalizedTitle {
  key: string;
  category: string;
  removedGenericSuffix: boolean;
}

/** Generic labels are removed only when the source category establishes their meaning. */
export function normalizeTitleKey(title: string, rawCategory: string): NormalizedTitle {
  const category = normalizeCategoryKey(rawCategory);
  const normalized = normalizeIdentityText(title);
  let key = normalized;
  if (category === "concert") key = key.replace(/\s+konseri?$/, "");
  else if (category === "theatre") key = key.replace(/\s+(?:tiyatro\s+)?oyunu$/, "");
  else if (category === "standup") key = key.replace(/\s+stand up$/, "");
  return { key: key || normalized, category, removedGenericSuffix: key !== normalized };
}

const GENERIC_VENUE_TOKENS = new Set([
  "acik",
  "hava",
  "arena",
  "etkinlik",
  "gosteri",
  "istanbul",
  "kultur",
  "merkezi",
  "mekan",
  "performans",
  "salon",
  "salonu",
  "sahne",
  "tiyatro",
  "yer",
]);

export function venueNameTokens(name: string): string[] {
  return normalizeIdentityText(name)
    .split(" ")
    .filter((token) => token.length > 1 && !GENERIC_VENUE_TOKENS.has(token));
}

// Building/hall descriptors and address words that providers add or drop freely.
const DESCRIPTIVE_VENUE_TOKENS = new Set([
  ...GENERIC_VENUE_TOKENS,
  "acikhava",
  "amfi",
  "auditorium",
  "avm",
  "cad",
  "caddesi",
  "ile",
  "km",
  "ksm",
  "merkez",
  "oditoryum",
  "oditoryumu",
  "sahnesi",
  "sanat",
  "sk",
  "sokak",
  "sokagi",
  "tiyatrosu",
  "ve",
]);
// Words that can describe many unrelated venues; they never identify one alone.
const WEAK_VENUE_TOKENS = new Set([
  "alt",
  "ana",
  "art",
  "arts",
  "bar",
  "buyuk",
  "cafe",
  "center",
  "centre",
  "city",
  "club",
  "hall",
  "house",
  "kafe",
  "kucuk",
  "kulup",
  "live",
  "of",
  "park",
  "pub",
  "stage",
  "studio",
  "studyo",
  "the",
  "theater",
  "theatre",
  "ust",
]);

/**
 * Name tokens that identify the venue itself: descriptors are removed and
 * spelled-out initials (`B-B-S`) are joined. Districts and neighbourhoods are
 * removed too, unless nothing else identifying remains ("Moda Sahnesi Büyük
 * Salon" keeps "moda" so it cannot match "Caddebostan … Büyük Salon").
 */
export function distinctiveVenueTokens(name: string): string[] {
  const joined: string[] = [];
  let initials = false;
  for (const token of locationTokens(name)) {
    const initial = /^[a-z]$/.test(token);
    if (initial && initials) joined[joined.length - 1] += token;
    else joined.push(token);
    initials = initial;
  }
  const tokens = joined.filter(
    (token) => token.length > 1 && !DESCRIPTIVE_VENUE_TOKENS.has(token) && token !== "istanbul",
  );
  const named = tokens.filter((token) => !districtOfToken(token));
  return named.some((token) => !WEAK_VENUE_TOKENS.has(token)) ? named : tokens;
}

/**
 * Drop a leading copy of the listing's own venue name used as an organizer
 * label ("HABITAT X Evgeny Grinko" at Habitat Hilltown, "Anka Workshop: Mum
 * Atölyesi" at Ankaworkshop). Other prefixes ("Mozaik Workshop: …") stay.
 */
export function stripVenueTitlePrefix(title: string, venueName: string): string {
  const venue = distinctiveVenueTokens(venueName);
  const match = /^(.+?)(?:\s+(?:x|sunar|presents)\s+|\s*:\s+)(.+)$/i.exec(title.trim());
  if (!venue.length || !match || !normalizeIdentityText(match[2])) return title;
  const prefix = normalizeIdentityText(match[1]).split(" ");
  const identifying = prefix.some((token) => token.length >= 3 && !WEAK_VENUE_TOKENS.has(token));
  const sameName =
    prefix.join("") === venue.join("") || prefix.every((token) => venue.includes(token));
  return identifying && sameName ? match[2] : title;
}

export function isWeakVenueToken(token: string): boolean {
  return WEAK_VENUE_TOKENS.has(token);
}
