import assert from 'node:assert/strict';
import test from 'node:test';
import { inputInterpreterFrom } from '../lib/interpreter-config.ts';

void test('span-v2 is the default when Jev is configured, rules otherwise', () => {
  assert.equal(inputInterpreterFrom({}, true), 'span-v2');
  assert.equal(inputInterpreterFrom({ INPUT_INTERPRETER: ' ' }, true), 'span-v2');
  assert.equal(inputInterpreterFrom({}, false), 'rules');
  assert.equal(inputInterpreterFrom({ INPUT_INTERPRETER: 'span-v2' }, false), 'rules');
  assert.equal(inputInterpreterFrom({ INPUT_INTERPRETER: 'rules' }, true), 'rules');
  assert.equal(inputInterpreterFrom({ INPUT_INTERPRETER: 'jev-v1' }, true), 'jev-v1');
  assert.throws(() => inputInterpreterFrom({ INPUT_INTERPRETER: 'span-v3' }, true));
});
