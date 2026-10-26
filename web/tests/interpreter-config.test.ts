import assert from 'node:assert/strict';
import test from 'node:test';
import { inputInterpreterFrom, inputReaderFrom } from '../lib/interpreter-config.ts';

void test('span-v2 is the default when Jev is configured, rules otherwise', () => {
  assert.equal(inputInterpreterFrom({}, true), 'span-v2');
  assert.equal(inputInterpreterFrom({ INPUT_INTERPRETER: ' ' }, true), 'span-v2');
  assert.equal(inputInterpreterFrom({}, false), 'rules');
  assert.equal(inputInterpreterFrom({ INPUT_INTERPRETER: 'span-v2' }, false), 'rules');
  assert.equal(inputInterpreterFrom({ INPUT_INTERPRETER: 'rules' }, true), 'rules');
  assert.equal(inputInterpreterFrom({ INPUT_INTERPRETER: 'jev-v1' }, true), 'jev-v1');
  assert.throws(() => inputInterpreterFrom({ INPUT_INTERPRETER: 'span-v3' }, true));
});

void test('v3 is the default input reader; fields stays available', () => {
  assert.equal(inputReaderFrom({}), 'v3');
  assert.equal(inputReaderFrom({ INPUT_READER: ' ' }), 'v3');
  assert.equal(inputReaderFrom({ INPUT_READER: 'fields' }), 'fields');
  assert.equal(inputReaderFrom({ INPUT_READER: 'v3' }), 'v3');
  assert.throws(() => inputReaderFrom({ INPUT_READER: 'v4' }));
});
