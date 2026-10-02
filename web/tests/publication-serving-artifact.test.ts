import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  decodePublicationServingArtifact, encodePublicationServingArtifact, servingArtifactObjectName,
  servingRowsContentRoot, type PublicationServingBinding, type PublicationServingHeader,
} from '../lib/publication-serving-artifact.node.ts';

const hex = (character: string) => character.repeat(64);
const row = (sessionId = 'session-1', offers = 1) => JSON.stringify({ sessionId, productionId: `p-${sessionId}`, venueId: null,
  snapshot: {}, document: { id: 'd', text: 'text', hash: hex('d'), embeddingProfile: 'profile', vector: null },
  pinnedOfferTerms: Array.from({ length: offers }, (_, i) => ({ offerId: `o${i}`, revisionId: `r${i}` })) });

function fixture(rows = [row()]) {
  const header: PublicationServingHeader = { schemaVersion: 1, kind: 'biplan-publication-serving', publicationId: 'publication-1',
    manifestHash: hex('a'), validationHash: hex('b'), offerProjectionVersion: 1, embeddingProfile: 'profile',
    sessionCount: rows.length, offerCount: rows.reduce((n, value) => n + JSON.parse(value).pinnedOfferTerms.length, 0),
    contentRoot: servingRowsContentRoot(rows) };
  const headerText = JSON.stringify(header); const encoded = encodePublicationServingArtifact(headerText, rows);
  const binding: PublicationServingBinding = { header, headerText, contentRoot: header.contentRoot, bucket: 'bucket-name',
    objectName: servingArtifactObjectName('staging', header.publicationId, encoded.compressedSha256), generation: '7', encoding: 'gzip', ...encoded };
  return { binding, ...encoded };
}
function uncheckedFixture(rows: string[]) {
  const base = fixture();
  const header = { ...base.binding.header, sessionCount: rows.length,
    offerCount: rows.reduce((n, value) => n + JSON.parse(value).pinnedOfferTerms.length, 0), contentRoot: servingRowsContentRoot(rows) };
  const headerText = JSON.stringify(header); const raw = Buffer.from(`${headerText}\n${rows.map(value => `${value}\n`).join('')}`);
  const compressed = gzipSync(raw); const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');
  return { compressed, binding: { ...base.binding, header, headerText, contentRoot: header.contentRoot,
    uncompressedBytes: raw.length, uncompressedSha256: digest(raw), compressedBytes: compressed.length, compressedSha256: digest(compressed) } };
}

void test('decodes exact verified artifact bytes into a vector-free immutable publication', async () => {
  const f = fixture();
  const publication = await decodePublicationServingArtifact(f.binding, f.compressed);
  assert.equal(publication.publicationId, 'publication-1');
  assert.equal(publication.sessions[0].document?.vector, null);
});

void test('rejects corrupt bytes and generation, profile, count, root, order and duplicate mismatches', async () => {
  const valid = fixture([row('a'), row('b')]);
  const cases: Array<[PublicationServingBinding, Buffer]> = [];
  cases.push([{ ...valid.binding, generation: 'latest' }, valid.compressed]);
  cases.push([{ ...valid.binding, compressedSha256: hex('0') }, valid.compressed]);
  cases.push([{ ...valid.binding, header: { ...valid.binding.header, schemaVersion: 2 as 1 } }, valid.compressed]);
  cases.push([{ ...valid.binding, headerText: `${valid.binding.headerText} ` }, valid.compressed]);
  cases.push([{ ...valid.binding, header: { ...valid.binding.header, sessionCount: 3 } }, valid.compressed]);
  cases.push([{ ...valid.binding, contentRoot: hex('c') }, valid.compressed]);
  for (const rows of [[row('b'), row('a')], [row('a'), row('a')]]) {
    const changed = uncheckedFixture(rows); cases.push([changed.binding, changed.compressed]);
  }
  for (const [binding, compressed] of cases) await assert.rejects(decodePublicationServingArtifact(binding, compressed));
});

void test('retains vector-free documents with a different profile for lexical coverage', async () => {
  const mixed = fixture([row('a').replace('"profile"', '"other"')]);
  const publication = await decodePublicationServingArtifact(mixed.binding, mixed.compressed);
  assert.equal(publication.sessions[0].document?.embeddingProfile, 'other');
});

void test('encoder rejects count, root, offer and ordering defects before immutable upload', () => {
  const f = fixture([row('a')]);
  for (const header of [
    { ...f.binding.header, sessionCount: 2 }, { ...f.binding.header, offerCount: 2 }, { ...f.binding.header, contentRoot: hex('e') },
  ]) assert.throws(() => encodePublicationServingArtifact(JSON.stringify(header), [row('a')]));
  assert.throws(() => encodePublicationServingArtifact(f.binding.headerText, [row('b'), row('a')]));
});

void test('bounded streaming decompression rejects a gzip expansion bomb', async () => {
  const f = fixture();
  const bomb = gzipSync(Buffer.alloc(128 * 1024 * 1024 + 1));
  const binding = { ...f.binding, compressedBytes: bomb.length,
    compressedSha256: createHash('sha256').update(bomb).digest('hex') };
  await assert.rejects(decodePublicationServingArtifact(binding, bomb), /raw bytes exceed/);
});

void test('object names are derived only from fixed environment, publication and digest', () => {
  const name = servingArtifactObjectName('staging', 'publication-1', hex('a'));
  assert.match(name, /^staging\/preparation\/serving\/v1\/[0-9a-f]{64}\/[a-f0-9]{64}\.ndjson\.gz$/);
  assert.throws(() => servingArtifactObjectName('staging', 'p', '../object'));
});
