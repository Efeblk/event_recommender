import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { reconcileSupportedCatalog, supportedCanonicalIdentity, supportedSessionIdentityKey } from './canonical-identity.mjs';
import { prepareLexicalDocumentTokens } from '../../web/lib/hybrid.ts';
import { voyageDocumentText } from '../../web/lib/voyage.ts';

const repo = resolve(import.meta.dirname, '..', '..');
const inputPath = resolve(process.argv[2] ?? resolve(repo, 'web/work/event-preparation-20260929/search-anka-reviewed.json'));
const outputPath = resolve(process.argv[3] ?? resolve(repo, 'web/work/event-preparation-20261001/search-sosyal-sanathane-reviewed.json'));
const auditPath = resolve(process.argv[4] ?? resolve(repo, 'web/work/event-preparation-20261001/sosyal-sanathane-identity-audit.json'));
const digest = value => createHash('sha256').update(value).digest('hex');
const allEvents = catalog => catalog.groups.flatMap(group => group.versions.flatMap(version => version.events));
const countShape = catalog => ({
  groups: catalog.groups.length,
  versions: catalog.groups.reduce((sum, group) => sum + group.versions.length, 0),
  eventProjections: allEvents(catalog).length,
});

const inputText = await readFile(inputPath, 'utf8');
const input = JSON.parse(inputText);
const familyEvents = allEvents(input).filter(event => String(event.venue).includes('Sosyal Sanathane'));
const uniqueFamily = [...new Map(familyEvents.map(event => [event.id, event])).values()];
const general = uniqueFamily.filter(event => supportedCanonicalIdentity(event));
const byIdentity = new Map();
for (const event of general) {
  const key = supportedSessionIdentityKey(event);
  (byIdentity.get(key) ?? byIdentity.set(key, []).get(key)).push(event);
}
const authoritativePairs = [...byIdentity.entries()].filter(([, events]) => events.length === 2);
for (const [key, events] of authoritativePairs) {
  if (new Set(events.map(event => event.source)).size !== 2 || new Set(events.map(event => event.price)).size !== 1)
    throw new Error(`reviewed family lost independent matching evidence: ${key}`);
}
const output = reconcileSupportedCatalog(input);
const outputEvents = allEvents(output);
const inputPrepared = new Map(allEvents(input).flatMap(event => event.preparedSearch
  ? [[event.preparedSearch.documentHash, JSON.stringify(event.preparedSearch)]] : []));
for (const event of outputEvents) if (event.preparedSearch) {
  const old = inputPrepared.get(event.preparedSearch.documentHash);
  if (old !== JSON.stringify(event.preparedSearch)) throw new Error(`prepared search artifact changed: ${event.id}`);
  const documentText = voyageDocumentText(event);
  const documentHash = digest(documentText);
  if (event.preparedSearch.documentText !== documentText || event.preparedSearch.documentHash !== documentHash)
    throw new Error(`prepared search document dependency mismatch: ${event.id}`);
  if (JSON.stringify(event.preparedSearch.lexicalTokens) !== JSON.stringify(prepareLexicalDocumentTokens(event)))
    throw new Error(`prepared lexical dependency mismatch: ${event.id}`);
}
const pairedRawIds = new Set(authoritativePairs.flatMap(([, events]) => events.map(event => event.id)));
const outputMerged = outputEvents.filter(event => (event.mergedIds ?? []).filter(id => pairedRawIds.has(id)).length === 2);
const outputPairKeys = new Set(outputMerged.map(supportedSessionIdentityKey));
if (outputPairKeys.size !== authoritativePairs.length)
  throw new Error(`expected ${authoritativePairs.length} reconciled sessions, found ${outputPairKeys.size}`);

const titleSummary = [...new Map(uniqueFamily.map(event => [event.title, []])).keys()].sort().map(title => {
  const events = uniqueFamily.filter(event => event.title === title);
  return { title, records: events.length, sessions: new Set(events.map(event => event.startsAt)).size,
    sources: [...new Set(events.flatMap(event => (event.offers?.length ? event.offers : [event]).map(offer => offer.source)))].sort() };
});
const audit = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  input: { path: inputPath, sha256: digest(inputText), ...countShape(input) },
  output: { path: outputPath, ...countShape(output) },
  reviewedEvidence: {
    rawSnapshots: [
      'web/work/workshop-input-20260928/catalog-runs/collect-02/events.json',
      'web/work/workshop-input-20260928/final-stage4-20260928/execution-20260928T174213075Z/state/events.json',
    ],
    venueFamilyUniqueRecords: uniqueFamily.length,
    titleSummary,
    generalProgrammeRecords: general.length,
    exactCrossProviderSessionPairs: authoritativePairs.map(([identity, events]) => ({ identity,
      ids: events.map(event => event.id).sort(), sources: events.map(event => event.source).sort(),
      startsAt: events[0].startsAt, venue: events[0].venue, address: events[0].address, price: events[0].price })),
    distinctActivityTitles: titleSummary.filter(item => !item.title.startsWith('Workshop:')).map(item => item.title),
  },
  checks: {
    groupDelta: output.groups.length - input.groups.length,
    expectedMergedSessions: authoritativePairs.length,
    actualMergedSessions: outputPairKeys.size,
    sourceOffersPreserved: authoritativePairs.every(([, events]) => {
      const ids = events.map(event => event.id);
      return outputMerged.some(event => ids.every(id => event.offers.some(offer => offer.id === id)));
    }),
    preparedSearchArtifactsReusedExactly: true,
    allPreparedDocumentsMatchCurrentEventFacts: true,
    allPreparedLexicalTokensMatchCurrentEventFacts: true,
    embeddingsRequested: 0,
    externalCalls: 0,
  },
  limitations: [
    'This is an ignored local frozen artifact and was not published to PostgreSQL, GCP, or an HTTP runtime.',
    'Only the two reviewed generic titles at the exact Kadıköy venue/address receive shared identity; named activities and different instants remain separate.',
  ],
};

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(auditPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output)}\n`);
await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ outputPath, auditPath, before: countShape(input), after: countShape(output), pairs: authoritativePairs.length })}\n`);
