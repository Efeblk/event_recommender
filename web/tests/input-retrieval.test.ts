import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendationQuery, retrievalQuery } from '../lib/input-retrieval.ts';
import { EXPERIENCES } from '../lib/input-experiences.ts';
import { emptyIntentState, type IntentState } from '../lib/input-state.ts';
import { rankEvents } from '../lib/search.ts';
import type { EventRecord } from '../lib/types.ts';

const state = (patch: Partial<IntentState>): IntentState => ({
  ...emptyIntentState(),
  ...patch,
  filters: { ...emptyIntentState().filters, ...patch.filters },
  preferences: {
    ...emptyIntentState().preferences,
    ...patch.preferences,
  },
});

const event = (
  id: string,
  title: string,
  description: string,
  category = 'Konser',
): EventRecord => ({
  id,
  title,
  description,
  category,
  startsAt: '2026-10-03T17:00:00Z',
  checkedAt: '2026-09-28T10:00:00Z',
  venue: 'Test Sahne',
  city: 'İstanbul',
  district: 'Kadıköy',
  address: '',
  price: 500,
  currency: 'TRY',
  availability: 'available',
  imageUrl: '',
  url: `https://example.com/${id}`,
});

void test('writes bounded natural retrieval text and omits structured price and date', () => {
  const query = retrievalQuery(
    state({
      filters: {
        ...emptyIntentState().filters,
        dateFrom: '2026-10-03',
        dateTo: '2026-10-04',
        maxPrice: 750,
        category: 'Konser',
        district: 'Kadıköy',
      },
      requirements: [
        { kind: 'genre', value: 'jazz|blues', policy: 'require_support' },
        { kind: 'accessibility', value: 'step_free', policy: 'require_support' },
      ],
      preferences: {
        mood: 'calm',
        companion: 'partner',
        interests: ['Akustik Gitar'],
      },
    }),
  );

  assert.equal(
    query,
    'konser concert music Kadıköy jazz caz blues step-free wheelchair access basamaksız tekerlekli sandalye erişimi sakin rahat bir akşam planı partnerle birlikte bir etkinlik Akustik Gitar',
  );
  assert.ok(query.length <= 1200);
  assert.doesNotMatch(query, /category:|genre:|mood:|companion:|750|2026/);
  assert.doesNotMatch(query, /romantik|romantic|sessiz|quiet/);
});

void test('never retrieves prohibited or absence-only content', () => {
  const query = retrievalQuery(
    state({
      filters: {
        ...emptyIntentState().filters,
        excludedCategories: ['Stand-up'],
      },
      requirements: [
        { kind: 'genre', value: 'rock', policy: 'exclude_positive_evidence' },
        { kind: 'content', value: 'swearing|sexual_content', policy: 'require_support' },
      ],
      preferences: {
        mood: null,
        companion: null,
        interests: ['indie rock', 'Anadolu ezgileri'],
      },
    }),
  );

  assert.equal(query, 'Anadolu ezgileri');
  assert.doesNotMatch(query, /rock|swearing|sexual|Stand-up/i);
});

void test('natural bilingual activity terms improve offline lexical retrieval over old tags', () => {
  const intent = state({
    requirements: [
      { kind: 'activity', value: 'kayaking', policy: 'require_support' },
    ],
  });
  const fixtures = [
    event('concert', 'Yaz Konseri', 'Canlı müzik gecesi'),
    event('canoe', 'Boğazda Kano Turu', 'Rehber eşliğinde kürek çekme deneyimi', 'Spor'),
  ];

  // The former `activity:kayaking` text has no token match in this Turkish
  // fixture, so its ordering falls back to the earlier event date/input order.
  assert.equal(rankEvents(fixtures, 'activity:kayaking')[0].id, 'concert');
  assert.equal(rankEvents(fixtures, retrievalQuery(intent))[0].id, 'canoe');
});

void test('literal English interests survive exactly and missing vectors use lexical evidence', () => {
  const interest = 'Experimental chamber music';
  const query = retrievalQuery(
    state({ preferences: { mood: null, companion: 'friends', interests: [interest] } }),
  );
  const fixtures = [
    event('generic', 'City Night', 'A popular evening show'),
    event('chamber', 'New Sounds', 'Experimental chamber music ensemble'),
  ];

  assert.ok(query.endsWith(interest));
  assert.equal(rankEvents(fixtures, query, [1, 0], new Map())[0].id, 'chamber');
});

void test('fallback is deterministic and long interests stay within the hard bound', () => {
  assert.equal(
    retrievalQuery(emptyIntentState()),
    'İstanbul etkinlikleri Istanbul events',
  );
  const interests = Array.from({ length: 12 }, (_, index) =>
    `${index}-${'x'.repeat(76)}`,
  );
  const intent = state({
    preferences: { mood: 'energetic', companion: 'family', interests },
  });
  assert.equal(retrievalQuery(intent), retrievalQuery(intent));
  assert.ok(retrievalQuery(intent).length <= 1200);
});

void test('experience concepts expand search while ranking retains the actual desired experience', () => {
  const intent = state({
    preferences: { mood: null, companion: 'partner', interests: ['Molière'], experiences: ['laughter'] },
  });
  const before = structuredClone(intent);
  const query = retrievalQuery(intent);
  assert.ok(query.includes(EXPERIENCES.laughter.query));
  assert.ok(query.includes('Molière'));
  const rankQuery = recommendationQuery(intent);
  assert.ok(rankQuery.includes(EXPERIENCES.laughter.label));
  assert.ok(!rankQuery.includes(EXPERIENCES.laughter.query));
  assert.deepEqual(intent, before);
  assert.deepEqual(intent.requirements, []);
  assert.equal(intent.filters.category, null);

  const events = [
    event('generic', 'Bir Akşam', 'Canlı performans', 'Tiyatro'),
    event('humor', 'Yanlış Anlaşılma', 'Molière komedisi ve mizah dolu sahneler', 'Tiyatro'),
  ];
  assert.equal(rankEvents(events, query)[0].id, 'humor');
});

void test('experience expansions respect genre exclusions and never expand a literal title alone', () => {
  const intent = state({
    requirements: [{ kind: 'genre', value: 'comedy', policy: 'exclude_positive_evidence' }],
    preferences: { mood: null, companion: null, interests: [], experiences: ['laughter'] },
  });
  assert.doesNotMatch(retrievalQuery(intent), /comedy|komedi/iu);
  assert.ok(retrievalQuery(intent).includes(EXPERIENCES.laughter.label));

  const literal = state({ preferences: { mood: null, companion: null, interests: ['Dancing to Learn'] } });
  assert.equal(retrievalQuery(literal), 'Dancing to Learn');
  assert.equal(recommendationQuery(literal), 'Dancing to Learn');
});
