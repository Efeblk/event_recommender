import { createHash } from 'node:crypto';
import { createGunzip, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import type { PreparedPublicationRead, PreparedPublicationSession } from './prepared-publication-search.ts';
import type { ExactGenerationObjectReader } from './gcp-clients.node.ts';

export const SERVING_ARTIFACT_LIMITS = {
  sessions: 20_000, lineBytes: 1024 * 1024, rawBytes: 128 * 1024 * 1024, gzipBytes: 32 * 1024 * 1024,
} as const;
const ROOT_DOMAIN = 'biplan-serving-rows-v1\n';
const HEX = /^[0-9a-f]{64}$/;
const SOURCE_HASH = /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/;

export interface PublicationServingHeader {
  schemaVersion: 1; kind: 'biplan-publication-serving'; publicationId: string;
  manifestHash: string; validationHash: string; offerProjectionVersion: number | null;
  embeddingProfile: string | null; sessionCount: number; offerCount: number; contentRoot: string;
}
export interface PublicationServingBinding {
  headerText: string; header: PublicationServingHeader; contentRoot: string; uncompressedBytes: number;
  bucket: string; objectName: string; generation: string; encoding: 'gzip'; compressedSha256: string;
  uncompressedSha256: string; compressedBytes: number;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function servingArtifactObjectName(environment: 'staging' | 'production', publicationId: string, compressedSha256: string) {
  if (!publicationId || !HEX.test(compressedSha256)) throw new Error('Invalid serving artifact identity');
  return `${environment}/preparation/serving/v1/${sha256(publicationId)}/${compressedSha256}.ndjson.gz`;
}
export function servingRowsContentRoot(rawRowTexts: readonly string[]) {
  return sha256(ROOT_DOMAIN + rawRowTexts.map(row => sha256(Buffer.from(row, 'utf8'))).join('\n') + (rawRowTexts.length ? '\n' : ''));
}

function lineBytes(line: string) {
  const bytes = Buffer.byteLength(line) + 1;
  if (bytes > SERVING_ARTIFACT_LIMITS.lineBytes) throw new Error('Serving artifact line exceeds supported bound');
  return bytes;
}
function validateHeader(value: unknown): asserts value is PublicationServingHeader {
  const h = value as Partial<PublicationServingHeader> | null;
  if (!h || h.schemaVersion !== 1 || h.kind !== 'biplan-publication-serving' || typeof h.publicationId !== 'string' || !h.publicationId ||
      !SOURCE_HASH.test(String(h.manifestHash)) || !SOURCE_HASH.test(String(h.validationHash)) || !HEX.test(String(h.contentRoot)) ||
      !(h.offerProjectionVersion === null || h.offerProjectionVersion === 1) || !(h.embeddingProfile === null || typeof h.embeddingProfile === 'string') ||
      !Number.isInteger(h.sessionCount) || h.sessionCount! < 0 || h.sessionCount! > SERVING_ARTIFACT_LIMITS.sessions ||
      !Number.isInteger(h.offerCount) || h.offerCount! < 0)
    throw new Error('Invalid serving artifact header');
}
export function encodePublicationServingArtifact(headerText: string, rawRowTexts: readonly string[]) {
  lineBytes(headerText);
  if (rawRowTexts.length > SERVING_ARTIFACT_LIMITS.sessions) throw new Error('Serving artifact session count exceeds supported bound');
  rawRowTexts.forEach(lineBytes);
  let header: unknown;
  try { header = JSON.parse(headerText); } catch { throw new Error('Invalid serving artifact header JSON'); }
  validateHeader(header);
  let offers = 0; let prior = '';
  for (const line of rawRowTexts) {
    let row: PreparedPublicationSession;
    try { row = JSON.parse(line) as PreparedPublicationSession; } catch { throw new Error('Invalid serving artifact row JSON'); }
    if (!row || typeof row.sessionId !== 'string' || row.sessionId <= prior || !Array.isArray(row.pinnedOfferTerms))
      throw new Error('Invalid or unordered serving artifact row');
    prior = row.sessionId; offers += row.pinnedOfferTerms.length;
  }
  if (header.sessionCount !== rawRowTexts.length || header.offerCount !== offers || header.contentRoot !== servingRowsContentRoot(rawRowTexts))
    throw new Error('Serving artifact header does not match rows');
  const raw = Buffer.from(`${headerText}\n${rawRowTexts.map(row => `${row}\n`).join('')}`, 'utf8');
  if (raw.length > SERVING_ARTIFACT_LIMITS.rawBytes) throw new Error('Serving artifact raw bytes exceed supported bound');
  const compressed = gzipSync(raw, { level: 9 });
  if (compressed.length > SERVING_ARTIFACT_LIMITS.gzipBytes) throw new Error('Serving artifact compressed bytes exceed supported bound');
  return { compressed, compressedSha256: sha256(compressed), uncompressedSha256: sha256(raw), compressedBytes: compressed.length, uncompressedBytes: raw.length };
}

async function gunzipBounded(compressed: Buffer, expectedBytes: number) {
  if (compressed.length > SERVING_ARTIFACT_LIMITS.gzipBytes) throw new Error('Serving artifact compressed bytes exceed supported bound');
  const gunzip = createGunzip(); const chunks: Buffer[] = []; let bytes = 0;
  for await (const value of Readable.from([compressed]).pipe(gunzip)) {
    const chunk = Buffer.from(value as Uint8Array); bytes += chunk.length;
    if (bytes > expectedBytes) { gunzip.destroy(); throw new Error('Serving artifact raw bytes exceed supported bound'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

export async function decodePublicationServingArtifact(binding: PublicationServingBinding, compressed: Buffer): Promise<PreparedPublicationRead> {
  validateHeader(binding.header);
  if (binding.encoding !== 'gzip' || !HEX.test(binding.compressedSha256) || !HEX.test(binding.uncompressedSha256) ||
      !HEX.test(binding.contentRoot) || !/^[1-9]\d*$/.test(binding.generation) ||
      !Number.isInteger(binding.compressedBytes) || binding.compressedBytes < 0 || binding.compressedBytes > SERVING_ARTIFACT_LIMITS.gzipBytes ||
      !Number.isInteger(binding.uncompressedBytes) || binding.uncompressedBytes < 0 || binding.uncompressedBytes > SERVING_ARTIFACT_LIMITS.rawBytes ||
      compressed.length !== binding.compressedBytes || sha256(compressed) !== binding.compressedSha256)
    throw new Error('Invalid serving artifact binding');
  const raw = await gunzipBounded(compressed, binding.uncompressedBytes);
  if (raw.length !== binding.uncompressedBytes || sha256(raw) !== binding.uncompressedSha256) throw new Error('Serving artifact byte verification failed');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { throw new Error('Serving artifact is not canonical UTF-8 NDJSON'); }
  if (!text.endsWith('\n')) throw new Error('Serving artifact is not canonical UTF-8 NDJSON');
  const lines = text.slice(0, -1).split('\n');
  if (!lines.length || lines[0] !== binding.headerText) throw new Error('Serving artifact header bytes differ from binding');
  lines.forEach(lineBytes);
  let parsedHeader: unknown;
  try { parsedHeader = JSON.parse(lines[0]); } catch { throw new Error('Invalid serving artifact header JSON'); }
  validateHeader(parsedHeader);
  for (const key of ['schemaVersion','kind','publicationId','manifestHash','validationHash','offerProjectionVersion','embeddingProfile','sessionCount','offerCount','contentRoot'] as const)
    if (parsedHeader[key] !== binding.header[key]) throw new Error('Serving artifact header differs from binding');
  const h = parsedHeader;
  if (h.contentRoot !== binding.contentRoot || lines.length - 1 !== h.sessionCount || servingRowsContentRoot(lines.slice(1)) !== h.contentRoot)
    throw new Error('Serving artifact content root or count mismatch');
  const sessions: PreparedPublicationSession[] = []; let prior = ''; let offers = 0;
  for (const line of lines.slice(1)) {
    let row: PreparedPublicationSession;
    try { row = JSON.parse(line) as PreparedPublicationSession; } catch { throw new Error('Invalid serving artifact row JSON'); }
    if (!row || typeof row.sessionId !== 'string' || row.sessionId <= prior || typeof row.productionId !== 'string' ||
        !(row.venueId === null || typeof row.venueId === 'string') || !Array.isArray(row.pinnedOfferTerms) ||
        (row.document !== null && (!row.document || row.document.vector !== null ||
          !(row.document.embeddingProfile === null || typeof row.document.embeddingProfile === 'string'))))
      throw new Error('Invalid or unordered serving artifact row');
    prior = row.sessionId; offers += row.pinnedOfferTerms.length; sessions.push(row);
  }
  if (offers !== h.offerCount) throw new Error('Serving artifact offer count mismatch');
  return { publicationId: h.publicationId, offerProjectionVersion: h.offerProjectionVersion, embeddingProfile: h.embeddingProfile, sessions };
}

export async function readPinnedPublicationServingArtifact(reader: ExactGenerationObjectReader, binding: PublicationServingBinding, signal?: AbortSignal) {
  const compressed = await reader.read(binding.bucket, binding.objectName, binding.generation, binding.compressedBytes, signal);
  if (!compressed) return null;
  return decodePublicationServingArtifact(binding, compressed);
}
