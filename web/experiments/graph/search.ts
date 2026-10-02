import { hybridRankFromDenseOrder } from '../../lib/hybrid.ts';
import { validateIntentState, type IntentState } from '../../lib/input-state.ts';
import { meetsRequirements, type Requirement } from '../../lib/requirements.ts';
import { shortlistEvents } from '../../lib/retrieval.ts';
import { normalize } from '../../lib/search.ts';
import type { EventRecord, Filters } from '../../lib/types.ts';
import type { GraphClient } from './client.ts';

export interface GraphSearchInput {
  filters: Filters;
  query: string;
  queryVector?: number[];
  requirements?: Requirement[];
  neighborhood?: string;
  preferences?: IntentState['preferences'];
}

export interface GraphSearchTimings {
  graphMs: number;
  requirementsMs: number;
  vectorMs: number;
  rankingMs: number;
  totalMs: number;
}

export interface GraphSearchResult {
  eligible: EventRecord[];
  ranked: EventRecord[];
  shortlist: EventRecord[];
  timings: GraphSearchTimings;
  denseScores?: Map<string, number>;
}

const DEFAULT_PREFERENCES: IntentState['preferences'] = {
  mood: null,
  companion: null,
  interests: [],
};

function milliseconds(start: number) {
  return performance.now() - start;
}

function validateInput(input: GraphSearchInput): Required<Pick<GraphSearchInput, 'filters' | 'query' | 'requirements' | 'preferences'>> & Pick<GraphSearchInput, 'queryVector' | 'neighborhood'> {
  if (!input || typeof input !== 'object') throw new Error('Graph search input must be an object.');
  if (typeof input.query !== 'string' || input.query.length > 12_000)
    throw new Error('Graph search query is invalid.');
  if (input.neighborhood !== undefined &&
    (typeof input.neighborhood !== 'string' || !input.neighborhood.trim() || input.neighborhood.length > 160))
    throw new Error('Graph search neighborhood is invalid.');
  if (input.queryVector !== undefined &&
    (!Array.isArray(input.queryVector) || input.queryVector.length !== 1024 || input.queryVector.some((value) => typeof value !== 'number' || !Number.isFinite(value)) || !input.queryVector.some(value => value !== 0)))
    throw new Error('Graph search query vector must contain 1024 finite numbers.');
  const state = validateIntentState({
    version: 1,
    filters: input.filters,
    requirements: input.requirements ?? [],
    preferences: input.preferences ?? DEFAULT_PREFERENCES,
  });
  return {
    filters: state.filters,
    query: input.query,
    requirements: state.requirements,
    preferences: state.preferences,
    ...(input.queryVector ? { queryVector: input.queryVector } : {}),
    ...(input.neighborhood ? { neighborhood: input.neighborhood.trim() } : {}),
  };
}

const ELIGIBLE_QUERY = `
MATCH (s:Session)
WHERE ($dateFrom IS NULL OR s.localDay >= $dateFrom)
  AND ($dateTo IS NULL OR s.localDay <= $dateTo)
  AND ($category IS NULL OR s.category = $category)
  AND (size($categories) = 0 OR s.category IN $categories)
  AND NOT s.category IN $excludedCategories
  AND ($maxPrice IS NULL OR
    (s.price IS NOT NULL AND s.currency = 'TRY' AND
      CASE WHEN $maxPriceExclusive THEN s.price < $maxPrice ELSE s.price <= $maxPrice END))
  AND ($startTimeFrom IS NULL OR
    (s.clockFilterSupported = true AND
      CASE WHEN $startTimeFromExclusive THEN s.localMinutes > $startTimeFrom ELSE s.localMinutes >= $startTimeFrom END))
  AND ($startTimeTo IS NULL OR
    (s.clockFilterSupported = true AND
      CASE WHEN $startTimeToExclusive THEN s.localMinutes < $startTimeTo ELSE s.localMinutes <= $startTimeTo END))
  AND ($districtKey IS NULL OR $districtKey IN s.districtEvidenceKeys)
  AND ($neighborhoodKey IS NULL OR EXISTS {
    MATCH (s)-[:AT_VENUE]->(:Venue)-[:IN_NEIGHBORHOOD]->(n:Neighborhood)
    WHERE n.keynormalized = $neighborhoodKey
  })
RETURN s.id AS id`;

const VECTOR_QUERY = `
MATCH (s:Session)-[:HAS_SEARCH_DOCUMENT]->(d:SearchDocument)
WHERE s.id IN $ids AND d.embedding IS NOT NULL
RETURN s.id AS id, vector.similarity.cosine(d.embedding, $queryVector) AS score
ORDER BY score DESC, id ASC`;

function minute(value: string | undefined) {
  if (!value) return null;
  const [hour, minutes] = value.split(':').map(Number);
  return hour * 60 + minutes;
}

/** Searches a frozen eligible graph projection without truncating the candidate pool. */
export async function graphSearch(
  client: GraphClient,
  eventMap: Map<string, EventRecord>,
  rawInput: GraphSearchInput,
): Promise<GraphSearchResult> {
  const totalStart = performance.now();
  const input = validateInput(rawInput);
  const graphStart = performance.now();
  const rows = await client.query(ELIGIBLE_QUERY, {
    dateFrom: input.filters.dateFrom,
    dateTo: input.filters.dateTo,
    category: input.filters.category,
    categories: input.filters.categories ?? [],
    excludedCategories: input.filters.excludedCategories ?? [],
    maxPrice: input.filters.maxPrice,
    maxPriceExclusive: input.filters.maxPriceExclusive === true,
    startTimeFrom: minute(input.filters.startTimeFrom),
    startTimeTo: minute(input.filters.startTimeTo),
    startTimeFromExclusive: input.filters.startTimeFromExclusive === true,
    startTimeToExclusive: input.filters.startTimeToExclusive === true,
    districtKey: input.filters.district ? normalize(input.filters.district) : null,
    neighborhoodKey: input.neighborhood ? normalize(input.neighborhood) : null,
  });
  const graphMs = milliseconds(graphStart);
  const returnedIds = new Set(rows.map((row) => row.id).filter((id): id is string => typeof id === 'string'));
  // Neo4j does not promise row order here. Preserve the frozen catalog order.
  let eligible = [...eventMap].flatMap(([id, event]) => returnedIds.has(id) ? [event] : []);

  const requirementsStart = performance.now();
  if (input.requirements.length)
    eligible = eligible.filter((event) => meetsRequirements(event, input.requirements));
  const requirementsMs = milliseconds(requirementsStart);

  let denseScores: Map<string, number> | undefined;
  let denseIds: string[] = [];
  const vectorStart = performance.now();
  if (input.queryVector && eligible.length) {
    const allowed = new Set(eligible.map(({ id }) => id));
    const vectorRows = await client.query(VECTOR_QUERY, {
      ids: [...allowed],
      queryVector: input.queryVector,
    });
    denseScores = new Map();
    for (const row of vectorRows) {
      if (typeof row.id !== 'string' || !allowed.has(row.id) || typeof row.score !== 'number' || !Number.isFinite(row.score)) continue;
      // Neo4j cosine is [0, 1]. Preserve full precision after mapping to [-1, 1].
      denseScores.set(row.id, row.score * 2 - 1);
    }
    // Identical document vectors tie across sessions; match baseline stable order.
    denseIds = eligible.filter(event => denseScores!.has(event.id))
      .sort((a, b) => denseScores!.get(b.id)! - denseScores!.get(a.id)!).map(event => event.id);
  }
  const vectorMs = milliseconds(vectorStart);

  const rankingStart = performance.now();
  const ranked = input.queryVector
    ? hybridRankFromDenseOrder(eligible, input.query, denseIds)
    : hybridRankFromDenseOrder(eligible, input.query, []);
  const intent: IntentState = { version: 1, filters: input.filters, requirements: input.requirements, preferences: input.preferences };
  const semantic = input.queryVector
    ? { queryVector: input.queryVector, vectors: new Map<string, number[]>(), denseOrder: denseIds }
    : undefined;
  const shortlist = shortlistEvents(eligible, input.query, [], 16, semantic, intent);
  const rankingMs = milliseconds(rankingStart);
  return {
    eligible,
    ranked,
    shortlist,
    timings: { graphMs, requirementsMs, vectorMs, rankingMs, totalMs: milliseconds(totalStart) },
    ...(denseScores ? { denseScores } : {}),
  };
}
