import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJevRequest } from '../lib/jev.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';

const photoExhibition: EventRecord = {
  id: 'photo-exhibition',
  title: 'FotoÄŸraf Sergisi',
  description: 'FotoÄŸraf sanatÄ± ve belgesel fotoÄŸraf Ã§alÄ±ÅŸmalarÄ±ndan oluÅŸan sergi.',
  startsAt: '2026-10-03T15:00:00Z',
  checkedAt: '2026-09-30T09:00:00Z',
  venue: 'Galeri',
  city: 'Ä°stanbul',
  district: 'BeyoÄŸlu',
  address: '',
  price: 0,
  currency: 'TRY',
  category: 'Sergi',
  availability: 'available',
  imageUrl: '',
  url: 'https://example.test/photo-exhibition',
};

void test('ranking payload keeps a Turkish required topic separate from an optional format', () => {
  const body = buildJevRequest('jev-test', {
    message: 'FotoÄŸrafla ilgili bir ÅŸey arÄ±yorum, workshop olsa gÃ¼zel olur.',
    history: [],
    filters: emptyFilters,
    requirements: [],
    primaryTopics: ['FotoÄŸraf'],
    preferences: {
      mood: null,
      companion: null,
      interests: ['workshop'],
    },
  }, [photoExhibition]);

  assert.equal(body.state.request, 'FotoÄŸrafla ilgili bir ÅŸey arÄ±yorum, workshop olsa gÃ¼zel olur.');
  assert.deepEqual(body.state.rankingIntent, {
    requiredPrimaryTopics: ['FotoÄŸraf'],
    mandatoryRequirements: [],
    optionalPreferences: {
      mood: null,
      companion: null,
      interests: ['workshop'],
    },
  });
  assert.deepEqual(body.state.requiredPrimaryTopics, ['FotoÄŸraf']);
  assert.match(body.state.rankingPolicies.mandatorySupport, /Optional preferences never affect this judgment/);
  assert.match(body.questions.preference_0.instructions, /Do not add mandatory requirements/);
  assert.doesNotMatch(body.state.request, /must be about/i);
});

void test('ranking payload preserves an English correction without synthesizing a new request', () => {
  const body = buildJevRequest('jev-test', {
    message: 'Actually, photography is required; a workshop is only a preference.',
    history: [{ role: 'user', content: 'Find me a workshop.' }],
    filters: emptyFilters,
    primaryTopics: ['photography'],
    preferences: {
      mood: null,
      companion: null,
      interests: ['workshop'],
    },
  }, [photoExhibition]);

  assert.equal(body.state.request, 'Actually, photography is required; a workshop is only a preference.');
  assert.deepEqual(body.state.history, [{ role: 'user', content: 'Find me a workshop.' }]);
  const rankingIntent = body.state.rankingIntent;
  assert.ok(rankingIntent);
  assert.deepEqual(rankingIntent.requiredPrimaryTopics, ['photography']);
  assert.deepEqual(rankingIntent.optionalPreferences, {
    mood: null,
    companion: null,
    interests: ['workshop'],
  });
  assert.match(body.questions.candidate_0.instructions, /do not derive extra requirements/);
  assert.ok(body.questions.preference_0);
});

void test('optional interests stay outside mandatory requirements', () => {
  const body = buildJevRequest('jev-test', {
    message: 'Photography events, preferably an exhibition.',
    history: [],
    filters: emptyFilters,
    requirements: [],
    primaryTopics: ['photography'],
    preferences: {
      mood: null,
      companion: null,
      interests: ['exhibition'],
    },
  }, [photoExhibition]);

  const rankingIntent = body.state.rankingIntent;
  assert.ok(rankingIntent);
  assert.deepEqual(rankingIntent.mandatoryRequirements, []);
  assert.deepEqual(body.state.mandatoryRequirements, [
    { kind: 'primary_topic', value: 'photography', policy: 'require_source_program_support' },
  ]);
  assert.deepEqual(rankingIntent.optionalPreferences, {
    mood: null,
    companion: null,
    interests: ['exhibition'],
  });
  assert.equal(body.questions.preference_0.type, 'score');
});

void test('legacy requests keep their own semantic topic and mood authoritative', () => {
  const body = buildJevRequest('jev-test', {
    message: 'I want a calm photography outing.',
    history: [],
    filters: emptyFilters,
    requirements: [],
  }, [photoExhibition]);

  assert.equal('rankingIntent' in body.state, false);
  assert.match(body.questions.candidate_0.instructions, /outing requested in `request`/);
  assert.equal(body.questions.preference_0, undefined);
  assert.doesNotMatch(body.questions.candidate_0.instructions, /do not derive extra constraints/i);
});
