import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { bootstrapSummary, planGcpBootstrap } from '../lib/gcp-bootstrap.ts';
import type { EventRecord } from '../lib/types.ts';

const exec = promisify(execFile);
const finishedAt = '2026-09-26T18:00:00.000Z';
const savedAt = '2026-09-26T18:01:00.000Z';
const event = (id: string, url = `https://tickets.test/${id}`): EventRecord => ({
  id, title: `Event ${id}`, description: '', startsAt: '2026-10-01T17:00:00.000Z',
  venue: 'Venue', city: 'İstanbul', district: 'Kadıköy', address: '', price: 100,
  currency: 'TRY', url, imageUrl: '', category: 'Konser', availability: 'available',
  checkedAt: '2026-09-26T17:00:00.000Z',
});
const checkpoint = (events: EventRecord[]) => JSON.stringify({ schemaVersion: 1, savedAt, events, report: { finishedAt, summary: { events: events.length, available: events.length, refreshedPages: 1 } } });
const voyageProfile = 'voyage-embedding-v1|endpoint=https://api.voyageai.com/v1/embeddings|model=voyage-4-large|dimensions=1024|input_type=document|text_profile=event-title-category-venue-description-v1';
const vectorExport = (entries: unknown[], profile = voyageProfile) => JSON.stringify({ schemaVersion: 1, profile, dimensions: 1024, entries });

await test('bootstrap plan preserves checkpoint evidence and groups importable source URLs without normalization', async () => {
  const events = [event('one'), event('two', 'legacy:missing'), event('three', 'https://tickets.test/one')];
  const raw = checkpoint(events);
  const plan = await planGcpBootstrap(raw);
  assert.equal(plan.rawCheckpoint, raw);
  assert.equal(plan.checkpoint.savedAt, savedAt);
  assert.equal(plan.checkpoint.report.finishedAt, finishedAt);
  assert.equal(plan.eventCount, 3);
  assert.equal(plan.unsupportedUrlCount, 1);
  assert.equal(plan.pages.length, 1);
  assert.deepEqual(plan.pages[0].events, [events[0], events[2]]);
  assert.match(plan.checkpointSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(bootstrapSummary(plan).sourceCheckedAt, { earliest: events[0].checkedAt, latest: events[0].checkedAt });
});

await test('Voyage export requires exact profile hashes and finite nonzero 1024-vectors', async () => {
  const hash = 'a'.repeat(64), vector = Array(1024).fill(0).map((_, index) => index === 4 ? 1 : 0);
  const plan = await planGcpBootstrap(checkpoint([event('one')]), vectorExport([{ hash, vector }]));
  assert.equal(plan.vectors?.profile, voyageProfile);
  assert.equal(plan.vectors?.entries.length, 1);
  assert.match(plan.vectors!.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(planGcpBootstrap(checkpoint([event('one')]), vectorExport([{ hash, vector: vector.slice(1) }])), /Invalid Voyage cache entry/);
  await assert.rejects(planGcpBootstrap(checkpoint([event('one')]), vectorExport([{ hash, vector: Array(1024).fill(0) }])), /Invalid Voyage cache entry/);
  await assert.rejects(planGcpBootstrap(checkpoint([event('one')]), vectorExport([{ hash, vector }], 'voyage-embedding-v1|dimensions=1024')), /Invalid Voyage cache export/);
  await assert.rejects(planGcpBootstrap(checkpoint([event('one')]), vectorExport(Array(20_001).fill({}))), /Invalid Voyage cache export/);
});

await test('bootstrap rejects duplicate event identities instead of silently rewriting them', async () => {
  await assert.rejects(planGcpBootstrap(checkpoint([event('one'), event('one')])), /duplicate event IDs/);
});

await test('CLI defaults to a non-mutating summary and enforces the 64-page batch ceiling before SDK loading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gcp-bootstrap-'));
  try {
    const path = join(directory, 'checkpoint.json');
    await writeFile(path, checkpoint([event('one')]));
    const { stdout } = await exec(process.execPath, ['--experimental-strip-types', 'scripts/gcp-bootstrap.mjs', '--checkpoint', path], { cwd: new URL('..', import.meta.url) });
    const summary = JSON.parse(stdout);
    assert.equal(summary.mode, 'dry-run');
    assert.equal(summary.events, 1);
    await assert.rejects(exec(process.execPath, ['--experimental-strip-types', 'scripts/gcp-bootstrap.mjs', '--checkpoint', path, '--batch-pages', '65'], { cwd: new URL('..', import.meta.url) }), /batch-pages/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
