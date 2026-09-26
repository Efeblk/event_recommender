import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkpointReadiness,
  parseCollectionReport,
  parseCheckpointPointer,
  type CheckpointPointer,
} from '../lib/operations.ts';

const now = Date.parse('2026-09-22T09:00:00.000Z');
const pointer: CheckpointPointer = {
  schemaVersion: 1,
  key: 'collection/checkpoint.json',
  savedAt: '2026-09-22T08:00:00.000Z',
  finishedAt: '2026-09-22T07:59:00.000Z',
  events: 400,
  bytes: 1000,
  summary: { blocked: null },
};

await test('collection reports reject blocked and malformed runs', () => {
  const summary = {
    blocked: null,
    events: 400,
    available: 350,
    refreshedPages: 10,
  };
  assert.deepEqual(
    parseCollectionReport({
      schemaVersion: 1,
      report: { finishedAt: pointer.finishedAt, summary },
    }),
    { finishedAt: pointer.finishedAt, summary },
  );
  assert.throws(() =>
    parseCollectionReport({
      schemaVersion: 1,
      report: {
        finishedAt: pointer.finishedAt,
        summary: { ...summary, blocked: 'crawl_failed' },
      },
    }),
  );
  assert.throws(() =>
    parseCollectionReport({
      schemaVersion: 1,
      report: { finishedAt: 'yesterday', summary: {} },
    }),
  );
  assert.throws(() =>
    parseCollectionReport(
      {
        schemaVersion: 1,
        report: { finishedAt: '2026-09-22T09:06:00.000Z', summary },
      },
      now,
    ),
  );
});

await test('checkpoint pointers fail closed and readiness explains failures', () => {
  assert.equal(parseCheckpointPointer('{bad'), null);
  assert.equal(
    parseCheckpointPointer(JSON.stringify({ ...pointer, savedAt: 'today' })),
    null,
  );
  assert.equal(
    parseCheckpointPointer(
      JSON.stringify({ ...pointer, key: '../checkpoint.json' }),
    ),
    null,
  );
  assert.deepEqual(
    checkpointReadiness(
      { status: 'ready', stored: 400, eligible: 10 },
      pointer,
      now,
    ),
    [],
  );
  assert.deepEqual(
    checkpointReadiness(
      { status: 'empty', stored: 10, eligible: 0 },
      { ...pointer, savedAt: '2026-09-20T08:00:00.000Z' },
      now,
    ),
    ['catalog_not_ready', 'checkpoint_stale', 'major_catalog_drop'],
  );
  assert.deepEqual(
    checkpointReadiness(
      { status: 'ready', stored: 400, eligible: 100 },
      { ...pointer, summary: { available: 350 } },
      now,
    ),
    ['major_catalog_drop'],
  );
});
