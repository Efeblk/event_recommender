import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rollbackDeploymentMatches } from '../scripts/verify-rollback.mjs';

const requested = '00000000-0000-4000-8000-000000000001';

await test('accepts only the requested rollback version at 100 percent', () => {
  assert.equal(
    rollbackDeploymentMatches(
      { versions: [{ version_id: requested, percentage: 100 }] },
      requested,
    ),
    true,
  );
  assert.equal(
    rollbackDeploymentMatches(
      { versions: [{ version_id: requested.toUpperCase(), percentage: 100 }] },
      requested,
    ),
    true,
  );
});

await test('rejects stale, split, and malformed deployment status', () => {
  const other = '00000000-0000-4000-8000-000000000002';
  assert.equal(
    rollbackDeploymentMatches(
      { versions: [{ version_id: other, percentage: 100 }] },
      requested,
    ),
    false,
  );
  assert.equal(
    rollbackDeploymentMatches(
      {
        versions: [
          { version_id: requested, percentage: 90 },
          { version_id: other, percentage: 10 },
        ],
      },
      requested,
    ),
    false,
  );
  assert.equal(rollbackDeploymentMatches({}, requested), false);
});
