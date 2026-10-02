import {
  compactIdentityKey,
  distinctiveVenueTokens,
  isWeakVenueToken,
  locationConflict,
  locationEvidence,
  normalizeDistrictKey,
  normalizeIdentityText,
  normalizeTitleKey,
  venueNameTokens,
} from "../normalize/identity.ts";
import { identityHash } from "./hash.ts";
import { IDENTITY_SEED_VERSION, titleSeedIdentity, venueSeedIdentity } from "./seed-overrides.ts";
import type {
  IdentityDecision,
  IdentityListing,
  IdentityResolution,
  ResolvedSession,
  ResolvedVenue,
} from "./types.ts";

export const IDENTITY_RULE_VERSION = `deterministic-identity.v3+${IDENTITY_SEED_VERSION}` as const;
const GEO_RADIUS_METRES = 75;

class DisjointSet {
  private readonly parent: number[];
  private readonly componentMembers: number[][];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
    this.componentMembers = Array.from({ length: size }, (_, index) => [index]);
  }
  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[index] !== index) {
      const next = this.parent[index];
      this.parent[index] = root;
      index = next;
    }
    return root;
  }
  union(left: number, right: number): number {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return a;
    const root = Math.min(a, b);
    const child = Math.max(a, b);
    this.parent[child] = root;
    this.componentMembers[root].push(...this.componentMembers[child]);
    this.componentMembers[child] = [];
    return root;
  }
  members(index: number): readonly number[] {
    return this.componentMembers[this.find(index)];
  }
}

function cityKey(listing: IdentityListing): string {
  return normalizeIdentityText(listing.city || "İstanbul");
}

const ASIA_DISTRICTS = new Set([
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
const EUROPE_DISTRICTS = new Set([
  "arnavutkoy",
  "avcilar",
  "bagcilar",
  "bahcelievler",
  "bakirkoy",
  "basaksehir",
  "bayrampasa",
  "besiktas",
  "beylikduzu",
  "beyoglu",
  "buyukcekmece",
  "catalca",
  "esenler",
  "esenyurt",
  "eyupsultan",
  "fatih",
  "gaziosmanpasa",
  "gungoren",
  "kagithane",
  "kucukcekmece",
  "sariyer",
  "silivri",
  "sultangazi",
  "sisli",
  "zeytinburnu",
]);
function districtScope(value: string | undefined): string {
  const district = normalizeIdentityText(value);
  if (!district) return "";
  if (district === "istanbul anadolu" || ASIA_DISTRICTS.has(district)) return `asia:${district}`;
  if (district === "istanbul avrupa" || EUROPE_DISTRICTS.has(district)) return `europe:${district}`;
  return `district:${district}`;
}
function listingDistrictScope(listing: IdentityListing): string {
  return districtScope(normalizeDistrictKey(listing.venue.district, listing.venue.address));
}
function distanceMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radians = Math.PI / 180;
  const lat = ((a.lat + b.lat) / 2) * radians;
  const x = (b.lon - a.lon) * radians * Math.cos(lat);
  const y = (b.lat - a.lat) * radians;
  return Math.sqrt(x * x + y * y) * 6_371_000;
}

interface VenueEdge {
  left: number;
  right: number;
  priority: number;
  evidence: string;
}

function resolveVenues(listings: readonly IdentityListing[]): {
  venues: ResolvedVenue[];
  listingVenueIds: Record<string, string>;
  venueSeeds: Map<string, string | undefined>;
} {
  const edges: VenueEdge[] = [];
  const evidence = listings.map((listing) => locationEvidence(listing.venue));
  const venueSeeds = new Map<string, string | undefined>();
  for (const listing of listings) venueSeeds.set(listing.listingId, venueSeedIdentity(listing));
  const edgeByPair = new Map<string, VenueEdge>();
  const addEdge = (left: number, right: number, priority: number, evidence: string) => {
    if (left > right) [left, right] = [right, left];
    const key = `${left}:${right}`;
    const current = edgeByPair.get(key);
    if (!current || priority < current.priority)
      edgeByPair.set(key, { left, right, priority, evidence });
  };
  const providerBuckets = new Map<string, number[]>();
  const seedBuckets = new Map<string, number[]>();
  const compactBuckets = new Map<string, number[]>();
  for (let index = 0; index < listings.length; index++) {
    const listing = listings[index];
    const providerVenueId = listing.venue.providerVenueId?.trim();
    const seed = venueSeeds.get(listing.listingId);
    const compact = compactIdentityKey(listing.venue.name);
    const entries: [Map<string, number[]>, string | undefined][] = [
      [
        providerBuckets,
        providerVenueId
          ? `${cityKey(listing)}\u001f${listing.provider}\u001f${providerVenueId}`
          : undefined,
      ],
      [seedBuckets, seed ? `${cityKey(listing)}\u001f${seed}` : undefined],
      [compactBuckets, compact ? `${cityKey(listing)}\u001f${compact}` : undefined],
    ];
    for (const [buckets, key] of entries)
      if (key) {
        const bucket = buckets.get(key);
        if (bucket) bucket.push(index);
        else buckets.set(key, [index]);
      }
  }
  for (const indexes of providerBuckets.values())
    for (let index = 1; index < indexes.length; index++) {
      const listing = listings[indexes[index]];
      addEdge(
        indexes[0],
        indexes[index],
        0,
        `provider-venue-id:${listing.provider}:${listing.venue.providerVenueId}`,
      );
    }
  for (const indexes of seedBuckets.values())
    for (let left = 0; left < indexes.length; left++)
      for (let right = left + 1; right < indexes.length; right++) {
        const a = listings[indexes[left]];
        const b = listings[indexes[right]];
        if (!locationConflict(evidence[indexes[left]], evidence[indexes[right]]))
          addEdge(
            indexes[left],
            indexes[right],
            1,
            `manual-venue-seed:${venueSeeds.get(a.listingId)}`,
          );
      }
  const geoCells = new Map<string, number[]>();
  const geoCellSize = 0.001;
  for (let index = 0; index < listings.length; index++) {
    const listing = listings[index];
    const geo = listing.venue.geo;
    if (!geo) continue;
    const x = Math.floor(geo.lat / geoCellSize);
    const y = Math.floor(geo.lon / geoCellSize);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        for (const otherIndex of geoCells.get(`${cityKey(listing)}:${x + dx}:${y + dy}`) ?? []) {
          const other = listings[otherIndex];
          if (!other.venue.geo || distanceMetres(geo, other.venue.geo) > GEO_RADIUS_METRES)
            continue;
          const tokens = new Set(venueNameTokens(listing.venue.name));
          const overlap = venueNameTokens(other.venue.name).filter((token) => tokens.has(token));
          if (overlap.length)
            addEdge(otherIndex, index, 2, `geo-name-overlap:${overlap.sort().join(",")}`);
        }
      }
    const key = `${cityKey(listing)}:${x}:${y}`;
    const cell = geoCells.get(key);
    if (cell) cell.push(index);
    else geoCells.set(key, [index]);
  }
  // Same written name in the same city is one venue unless the stated
  // locations conflict; missing or side-only districts are not conflicts.
  for (const indexes of compactBuckets.values())
    for (let index = 1; index < indexes.length; index++) {
      const compact = compactIdentityKey(listings[indexes[0]].venue.name);
      addEdge(indexes[0], indexes[index], 3, `compact-name:${compact}`);
      addEdge(indexes[index - 1], indexes[index], 3, `compact-name:${compact}`);
    }
  // Providers add or drop descriptors, districts and neighbourhoods
  // ("… Sahnesi"/"… Tiyatrosu", "Evde Tiyatro (Caddebostan)"). Equal
  // distinctive names link. A name links to a longer one only when exactly one
  // name extends it by a single token, so "Turkcell Sahnesi" does not choose
  // between two halls of the same building.
  const nameGroups = new Map<string, { city: string; key: string; tokens: Set<string>; indexes: number[] }>();
  for (let index = 0; index < listings.length; index++) {
    const tokens = distinctiveVenueTokens(listings[index].venue.name);
    const key = [...tokens].sort().join("");
    if (key.length < 3 || tokens.every(isWeakVenueToken)) continue;
    const city = cityKey(listings[index]);
    const groupKey = `${city}${key}`;
    const group = nameGroups.get(groupKey);
    if (group) group.indexes.push(index);
    else nameGroups.set(groupKey, { city, key, tokens: new Set(tokens), indexes: [index] });
  }
  // A group can hold same-named venues in different districts; linking every
  // pair lets each location-compatible subset join despite the conflict guard.
  const linkAll = (left: number[], right: number[], priority: number, reason: string) => {
    if (left.length * right.length > 4096) {
      for (let index = 1; index < right.length; index++) addEdge(right[index - 1], right[index], priority, reason);
      for (const index of left) addEdge(index, right[0], priority, reason);
      return;
    }
    for (const a of left) for (const b of right) if (a !== b) addEdge(a, b, priority, reason);
  };
  const groups = [...nameGroups.values()];
  for (const group of groups) {
    linkAll(group.indexes, group.indexes, 4, `distinctive-name:${group.key}`);
    const identifying = (token: string) => token.length >= 3 && !isWeakVenueToken(token);
    const identifyingCount = [...group.tokens].filter(identifying).length;
    if (!identifyingCount) continue;
    // An already specific name gains another identifying word for a hall
    // ("Zorlu PSM Turkcell" → "… Platinum"), not a spelling variant.
    const extensions = groups.filter(
      (other) =>
        other.city === group.city &&
        other.tokens.size === group.tokens.size + 1 &&
        [...group.tokens].every((token) => other.tokens.has(token)) &&
        (identifyingCount < 2 ||
          [...other.tokens].every((token) => group.tokens.has(token) || !identifying(token))),
    );
    if (extensions.length === 1)
      linkAll(
        group.indexes,
        extensions[0].indexes,
        5,
        `distinctive-name-extension:${group.key}>${extensions[0].key}`,
      );
  }
  for (const edge of edgeByPair.values()) edges.push(edge);
  edges.sort((a, b) => a.priority - b.priority || a.left - b.left || a.right - b.right);
  const sets = new DisjointSet(listings.length);
  for (const edge of edges) {
    const leftRoot = sets.find(edge.left);
    const rightRoot = sets.find(edge.right);
    if (leftRoot === rightRoot) continue;
    const leftMembers = sets.members(leftRoot);
    const rightMembers = sets.members(rightRoot);
    let conflict = false;
    for (const leftIndex of leftMembers)
      for (const rightIndex of rightMembers) {
        const left = listings[leftIndex];
        const right = listings[rightIndex];
        if (locationConflict(evidence[leftIndex], evidence[rightIndex])) conflict = true;
        if (
          left.venue.geo &&
          right.venue.geo &&
          distanceMetres(left.venue.geo, right.venue.geo) > GEO_RADIUS_METRES * 2
        )
          conflict = true;
        if (
          left.provider === right.provider &&
          left.venue.providerVenueId &&
          right.venue.providerVenueId &&
          left.venue.providerVenueId !== right.venue.providerVenueId
        )
          conflict = true;
      }
    if (!conflict) sets.union(edge.left, edge.right);
  }
  const components = new Map<number, number[]>();
  for (let index = 0; index < listings.length; index++) {
    const root = sets.find(index);
    const members = components.get(root);
    if (members) members.push(index);
    else components.set(root, [index]);
  }
  const listingVenueIds: Record<string, string> = {};
  const venueDrafts = [...components.values()].map((indexes) => {
    const members = indexes.map((index) => listings[index]);
    const seeds = [
      ...new Set(members.map((member) => venueSeeds.get(member.listingId)).filter(Boolean)),
    ].sort();
    const canonicalName = [...members].sort(
      (a, b) =>
        normalizeIdentityText(a.venue.name).localeCompare(
          normalizeIdentityText(b.venue.name),
          "tr",
        ) ||
        a.venue.name.localeCompare(b.venue.name, "tr") ||
        a.listingId.localeCompare(b.listingId),
    )[0].venue.name;
    const compactKeys = [
      ...new Set(members.map((member) => compactIdentityKey(member.venue.name)).filter(Boolean)),
    ].sort();
    const districtScopes = [...new Set(members.map(listingDistrictScope).filter(Boolean))].sort();
    const preciseDistrictScopes = districtScopes.filter(
      (scope) => !scope.endsWith(":istanbul anadolu") && !scope.endsWith(":istanbul avrupa"),
    );
    const providerVenueIds = [
      ...new Set(
        members
          .filter((member) => member.venue.providerVenueId)
          .map((member) => `${member.provider}:${member.venue.providerVenueId}`),
      ),
    ].sort();
    const geos = members.filter((member) => member.venue.geo).map((member) => member.venue.geo!);
    const anchor =
      seeds[0] ??
      (compactKeys.length === 1 && districtScopes.length
        ? `compact:${compactKeys[0]}:${preciseDistrictScopes[0] ?? districtScopes[0]}`
        : undefined) ??
      providerVenueIds[0] ??
      (geos.length
        ? `geo:${geos[0].lat.toFixed(4)}:${geos[0].lon.toFixed(4)}:${compactKeys[0]}`
        : undefined) ??
      `isolated:${members[0].listingId}`;
    const memberIndexes = new Set(indexes);
    const evidence = edges
      .filter((edge) => memberIndexes.has(edge.left) && memberIndexes.has(edge.right))
      .map((edge) => edge.evidence)
      .sort();
    const listingIds = members.map((member) => member.listingId).sort();
    const disambiguator =
      (geos.length ? `geo:${geos[0].lat.toFixed(4)}:${geos[0].lon.toFixed(4)}` : undefined) ??
      providerVenueIds[0] ??
      preciseDistrictScopes[0] ??
      `listing:${listingIds[0]}`;
    return { anchor, disambiguator, canonicalName, listingIds, evidence };
  });
  const anchorCounts = new Map<string, number>();
  for (const draft of venueDrafts)
    anchorCounts.set(draft.anchor, (anchorCounts.get(draft.anchor) ?? 0) + 1);
  const venues: ResolvedVenue[] = venueDrafts.map(
    ({ anchor, disambiguator, canonicalName, listingIds, evidence }) => {
      const id = identityHash(
        "venue.v1",
        anchorCounts.get(anchor) === 1 ? anchor : [anchor, disambiguator],
      );
      for (const listingId of listingIds) listingVenueIds[listingId] = id;
      return { id, canonicalName, listingIds, evidence };
    },
  );
  venues.sort((a, b) => a.id.localeCompare(b.id));
  return { venues, listingVenueIds, venueSeeds };
}

type Policy = "child-only" | "adult-only" | "workshop" | "performance" | `adaptation:${string}`;

type KnownAttendanceTiming =
  | { kind: "timed_session" }
  | { kind: "admission_window"; validFrom: string; validThrough: string };

function knownAttendanceTiming(listing: IdentityListing): KnownAttendanceTiming | null {
  const timing = listing.attendanceTiming;
  if (!timing || timing.kind === "unknown") return null;
  if (timing.kind === "timed_session") return { kind: "timed_session" };
  const validFrom = Date.parse(timing.validFrom);
  const validThrough = Date.parse(timing.validThrough);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validThrough) || validFrom > validThrough)
    return null;
  return {
    kind: "admission_window",
    validFrom: new Date(validFrom).toISOString(),
    validThrough: new Date(validThrough).toISOString(),
  };
}

function attendanceTimingConflict(
  left: IdentityListing,
  right: IdentityListing,
): string | undefined {
  const a = knownAttendanceTiming(left);
  const b = knownAttendanceTiming(right);
  if (!a || !b) return undefined;
  if (a.kind !== b.kind) return `attendance:${a.kind}-vs-${b.kind}`;
  if (
    a.kind === "admission_window" &&
    b.kind === "admission_window" &&
    (a.validFrom !== b.validFrom || a.validThrough !== b.validThrough)
  )
    return `attendance:window:${a.validFrom}/${a.validThrough}-vs-${b.validFrom}/${b.validThrough}`;
  return undefined;
}

function policies(listing: IdentityListing): Set<Policy> {
  const text = normalizeIdentityText(`${listing.title} ${listing.description}`);
  const title = normalizeIdentityText(listing.title);
  const result = new Set<Policy>();
  const childRange = [...text.matchAll(/\b(\d{1,2})\s+(?:ile\s+)?(\d{1,2})\s*yas\b/g)].some(
    (match) => Number(match[2]) <= 17,
  );
  if (
    childRange ||
    /\b(?:yalnizca|sadece) cocuklar icin\b/.test(text) ||
    /\bcocuklara ozel\b/.test(text)
  )
    result.add("child-only");
  if (
    /\b18\s*\+/.test(`${listing.title} ${listing.description}`) ||
    /\b18\s*yas\s+alti\s+(?:giremez|kabul edilmez)\b/.test(text) ||
    /\b(?:yalnizca|sadece) yetiskinler icin\b/.test(text) ||
    /\byetiskinlere ozel\b/.test(text)
  )
    result.add("adult-only");
  if (
    normalizeTitleKey(listing.title, listing.category).category === "workshop" ||
    /\b(?:atolye|workshop)\b/.test(title)
  )
    result.add("workshop");
  if (
    ["concert", "theatre", "standup"].includes(
      normalizeTitleKey(listing.title, listing.category).category,
    ) ||
    /\b(?:tiyatro oyunu|canli konser)\b/.test(title)
  )
    result.add("performance");
  const adaptation = /\buyarlama\s+([^.;\n]{1,60})/.exec(text)?.[1]?.trim();
  if (adaptation) result.add(`adaptation:${adaptation}`);
  return result;
}

function policyConflict(left: IdentityListing, right: IdentityListing): string | undefined {
  const a = policies(left);
  const b = policies(right);
  if ((a.has("child-only") && b.has("adult-only")) || (a.has("adult-only") && b.has("child-only")))
    return "audience:child-vs-adult";
  if ((a.has("workshop") && b.has("performance")) || (a.has("performance") && b.has("workshop")))
    return "format:workshop-vs-performance";
  const aAdaptations = [...a].filter((value): value is `adaptation:${string}` =>
    value.startsWith("adaptation:"),
  );
  const bAdaptations = [...b].filter((value): value is `adaptation:${string}` =>
    value.startsWith("adaptation:"),
  );
  if (aAdaptations.length && bAdaptations.length && !aAdaptations.some((value) => b.has(value)))
    return `adaptation:${aAdaptations.join(",")}-vs-${bAdaptations.join(",")}`;
  return undefined;
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\u001f");
}

function decisionInput(
  left: IdentityListing,
  right: IdentityListing,
  venueIds: Record<string, string>,
): unknown {
  return [left, right]
    .sort((a, b) => a.listingId.localeCompare(b.listingId))
    .map((listing) => ({
      listingId: listing.listingId,
      provider: listing.provider,
      city: cityKey(listing),
      startsAt: listing.startsAt,
      venueId: venueIds[listing.listingId],
      title: normalizeTitleKey(listing.title, listing.category),
      attendanceTiming: knownAttendanceTiming(listing),
      policies: [...policies(listing)].sort(),
    }));
}

export function assessIdentityPair(
  left: IdentityListing,
  right: IdentityListing,
  leftVenueId: string,
  rightVenueId: string,
): IdentityDecision {
  const listingIds = [left.listingId, right.listingId].sort() as [string, string];
  const venueIds = { [left.listingId]: leftVenueId, [right.listingId]: rightVenueId };
  const base = {
    listingIds,
    inputHash: identityHash("identity-decision-input.v2", decisionInput(left, right, venueIds)),
    ruleVersion: IDENTITY_RULE_VERSION,
  };
  const leftInstant = Date.parse(left.startsAt);
  const rightInstant = Date.parse(right.startsAt);
  if (
    !Number.isFinite(leftInstant) ||
    !Number.isFinite(rightInstant) ||
    leftInstant !== rightInstant
  )
    return {
      ...base,
      outcome: "never_merge",
      rule: "different-or-invalid-instant",
      evidence: [left.startsAt, right.startsAt].sort(),
    };
  if (cityKey(left) !== cityKey(right))
    return {
      ...base,
      outcome: "never_merge",
      rule: "different-city",
      evidence: [cityKey(left), cityKey(right)].sort(),
    };
  if (left.provider === right.provider)
    return {
      ...base,
      outcome: "never_merge",
      rule: "same-provider",
      evidence: [`provider:${left.provider}`],
    };
  if (leftVenueId !== rightVenueId)
    return {
      ...base,
      outcome: "never_merge",
      rule: "different-resolved-venue",
      evidence: [`venue:${leftVenueId}`, `venue:${rightVenueId}`].sort(),
    };
  const timingConflict = attendanceTimingConflict(left, right);
  if (timingConflict)
    return {
      ...base,
      outcome: "never_merge",
      rule: "attendance-timing-conflict",
      evidence: [timingConflict],
    };
  const conflict = policyConflict(left, right);
  if (conflict)
    return { ...base, outcome: "never_merge", rule: "policy-conflict", evidence: [conflict] };
  const leftTitle = normalizeTitleKey(left.title, left.category);
  const rightTitle = normalizeTitleKey(right.title, right.category);
  if (leftTitle.key && leftTitle.key === rightTitle.key)
    return {
      ...base,
      outcome: "auto_merge",
      rule: "same-venue-suffix-normalized-title",
      evidence: [`title-key:${leftTitle.key}`, `venue:${leftVenueId}`],
    };
  const leftSeed = titleSeedIdentity(left, venueSeedIdentity(left));
  const rightSeed = titleSeedIdentity(right, venueSeedIdentity(right));
  if (leftSeed && leftSeed === rightSeed)
    return {
      ...base,
      outcome: "manual_merge",
      rule: "guarded-title-seed",
      evidence: [`title-seed:${leftSeed}`, `venue:${leftVenueId}`],
    };
  return {
    ...base,
    outcome: "unresolved",
    rule: "same-venue-title-ambiguous",
    evidence: [`title-key:${leftTitle.key}`, `title-key:${rightTitle.key}`].sort(),
  };
}

function aggregatePolicyTag(
  listing: IdentityListing,
  family: readonly IdentityListing[],
): string | undefined {
  const familyPolicies = family.map(policies);
  const own = policies(listing);
  const hasChild = familyPolicies.some((set) => set.has("child-only"));
  const hasAdult = familyPolicies.some((set) => set.has("adult-only"));
  if (hasChild && hasAdult)
    return own.has("child-only")
      ? "audience:child-only"
      : own.has("adult-only")
        ? "audience:adult-only"
        : `audience:unspecified:${listing.listingId}`;
  const hasWorkshop = familyPolicies.some((set) => set.has("workshop"));
  const hasPerformance = familyPolicies.some((set) => set.has("performance"));
  if (hasWorkshop && hasPerformance)
    return own.has("workshop")
      ? "format:workshop"
      : own.has("performance")
        ? "format:performance"
        : `format:unspecified:${listing.listingId}`;
  const adaptations = [
    ...new Set(
      familyPolicies.flatMap((set) => [...set].filter((value) => value.startsWith("adaptation:"))),
    ),
  ];
  if (adaptations.length > 1) {
    const ownAdaptation = adaptations.find((value) => own.has(value as Policy));
    return ownAdaptation ?? `adaptation:unspecified:${listing.listingId}`;
  }
  return undefined;
}

function resolveSessions(
  listings: readonly IdentityListing[],
  listingVenueIds: Record<string, string>,
  venueSeeds: Map<string, string | undefined>,
): { sessions: ResolvedSession[]; decisions: IdentityDecision[] } {
  const buckets = new Map<string, number[]>();
  for (let index = 0; index < listings.length; index++) {
    const listing = listings[index];
    const instant = Date.parse(listing.startsAt);
    const bucket = Number.isFinite(instant)
      ? `${cityKey(listing)}\u001f${new Date(instant).toISOString()}`
      : `invalid:${listing.listingId}`;
    const members = buckets.get(bucket);
    if (members) members.push(index);
    else buckets.set(bucket, [index]);
  }
  const decisions: IdentityDecision[] = [];
  const decisionByPair = new Map<string, IdentityDecision>();
  const acceptedPairs: [number, number][] = [];
  for (const indexes of buckets.values()) {
    for (let i = 0; i < indexes.length; i++)
      for (let j = i + 1; j < indexes.length; j++) {
        const leftIndex = indexes[i];
        const rightIndex = indexes[j];
        const left = listings[leftIndex];
        const right = listings[rightIndex];
        const leftTitle = normalizeTitleKey(left.title, left.category);
        const rightTitle = normalizeTitleKey(right.title, right.category);
        const leftSeed = titleSeedIdentity(left, venueSeeds.get(left.listingId));
        const rightSeed = titleSeedIdentity(right, venueSeeds.get(right.listingId));
        const exactTitle = Boolean(leftTitle.key && leftTitle.key === rightTitle.key);
        const manualTitle = Boolean(leftSeed && leftSeed === rightSeed);
        const sameVenue = listingVenueIds[left.listingId] === listingVenueIds[right.listingId];
        if (!sameVenue && !exactTitle && !manualTitle) continue;
        let decision = assessIdentityPair(
          left,
          right,
          listingVenueIds[left.listingId],
          listingVenueIds[right.listingId],
        );
        if (sameVenue && (exactTitle || manualTitle) && decision.outcome !== "never_merge") {
          const family = indexes
            .map((index) => listings[index])
            .filter((candidate) => {
              if (listingVenueIds[candidate.listingId] !== listingVenueIds[left.listingId])
                return false;
              const candidateTitle = normalizeTitleKey(candidate.title, candidate.category).key;
              const candidateSeed = titleSeedIdentity(
                candidate,
                venueSeeds.get(candidate.listingId),
              );
              return (
                candidateTitle === leftTitle.key || Boolean(leftSeed && candidateSeed === leftSeed)
              );
            });
          const leftTag = aggregatePolicyTag(left, family);
          const rightTag = aggregatePolicyTag(right, family);
          if (leftTag && leftTag !== rightTag)
            decision = {
              ...decision,
              outcome: "never_merge",
              rule: "policy-conflict",
              evidence: [leftTag, rightTag ?? `unspecified:${right.listingId}`].sort(),
            };
        }
        decisions.push(decision);
        decisionByPair.set(pairKey(left.listingId, right.listingId), decision);
        if (decision.outcome === "auto_merge" || decision.outcome === "manual_merge")
          acceptedPairs.push([leftIndex, rightIndex]);
      }
  }
  acceptedPairs.sort(
    (a, b) =>
      listings[a[0]].listingId.localeCompare(listings[b[0]].listingId) ||
      listings[a[1]].listingId.localeCompare(listings[b[1]].listingId),
  );
  const sets = new DisjointSet(listings.length);
  for (const [left, right] of acceptedPairs) {
    const leftMembers = sets.members(left);
    const rightMembers = sets.members(right);
    if (sets.find(left) === sets.find(right)) continue;
    const providers = new Set(leftMembers.map((index) => listings[index].provider));
    let reason = rightMembers.some((index) => providers.has(listings[index].provider))
      ? "graph-same-provider-collision"
      : undefined;
    if (!reason)
      for (const a of leftMembers)
        for (const b of rightMembers) {
          const pair = decisionByPair.get(pairKey(listings[a].listingId, listings[b].listingId));
          if (!pair || (pair.outcome !== "auto_merge" && pair.outcome !== "manual_merge"))
            reason = "graph-pairwise-incompatibility";
        }
    if (reason) {
      const decision = decisionByPair.get(
        pairKey(listings[left].listingId, listings[right].listingId),
      );
      if (decision) {
        decision.outcome = "never_merge";
        decision.rule = reason;
        decision.evidence.push("transitive-merge-rejected");
      }
      continue;
    }
    sets.union(left, right);
  }
  const components = new Map<number, IdentityListing[]>();
  for (let index = 0; index < listings.length; index++) {
    const root = sets.find(index);
    const members = components.get(root);
    if (members) members.push(listings[index]);
    else components.set(root, [listings[index]]);
  }
  const sessionDrafts = [...components.values()].map((members) => {
    members.sort((a, b) => a.listingId.localeCompare(b.listingId));
    const listingIds = members.map((member) => member.listingId);
    const titleAnchors = members
      .map(
        (member) =>
          titleSeedIdentity(member, venueSeeds.get(member.listingId)) ??
          normalizeTitleKey(member.title, member.category).key,
      )
      .sort();
    const city = cityKey(members[0]);
    const startsAt = Number.isFinite(Date.parse(members[0].startsAt))
      ? new Date(members[0].startsAt).toISOString()
      : members[0].startsAt;
    const venueId = listingVenueIds[members[0].listingId];
    const baseAnchor = [city, startsAt, venueId, titleAnchors[0]];
    return {
      baseAnchor,
      listingIds,
      startsAt,
      city,
      venueId,
    };
  });
  const baseCounts = new Map<string, number>();
  for (const draft of sessionDrafts) {
    const key = JSON.stringify(draft.baseAnchor);
    baseCounts.set(key, (baseCounts.get(key) ?? 0) + 1);
  }
  const sessions: ResolvedSession[] = sessionDrafts
    .map(({ baseAnchor, ...draft }) => ({
      ...draft,
      id: identityHash(
        "session.v1",
        baseCounts.get(JSON.stringify(baseAnchor)) === 1
          ? baseAnchor
          : [...baseAnchor, `disambiguator:${draft.listingIds[0]}`],
      ),
    }))
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
  decisions.sort(
    (a, b) =>
      a.listingIds[0].localeCompare(b.listingIds[0]) ||
      a.listingIds[1].localeCompare(b.listingIds[1]),
  );
  return { sessions, decisions };
}

export function resolveIdentity(listings: readonly IdentityListing[]): IdentityResolution {
  const unique = new Set<string>();
  for (const listing of listings) {
    if (!listing.listingId || unique.has(listing.listingId))
      throw new Error(`Duplicate or empty listingId: ${listing.listingId}`);
    unique.add(listing.listingId);
  }
  const ordered = [...listings].sort((a, b) => a.listingId.localeCompare(b.listingId));
  const venueResolution = resolveVenues(ordered);
  const sessionResolution = resolveSessions(
    ordered,
    venueResolution.listingVenueIds,
    venueResolution.venueSeeds,
  );
  return {
    venues: venueResolution.venues,
    listingVenueIds: venueResolution.listingVenueIds,
    sessions: sessionResolution.sessions,
    decisions: sessionResolution.decisions,
  };
}
