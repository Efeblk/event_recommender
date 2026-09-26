import test from 'node:test';
import assert from 'node:assert/strict';

import { isAlternativesRequest, isFullPreferenceReset } from '../lib/intent.ts';

await test('composite rejection wording requests different productions', () => {
  assert.equal(isAlternativesRequest('Bunlar olmadı, başka?'), true);
  assert.equal(isAlternativesRequest('Bunları olmadı, başka?'), true);
});

await test('explicit forget-everything resets respect negation', () => {
  assert.equal(
    isFullPreferenceReset('Her şeyi unut, yeniden başlayalım.'),
    true,
  );
  assert.equal(
    isFullPreferenceReset('Forget everything and start again.'),
    true,
  );
  assert.equal(isFullPreferenceReset('Her şeyi unutma.'), false);
  assert.equal(isFullPreferenceReset("Don't forget everything."), false);
  assert.equal(isFullPreferenceReset('Do not forget everything.'), false);
});
