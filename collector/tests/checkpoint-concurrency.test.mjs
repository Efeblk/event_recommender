import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson } from '../pipeline.mjs';
import { serializedCheckpointWriter } from '../coverage.mjs';

test('simultaneous collector completions preserve all progress without temporary-file collisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-coverage-concurrency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'coverage.json');
  const state = { entries: [] };
  const save = serializedCheckpointWriter(() => atomicJson(path, state));
  await Promise.all(Array.from({ length: 40 }, async (_, id) => {
    state.entries.push({ id });
    await save();
  }));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), state);
});

test('failed checkpoint is reported but does not poison later recovery writes', async () => {
  let attempts = 0;
  const save = serializedCheckpointWriter(async () => {
    if (++attempts === 1) throw new Error('disk failure');
    return 'saved';
  });
  await assert.rejects(save(), /disk failure/);
  assert.equal(await save(), 'saved');
});
