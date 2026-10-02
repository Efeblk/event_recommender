import assert from 'node:assert/strict';
import test from 'node:test';
import { primaryTopicRetrievalQuery, retrievalQuery } from '../lib/input-retrieval.ts';
import { buildInputCandidates } from '../lib/input-candidates.ts';
import { emptyIntentState } from '../lib/input-state.ts';
import { shortlistEvents } from '../lib/retrieval.ts';
import type { EventRecord } from '../lib/types.ts';

void test('extracts a meaningful photography source span without a sentence-framed duplicate', () => {
  const message = 'Fotoğrafla ilgili bir etkinlik arıyorum; workshop olsa güzel olur ama şart değil.';
  const values = buildInputCandidates(message, new Date('2026-09-30T09:00:00Z'), emptyIntentState())
    .interests.map(({ value }) => value);
  assert.ok(values.includes('Fotoğraf'));
  assert.ok(!values.includes('Fotoğrafla ilgili bir etkinlik arıyorum'));
  const explicit = buildInputCandidates('Fotoğraf ile ilgili bir etkinlik arıyorum', new Date('2026-09-30T09:00:00Z'), emptyIntentState());
  assert.ok(explicit.interests.some(({ value }) => value === 'Fotoğraf'));
});

void test('preserves opaque titles and topical OR while normalizing only retrieval framing', () => {
  const state = emptyIntentState();
  state.primaryTopics = ['Fotoğrafla ilgili bir etkinlik arıyorum', 'Seramik veya çini'];
  assert.equal(primaryTopicRetrievalQuery(state), 'Fotoğraf fotoğraf photography photographic Seramik veya çini');
  assert.match(retrievalQuery(state), /^Fotoğraf fotoğraf photography photographic Seramik veya çini/u);

  const quoted = buildInputCandidates('“Fotoğrafla İlgili Bir Gece” etkinliğini bul', new Date('2026-09-30T09:00:00Z'), emptyIntentState());
  assert.ok(quoted.interests.some(({ value }) => value === 'Fotoğrafla İlgili Bir Gece'));
  const orPool = buildInputCandidates('fotoğraf veya resim etkinliği arıyorum', new Date('2026-09-30T09:00:00Z'), emptyIntentState());
  assert.ok(orPool.interests.some(({ value }) => /fotoğraf veya resim/iu.test(value)));
});

void test('mandatory lexical topic coverage survives missing vectors and optional-format competition', () => {
  const base: EventRecord = {
    id: 'base', title: 'Program', description: 'Genel etkinlik', startsAt: '2026-10-01T10:00:00Z',
    venue: 'Mekan', city: 'İstanbul', district: '', address: '', price: 100, currency: 'TRY',
    url: 'https://example.test/base', imageUrl: '', category: 'Diğer', availability: 'available', checkedAt: '2026-09-30T09:00:00Z',
  };
  const events = [
    ...Array.from({ length: 20 }, (_, index) => ({ ...base, id: `dense-${index}`, title: `Workshop ${index}`, url: `https://example.test/dense-${index}` })),
    { ...base, id: 'photo', title: 'Fotoğraf Sergisi', description: 'Fotoğraf sanatına odaklanan sergi', url: 'https://example.test/photo' },
  ];
  const state = emptyIntentState();
  state.primaryTopics = ['fotoğraf'];
  state.preferences.interests = ['workshop'];
  const shortlist = shortlistEvents(events, retrievalQuery(state), [], 16, {
    queryVector: [1, 0], vectors: new Map(), denseOrder: events.slice(0, 20).map(({ id }) => id),
  }, state);
  assert.ok(shortlist.some(({ id }) => id === 'photo'));
});

void test('related-subject framing retains bilingual lexical coverage without changing typed intent', () => {
  const state = emptyIntentState();
  state.primaryTopics = ['photography-related'];
  state.preferences.interests = ['workshop'];
  assert.equal(primaryTopicRetrievalQuery(state), 'photography fotoğraf photography photographic');
  assert.deepEqual(state.primaryTopics, ['photography-related']);

  state.primaryTopics = ['Astronomiyle ilgili bir etkinlik arıyorum'];
  assert.equal(primaryTopicRetrievalQuery(state), 'Astronomi');
  state.primaryTopics = ['marine biology-related'];
  assert.equal(primaryTopicRetrievalQuery(state), 'marine biology');
});
