import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyManifestEntries } from '../scripts/deploy-artifact.mjs';

const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);

await test('accepts an exact compiled manifest', () => {
  assert.doesNotThrow(() =>
    verifyManifestEntries({ 'server/index.js': hashA }, { 'server/index.js': hashA }),
  );
});

await test('accepts identical entries in a different insertion order', () => {
  assert.doesNotThrow(() =>
    verifyManifestEntries(
      { 'server/index.js': hashA, 'client/.vite/manifest.json': hashB },
      { 'client/.vite/manifest.json': hashB, 'server/index.js': hashA },
    ),
  );
});

await test('rejects tampered, missing, and extra compiled files', () => {
  assert.throws(() =>
    verifyManifestEntries({ 'server/index.js': hashA }, { 'server/index.js': hashB }),
  );
  assert.throws(() =>
    verifyManifestEntries({ 'server/index.js': hashA }, {}),
  );
  assert.throws(() =>
    verifyManifestEntries(
      { 'server/index.js': hashA },
      { 'server/index.js': hashA, 'server/extra.js': hashB },
    ),
  );
});

await test('rejects unsafe and malformed manifest paths', () => {
  for (const name of ['../secret', '/absolute', 'server\\escape.js'])
    assert.throws(() => verifyManifestEntries({ [name]: hashA }, { [name]: hashA }), /unsafe/);
  assert.throws(() => verifyManifestEntries({}, {}), /unsafe/);
  assert.throws(() => verifyManifestEntries({ 'server/index.js': 'short' }, { 'server/index.js': 'short' }), /unsafe/);
});

await test('preserves path case when comparing manifests', () => {
  assert.throws(() =>
    verifyManifestEntries(
      { 'Server/index.js': hashA },
      { 'server/index.js': hashA },
    ),
  );
});
