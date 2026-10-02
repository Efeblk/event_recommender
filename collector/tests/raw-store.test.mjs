import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemRawStore } from '../raw/store.mjs';
import { createGcsRawMirror, STAGING_RAW_BUCKET, STAGING_RAW_PREFIX } from '../raw/gcs.mjs';
const metadata = { url: 'https://www.bubilet.com.tr/istanbul/etkinlik/test', status: 200, fetchedAt: '2026-10-02T10:00:00Z', headers: { 'content-type': 'text/html', 'set-cookie': 'private' } };

test('raw bodies deduplicate while every fetch retains metadata and corruption fails closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-raw-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFilesystemRawStore(directory);
  const first = await store.put(Buffer.from([0xff, 0x00, 0xc3]), metadata);
  const second = await store.put(Buffer.from([0xff, 0x00, 0xc3]), { ...metadata, fetchedAt: '2026-10-02T10:00:01Z' });
  assert.deepEqual(first.rawObjectRef, second.rawObjectRef);
  assert.notEqual(first.fetchId, second.fetchId);
  assert.equal((await readdir(join(directory, 'bodies'))).length, 1);
  assert.equal((await readdir(join(directory, 'fetches'))).length, 2);
  assert.deepEqual(await store.read(first.rawObjectRef), Buffer.from([0xff, 0x00, 0xc3]));
  const receipt = JSON.parse(await readFile(join(directory, 'fetches', `${first.fetchId}.json`)));
  assert.equal(receipt.headers['set-cookie'], undefined);
  await writeFile(join(directory, first.rawObjectRef.key), 'corrupt');
  await assert.rejects(store.read(first.rawObjectRef), /raw_integrity_failure/);
});

test('raw admission covers existing files and rejects growth without deleting references', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-raw-limit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createFilesystemRawStore(directory, { maxBytes: 10 });
  await assert.rejects(store.put(Buffer.alloc(11), metadata), /admission/);
});

test('cloud mirror is immutable, generation-pinned, destination-scoped and byte-verified', async () => {
  const body = Buffer.from('retained provider body');
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const ref = { sha256, key: `bodies/${sha256}.bin`, bytes: body.length };
  const calls = [];
  const mirror = createGcsRawMirror({ bucket: STAGING_RAW_BUCKET, prefix: STAGING_RAW_PREFIX, accessToken: async () => 'test-token', fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method });
    if (options.method === 'POST') return new Response(null, { status: 412 });
    if (url.includes('alt=media')) return new Response(body);
    return Response.json({ generation: '42', size: String(body.length) });
  } });
  assert.equal((await mirror.put(body, ref)).generation, '42');
  assert.match(calls[0].url, /ifGenerationMatch=0/);
  assert.match(calls[2].url, /generation=42/);
  assert.throws(() => createGcsRawMirror({ bucket: 'foreign', prefix: STAGING_RAW_PREFIX, accessToken: async () => 'x' }), /unapproved/);
  const corrupt = createGcsRawMirror({ bucket: STAGING_RAW_BUCKET, prefix: STAGING_RAW_PREFIX, accessToken: async () => 'x', fetchImpl: async (url, options) => options.method === 'POST' ? new Response(null) : url.includes('alt=media') ? new Response(Buffer.alloc(body.length)) : Response.json({ generation: '42', size: body.length }) });
  await assert.rejects(corrupt.put(body, ref), /binding_mismatch/);
});
