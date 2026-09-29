import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { searchCatalogCandidates, type SearchCatalog } from '../../lib/materialized-catalog.ts';
import { emptyFilters } from '../../lib/types.ts';
import { buildGraphProjection, type VectorSnapshot } from './model.ts';

export async function loadSnapshot() {
  const catalogPath = process.env.GRAPH_CATALOG_PATH ?? resolve(import.meta.dirname, '../../work/event-preparation-20260929/search-after.json');
  const vectorsPath = process.env.GRAPH_VECTORS_PATH ?? resolve(import.meta.dirname, '../../work/event-preparation-20260929/vectors.json');
  const [catalogText, vectorsText] = await Promise.all([readFile(catalogPath, 'utf8'), readFile(vectorsPath, 'utf8')]);
  const catalog = JSON.parse(catalogText) as SearchCatalog, vectors = JSON.parse(vectorsText) as VectorSnapshot;
  const at = new Date(process.env.GRAPH_SNAPSHOT_AT ?? catalog.materializedAt);
  const events = searchCatalogCandidates(catalog, emptyFilters, at);
  const projection = buildGraphProjection(events, vectors);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  return { catalog, vectors, events, projection, at, eventMap: new Map(events.map(event => [event.id, event])),
    provenance: { catalogPath, vectorsPath, catalogHash: hash(catalogText), vectorHash: hash(vectorsText), frozenAt: at.toISOString() } };
}
