import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = (await readFile(new URL('../../.github/workflows/gcp-staging.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
const collectorWorkflow = (await readFile(new URL('../../.github/workflows/gcp-collector.yml', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');

function inlineNode(source, command) {
  const lines = source.split('\n');
  const start = lines.findIndex(line => line.includes(command) && line.trimEnd().endsWith("<<'NODE'"));
  assert.notEqual(start, -1, `Missing inline validator: ${command}`);
  const indent = lines[start].match(/^\s*/)[0];
  const end = lines.findIndex((line,index) => index > start && line === `${indent}NODE`);
  assert.notEqual(end, -1, `Unterminated inline validator: ${command}`);
  return `${lines.slice(start + 1, end).map(line => line.startsWith(indent) ? line.slice(indent.length) : line).join('\n')}\n`;
}

const revisionValidator = inlineNode(workflow, 'node - "$STATE_DIR/revision.json"');
const configuredTags = inlineNode(workflow, 'node - "$STATE_DIR/service.json" > candidate-traffic-tags.json');
const trafficValidator = inlineNode(workflow, 'node - service-after-traffic.json candidate-traffic-tags.json');
const endpointValidator = inlineNode(workflow, 'node - health.json ready.json');
const monitorValidator = inlineNode(collectorWorkflow, 'node - monitor-evidence/status.txt monitor-evidence/ready.json monitor-evidence/validation.json');

function childNode(code, files, env = {}) {
  return spawnSync(process.execPath, ['-', ...files], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input: code,
  });
}

function accepted(result) {
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
}

function rejected(result, message) {
  assert.notEqual(result.status, 0, 'Validator unexpectedly accepted an unsafe fixture');
  assert.match(`${result.stdout}${result.stderr}`, message);
}

await test('collector monitor initializes evidence after checkout on every outcome', () => {
  const monitor = collectorWorkflow.slice(collectorWorkflow.indexOf('  monitor:'));
  const checkout = monitor.indexOf('uses: actions/checkout@');
  const initializer = monitor.indexOf('name: Initialize readiness evidence');
  const setupNode = monitor.indexOf('uses: actions/setup-node@');
  assert.ok(checkout >= 0 && checkout < initializer);
  assert.ok(initializer < setupNode);
  assert.match(monitor, /name: Initialize readiness evidence\n\s+if: always\(\)/);
});

await test('deployed revision validator enforces readiness, digest, SHA and snapshot runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-gcp-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'revision.json');
  const candidate = 'biplan-staging-00033-abc';
  const image = 'europe-west1-docker.pkg.dev/example/staging/biplan@sha256:' + 'a'.repeat(64);
  const sha = 'b'.repeat(40);
  const env = { CANDIDATE_REVISION: candidate, IMAGE_REF: image, EXPECTED_SHA: sha, INPUT_INTERPRETER: 'span-v2' };
  const valid = {
    metadata: { name: candidate },
    spec: { containers: [{ image, env: [
      { name: 'BIPLAN_RUNTIME', value: 'node' },
      { name: 'DEPLOYMENT_ENV', value: 'staging' },
      { name: 'DEPLOYMENT_SHA', value: sha },
      { name: 'INPUT_INTERPRETER', value: 'span-v2' },
    ] }] },
    status: { conditions: [{ type: 'Ready', status: 'True' }] },
  };
  const run = async value => {
    await writeFile(file, JSON.stringify(value));
    return childNode(revisionValidator, [file], env);
  };
  accepted(await run(valid));
  rejected(await run({ ...valid, spec: { containers: [{ ...valid.spec.containers[0], image: image.replace(/a+$/, 'c'.repeat(64)) }] } }), /reviewed digest/);
  rejected(await run({ ...valid, spec: { containers: [{ ...valid.spec.containers[0], env: valid.spec.containers[0].env.map(item => item.name === 'DEPLOYMENT_SHA' ? { ...item, value: 'd'.repeat(40) } : item) }] } }), /DEPLOYMENT_SHA/);
  rejected(await run({ ...valid, status: { conditions: [{ type: 'Ready', status: 'False' }] } }), /not ready/);
  rejected(await run({ ...valid, spec: { containers: [{ ...valid.spec.containers[0], env: [...valid.spec.containers[0].env, { name: 'CATALOG_BACKEND', value: 'pipeline' }] }] } }), /not snapshot-backed/);
});

await test('traffic validator requires the named candidate at 100 percent and preserves configured tag semantics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-gcp-traffic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const serviceFile = join(directory, 'service.json');
  const tagsFile = join(directory, 'tags.json');
  const candidate = 'biplan-staging-00033-abc';
  const old = 'biplan-staging-00032-def';
  const configured = [
    { tag: 'preview', latestRevision: true, percent: 0 },
    { tag: 'stable', revisionName: old, percent: 0 },
    { revisionName: candidate, percent: 100 },
  ];
  const service = {
    spec: { traffic: configured },
    status: { traffic: [
      { tag: 'preview', revisionName: candidate, percent: 0 },
      { tag: 'stable', revisionName: old, percent: 0 },
      { revisionName: candidate, percent: 100 },
    ] },
  };
  await writeFile(serviceFile, JSON.stringify(service));
  const captured = childNode(configuredTags, [serviceFile]);
  accepted(captured);
  assert.deepEqual(JSON.parse(captured.stdout), [
    { tag: 'preview', target: 'LATEST' },
    { tag: 'stable', target: old },
  ]);
  await writeFile(tagsFile, captured.stdout);
  accepted(childNode(trafficValidator, [serviceFile, tagsFile], { CANDIDATE_REVISION: candidate }));

  const pinnedOld = { ...service, status: { traffic: [{ revisionName: old, percent: 100 }] } };
  await writeFile(serviceFile, JSON.stringify(pinnedOld));
  rejected(childNode(trafficValidator, [serviceFile, tagsFile], { CANDIDATE_REVISION: candidate }), /does not have 100 percent traffic/);

  const changedTags = { ...service, spec: { traffic: configured.map(target => target.tag === 'stable' ? { ...target, revisionName: candidate } : target) } };
  await writeFile(serviceFile, JSON.stringify(changedTags));
  rejected(childNode(trafficValidator, [serviceFile, tagsFile], { CANDIDATE_REVISION: candidate }), /tags changed/);

  const pinnedLatestTag = { ...service, spec: { traffic: configured.map(target => target.tag === 'preview' ? { tag: target.tag, revisionName: candidate, percent: target.percent } : target) } };
  await writeFile(serviceFile, JSON.stringify(pinnedLatestTag));
  rejected(childNode(trafficValidator, [serviceFile, tagsFile], { CANDIDATE_REVISION: candidate }), /tags changed/);
});

await test('authenticated deployment endpoint validator requires health and ready snapshot evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-gcp-endpoints-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const healthFile = join(directory, 'health.json');
  const readyFile = join(directory, 'ready.json');
  const sha = 'b'.repeat(40);
  const env = { HEALTH_ENVIRONMENT: 'staging', HEALTH_REVISION: sha };
  const health = {
    status: 'ok',
    deployment: { environment: 'staging', revision: sha },
  };
  const ready = {
    ready: true,
    checkedAt: '2026-10-08T12:00:00.000Z',
    reasons: [],
    catalog: { status: 'ready', stored: 20, eligible: 10 },
    checkpoint: {
      savedAt: '2026-10-08T11:00:00.000Z',
      finishedAt: '2026-10-08T10:59:00.000Z',
      events: 20,
      bytes: 1000,
      summary: {},
    },
  };
  const run = async (healthValue, readyValue) => {
    await Promise.all([
      writeFile(healthFile, JSON.stringify(healthValue)),
      writeFile(readyFile, JSON.stringify(readyValue)),
    ]);
    return childNode(endpointValidator, [healthFile, readyFile], env);
  };

  accepted(await run(health, ready));
  rejected(await run(health, { ...ready, ready: false, reasons: ['catalog_not_ready'] }), /not ready/);
  rejected(await run(health, { ...ready, catalog: { ...ready.catalog, eligible: 0 } }), /catalog is invalid/);
  rejected(await run(health, { ...ready, checkpoint: null }), /checkpoint is invalid/);
});

await test('collector monitor requires a fresh, active and converged publication', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'biplan-gcp-monitor-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const statusFile = join(directory, 'status.txt');
  const readyFile = join(directory, 'ready.json');
  const summaryFile = join(directory, 'validation.json');
  const collectedAt = new Date(Date.now() - 3600000).toISOString();
  const ready = {
    ready: true,
    reasons: [],
    catalog: { eligible: 10, lastCheckedAt: collectedAt },
    search: {
      pending: false,
      latestCollectedAt: collectedAt,
      activeCollectedAt: collectedAt,
    },
    checkpoint: { finishedAt: collectedAt },
  };
  const run = async (body, status = '200') => {
    await Promise.all([
      writeFile(statusFile, `${status}\n`),
      writeFile(readyFile, JSON.stringify(body)),
    ]);
    return childNode(monitorValidator, [statusFile, readyFile, summaryFile], { MAX_AGE_HOURS: '14' });
  };

  accepted(await run(ready));
  const summary = JSON.parse(await readFile(summaryFile, 'utf8'));
  assert.equal(summary.completed, true);
  assert.deepEqual(summary.problems, []);
  assert.deepEqual(summary.publication, {
    pending: false,
    latestCollectedAt: collectedAt,
    activeCollectedAt: collectedAt,
    checkpointFinishedAt: collectedAt,
  });

  rejected(await run({ ...ready, search: { ...ready.search, pending: true } }), /publication_pending/);
  rejected(await run({ ...ready, search: { ...ready.search, latestCollectedAt: new Date(Date.now() - 7200000).toISOString() } }), /publication_mismatch/);
  rejected(await run({ ...ready, search: undefined }), /publication_proof_missing/);
  rejected(await run({ ...ready, checkpoint: { finishedAt: '2026-10-09 12:00:00Z' } }), /publication_proof_missing/);
  rejected(await run({ ...ready, reasons: ['catalog_not_ready'] }), /readiness_reasons/);
  rejected(await run({ ...ready, catalog: { ...ready.catalog, lastCheckedAt: new Date(Date.now() - 15 * 3600000).toISOString() } }), /catalog_freshness/);
  rejected(await run(ready, '503'), /http_status/);
});
