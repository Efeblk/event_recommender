import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GraphClient } from './client.ts';
import { loadSnapshot } from './snapshot.ts';
import { emptyFilters } from '../../lib/types.ts';
import { isEligible, normalize } from '../../lib/search.ts';

const snapshot = await loadSnapshot(), graph = new GraphClient();
const existing = await graph.query("MATCH (n:PrototypeSnapshot {id:'active'}) RETURN n.catalogHash AS catalogHash, n.vectorHash AS vectorHash, n.frozenAt AS frozenAt");
if (existing.length && ['catalogHash', 'vectorHash', 'frozenAt'].some(key => existing[0][key] !== snapshot.provenance[key as keyof typeof snapshot.provenance]))
  throw new Error('This prototype database belongs to a different frozen snapshot; create a separate experiment database rather than overwrite it.');
await graph.query("MERGE (n:PrototypeSnapshot {id:'active'}) SET n += $props", { props: { ...snapshot.provenance, state: 'loading' } });
for (const label of ['Program', 'Session', 'Venue', 'District', 'Neighborhood', 'Offer', 'SearchDocument'])
  await graph.query(`CREATE CONSTRAINT ${label.toLowerCase()}_id IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`);
async function batches(rows: Record<string, unknown>[], statement: string, batchSize = 128) {
  for (let i = 0; i < rows.length; i += batchSize) await graph.query(statement, { rows: rows.slice(i, i + batchSize) });
}
const p = snapshot.projection;
await batches(p.programs, 'UNWIND $rows AS row MERGE (n:Program {id:row.id}) SET n += row');
await batches(p.districts, 'UNWIND $rows AS row MERGE (n:District {id:row.id}) SET n += row');
await batches(p.neighborhoods.map(row => ({ ...row, keynormalized: normalize(row.name) })), 'UNWIND $rows AS row MERGE (n:Neighborhood {id:row.id}) SET n += row');
await batches(p.venues, 'UNWIND $rows AS row MERGE (n:Venue {id:row.id}) SET n += row');
const districts = 'adalar arnavutkoy atasehir avcilar bagcilar bahcelievler bakirkoy basaksehir bayrampasa besiktas beykoz beylikduzu beyoglu buyukcekmece catalca cekmekoy esenler esenyurt eyupsultan fatih gaziosmanpasa gungoren kadikoy kagithane kartal kucukcekmece maltepe pendik sancaktepe sariyer silivri sultanbeyli sultangazi sile sisli tuzla umraniye uskudar zeytinburnu'.split(' ');
const sessions = p.sessions.map(row => ({ ...row,
  startsAtMs: Date.parse(row.startsAt), checkedAtMs: Date.parse(row.checkedAt),
  clockFilterSupported: ['timed_session', 'unspecified'].includes(row.timingKind),
  districtEvidenceKeys: districts.filter(district => isEligible(snapshot.eventMap.get(row.id)!, { ...emptyFilters, district }, snapshot.at)),
}));
await batches(sessions, 'UNWIND $rows AS row MERGE (s:Session {id:row.id}) SET s += row WITH s,row MATCH (p:Program {id:row.programId}),(v:Venue {id:row.venueId}) MERGE (p)-[:HAS_SESSION]->(s) MERGE (s)-[:AT_VENUE]->(v)');
await batches(p.venues.filter(row => row.districtId), 'UNWIND $rows AS row MATCH (v:Venue {id:row.id}),(d:District {id:row.districtId}) MERGE (v)-[:IN_DISTRICT]->(d)');
await batches(p.venues.filter(row => row.neighborhoodId), 'UNWIND $rows AS row MATCH (v:Venue {id:row.id}),(n:Neighborhood {id:row.neighborhoodId}) MERGE (v)-[:IN_NEIGHBORHOOD]->(n)');
await batches(p.offers, 'UNWIND $rows AS row MERGE (o:Offer {id:row.id}) SET o += row WITH o,row MATCH (s:Session {id:row.sessionId}) MERGE (s)-[:HAS_OFFER]->(o)');
await batches(p.documents, 'UNWIND $rows AS row MERGE (d:SearchDocument {id:row.id}) SET d += row WITH d,row MATCH (s:Session {id:row.sessionId}),(p:Program {id:row.programId}) MERGE (s)-[:HAS_SEARCH_DOCUMENT]->(d) MERGE (p)-[:HAS_DOCUMENT]->(d)', 32);
await graph.query('CREATE INDEX session_day IF NOT EXISTS FOR (s:Session) ON (s.localDay)');
await graph.query('CREATE INDEX neighborhood_key IF NOT EXISTS FOR (n:Neighborhood) ON (n.keynormalized)');
await graph.query("CREATE VECTOR INDEX search_document_vector IF NOT EXISTS FOR (d:SearchDocument) ON d.embedding OPTIONS {indexConfig: {`vector.dimensions`:1024,`vector.similarity_function`:'cosine'}}");
await graph.query('CALL db.awaitIndexes(120)');
await graph.query("MATCH (n:PrototypeSnapshot {id:'active'}) SET n.state='ready'");
const counts = await graph.query('MATCH (n) RETURN labels(n)[0] AS label,count(*) AS count');
const dir = resolve(import.meta.dirname, '../../work/graph-20260929'); await mkdir(dir, { recursive: true });
const receipt = { at: new Date().toISOString(), ...snapshot.provenance, summary: p.summary, counts };
await writeFile(resolve(dir, 'load-receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
