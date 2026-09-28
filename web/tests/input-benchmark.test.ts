import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);

void test('input-intent evaluator enforces strict hard fields and safety assertions', async () => {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['scripts/check-input-intent.mjs', '--self-test'],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), {
    status: 'pass',
    mode: 'evaluator-self-test',
    assertions: 12,
    liveRequests: 0,
  });
});

void test('live evaluator caps actual provider rounds and records both audited calls', async () => {
  const outputs = resolve('outputs');
  await mkdir(outputs, { recursive: true });
  const temporary = await mkdtemp(join(outputs, 'input-benchmark-test-'));
  const preload = join(temporary, 'mock-fetch.mjs');
  await writeFile(preload, `
import { appendFile } from 'node:fs/promises';
const log = process.env.BIPLAN_TEST_FETCH_LOG;
globalThis.fetch = async (_url, init) => {
  await appendFile(log, 'call\\n');
  const request = JSON.parse(String(init.body));
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const options = Object.keys(question.criteria);
    const choice = id === 'coverage' && options.includes('complete') ? 'complete'
      : id === 'complete_plan' && options.includes('plan0') ? 'plan0'
      : id === 'audience_joint' && options.includes('keep+keep') ? 'keep+keep'
      : options[0];
    return [id, { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])) }];
  }));
  return new Response(JSON.stringify({ model: request.model, answers,
    usage: { input_tokens: Number(process.env.BIPLAN_TEST_INPUT_TOKENS ?? 1), output_tokens: 1 } }), {
    status: Number(process.env.BIPLAN_TEST_FETCH_STATUS ?? 200),
    headers: { 'Content-Type': 'application/json' },
  });
};
`);

  const run = async (
    maxCalls: number,
    options: { label?: string; caseIds?: string[]; tokens?: number; status?: number } = {},
  ) => {
    const label = options.label ?? `max-${maxCalls}`;
    const evidenceDir = join(temporary, label);
    const log = join(temporary, `calls-${label}.txt`);
    await mkdir(evidenceDir);
    const invocation = [
      '--import', pathToFileURL(preload).href,
      'scripts/check-input-intent.mjs', '--live',
      ...(options.caseIds ?? ['tr-basic-concert']).flatMap((id) => ['--case-id', id]),
      '--max-calls', String(maxCalls),
      '--pace-ms', '250',
      '--evidence-dir', evidenceDir,
    ];
    let processFailure = '';
    try {
      await execFileAsync(process.execPath, invocation, {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          TYPESAFE_API_KEY: 'test-only',
          BIPLAN_LIVE_REMAINING_INPUT_TOKENS: String(options.tokens ?? 128000),
          BIPLAN_TEST_FETCH_LOG: log,
          BIPLAN_TEST_FETCH_STATUS: String(options.status ?? 200),
          BIPLAN_TEST_INPUT_TOKENS: String(options.status === 429 ? 0 : 1),
        },
      });
    } catch (error) {
      // The synthetic choices deliberately need not satisfy the semantic fixture.
      assert.equal(typeof (error as { stdout?: unknown }).stdout, 'string');
      processFailure = `${(error as { stdout?: string }).stdout}\n${(error as { stderr?: string }).stderr}`;
    }
    const evidenceFiles = (await readdir(evidenceDir)).filter((name) => name.endsWith('.json'));
    assert.equal(evidenceFiles.length, 1, processFailure);
    const evidence = JSON.parse(await readFile(join(evidenceDir, evidenceFiles[0]), 'utf8'));
    const networkCalls = (await readFile(log, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    return { evidence, networkCalls };
  };

  try {
    const capped = await run(1);
    assert.equal(capped.networkCalls.length, 1);
    assert.equal(capped.evidence.records[0].calls.length, 1);
    assert.equal(capped.evidence.records[0].result.issue, 'interpreter_unavailable');

    const audited = await run(2);
    assert.equal(audited.evidence.schemaVersion, 2);
    assert.equal(audited.evidence.evidenceMode, 'audited-interpreter-flow');
    assert.equal(audited.networkCalls.length, 2);
    assert.equal(audited.evidence.records[0].calls.length, 2);
    for (const call of audited.evidence.records[0].calls) {
      assert.equal(call.responseStatus, 200);
      assert.deepEqual(call.usage, { input_tokens: 1, output_tokens: 1 });
      assert.equal(typeof call.latencyMs, 'number');
      assert.equal(call.request.headers.authorization, '[REDACTED]');
      assert.equal(call.response.model, 'jev-1.13.0');
    }

    const tamperedPath = join(temporary, 'tampered-replay.json');
    const tampered = structuredClone(audited.evidence);
    tampered.records[0].calls[0].request.url = 'https://example.invalid/tampered';
    await writeFile(tamperedPath, JSON.stringify(tampered));
    let replayOutput = '';
    try {
      await execFileAsync(
        process.execPath,
        ['scripts/check-input-intent.mjs', '--replay', tamperedPath],
        { cwd: process.cwd(), encoding: 'utf8' },
      );
      assert.fail('tampered replay must fail');
    } catch (error) {
      replayOutput = (error as { stdout?: string }).stdout ?? '';
    }
    const replay = JSON.parse(replayOutput);
    assert.equal(replay.status, 'fail');
    assert.equal(replay.mode, 'replay-audited-flow');
    assert.ok(
      replay.evaluations[0].mismatches.some((message: string) =>
        message.includes('does not match recorded evidence'),
      ),
    );

    const failed = await run(2, {
      label: 'failed-http-reservation',
      caseIds: ['tr-basic-concert', 'en-basic'],
      tokens: 64000,
      status: 429,
    });
    assert.equal(failed.networkCalls.length, 1);
    assert.equal(
      failed.evidence.records.flatMap((record: { calls: unknown[] }) => record.calls).length,
      1,
    );
    assert.equal(failed.evidence.records[0].calls[0].responseStatus, 429);
    assert.deepEqual(failed.evidence.records[0].calls[0].usage, {
      input_tokens: 0,
      output_tokens: 1,
    });
    assert.equal(failed.evidence.records[1].calls.length, 0);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
