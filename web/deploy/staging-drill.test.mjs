import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPlan, createR2DrillKey, digestRows, parseArgs, validateLoadResponse, validateOptions, verifyR2RestorePhase } from '../scripts/staging-drill.mjs';

const valid = {
  origin: 'https://biplan-staging.example.workers.dev',
  expectedRevision: 'a'.repeat(40),
  sourceD1: 'biplan-staging',
  recoveryD1: 'biplan-staging-recovery-20260926',
  r2Bucket: 'biplan-staging-state',
  config: 'dist/server/wrangler.staging.json',
  maxLoadRequests: 7,
  execute: false,
  load: false,
};

await test('staging drill is a printable dry run by default', () => {
  const options = validateOptions(valid);
  const plan = buildPlan(options);
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.environment, 'staging');
  assert.match(plan.artifactDir, /[\\/]work[\\/]staging-drill-/);
  assert.ok(plan.commands.some((command) => command.includes('export')));
  assert.ok(plan.commands.flat().every((value) => !String(value).includes('secret')));
});

await test('execution requires isolated staging-named resources and bounded load', () => {
  for (const override of [
    { sourceD1: 'biplan-production' },
    { recoveryD1: 'biplan-staging' },
    { recoveryD1: 'biplan-staging-copy' },
    { r2Bucket: 'shared-state' },
    { expectedRevision: 'ABC' },
    { maxLoadRequests: 13 },
    { origin: 'http://biplan-staging.example.com' },
  ]) assert.throws(() => validateOptions({ ...valid, ...override }));
  assert.throws(() => validateOptions({ ...valid, load: true }), /requires --execute/);
});

await test('argument parser enables execution only through explicit flags', () => {
  const parsed = parseArgs([
    '--origin', valid.origin,
    '--expected-revision', valid.expectedRevision,
    '--source-d1', valid.sourceD1,
    '--recovery-d1', valid.recoveryD1,
    '--r2-bucket', valid.r2Bucket,
    '--config', valid.config,
    '--max-load-requests', '12',
    '--execute',
    '--load',
  ]);
  assert.equal(parsed.execute, true);
  assert.equal(parsed.load, true);
  assert.equal(parsed.maxLoadRequests, 12);
});

await test('content integrity rejects equal row counts with changed payloads', () => {
  const columns = ['id', 'payload'];
  const source = [
    { id: 'a', payload: '{"price":100}' },
    { id: 'b', payload: '{"price":200}' },
  ];
  const tampered = [
    { id: 'a', payload: '{"price":100}' },
    { id: 'b', payload: '{"price":1}' },
  ];
  assert.equal(source.length, tampered.length);
  assert.notEqual(digestRows(source, columns), digestRows(tampered, columns));
});

await test('R2 drill keys are revision-scoped and isolated from canonical state', () => {
  const revision = 'b'.repeat(40);
  const key = createR2DrillKey(revision, '0123456789abcdef0123456789abcdef');
  assert.equal(key, `drills/checkpoint-restore/${revision}/0123456789abcdef0123456789abcdef.json`);
  assert.equal(key.includes('collection-state'), false);
  assert.throws(() => createR2DrillKey(revision, '../canonical'));
});

await test('R2 restore phases require exact bytes, deliberate corruption, and checkpoint semantics', () => {
  const original = Buffer.from(JSON.stringify({ schemaVersion: 1, savedAt: '2026-09-26T20:00:00.000Z', events: [{ id: 'a' }] }));
  assert.equal(verifyR2RestorePhase(original, Buffer.from(original), 'backup').semanticEquivalent, true);
  const corrupt = Buffer.from('{"schemaVersion":0,"kind":"intentional-staging-drill-corruption"}\n');
  assert.equal(verifyR2RestorePhase(original, corrupt, 'corrupted').semanticEquivalent, false);
  assert.equal(verifyR2RestorePhase(original, Buffer.from(original), 'restored').semanticEquivalent, true);
  assert.throws(() => verifyR2RestorePhase(original, Buffer.from('{}'), 'restored'));
  assert.throws(() => verifyR2RestorePhase(original, Buffer.from(original), 'corrupted'));
});

await test('load response validation rejects fallback, hard-constraint, and duplicate failures', () => {
  const event = {
    id: 'concert-1', title: 'Konser', startsAt: '2026-10-01T17:00:00Z', venue: 'Sahne',
    category: 'Konser', price: 900, url: 'https://tickets.example/concert-1', source: 'biletix',
  };
  assert.deepEqual(validateLoadResponse({ mode: 'jev', status: 'results', recommendations: [{ event }] }), []);
  assert.ok(validateLoadResponse({ mode: 'filters', status: 'results', recommendations: [{ event }] }).length);
  assert.ok(validateLoadResponse({ mode: 'jev', status: 'results', recommendations: [
    { event: { ...event, price: 1001 } }, { event },
  ] }).length);
  assert.ok(validateLoadResponse({ mode: 'jev', status: 'results', recommendations: [{ event }, { event }] }).length);
});
