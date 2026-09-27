import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
