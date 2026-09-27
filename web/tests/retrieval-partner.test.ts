import assert from 'node:assert/strict';
import test from 'node:test';
import { shortlistEvents } from '../lib/retrieval.ts';
import type { IntentState } from '../lib/input-state.ts';
import type { EventRecord } from '../lib/types.ts';

const base: EventRecord = {
  id: 'base',
  title: 'Etkinlik',
  description: '',
  startsAt: '2026-10-03T17:00:00.000Z',
  checkedAt: '2026-09-28T08:00:00.000Z',
  venue: 'Sahne',
  city: 'İstanbul',
  district: 'Kadıköy',
  address: '',
  price: 400,
  currency: 'TRY',
  url: 'https://example.test/base',
  imageUrl: '',
  category: 'Tiyatro',
  availability: 'available',
};

const make = (id: string, patch: Partial<EventRecord>): EventRecord => ({
  ...base,
  id,
  url: `https://example.test/${id}`,
  canonicalProductionKey: `production-${id}`,
  ...patch,
});

function intent(requirements: IntentState['requirements'] = []): IntentState {
  return {
    version: 1,
    filters: {
      dateFrom: '2026-10-03',
      dateTo: '2026-10-03',
      maxPrice: null,
      category: null,
      excludedCategories: ['Konser'],
    },
    requirements,
    preferences: { mood: null, companion: 'partner', interests: [] },
  };
}

void test('partner lexical retrieval softly ranks adult programs ahead of sourced child programs', () => {
  const children = Array.from({ length: 20 }, (_, index) =>
    make(`child-${index}`, {
      title: `Erken Çocuk Oyunu ${index}`,
      description: 'Çocuklar için hazırlanan renkli tiyatro oyunu.',
      startsAt: `2026-10-03T${String(9 + Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 10).padStart(2, '0')}:00.000Z`,
    }),
  );
  const adults = Array.from({ length: 4 }, (_, index) =>
    make(`adult-${index}`, {
      title: `Yetişkin Sahne Oyunu ${index}`,
      description: 'İki yetişkinin ilişkisini anlatan çağdaş tiyatro oyunu.',
      startsAt: `2026-10-03T2${index}:00:00.000Z`,
    }),
  );

  const result = shortlistEvents(
    [...children, ...adults],
    'Sevgilimle bir etkinlik',
    [],
    16,
    undefined,
    intent(),
  );

  assert.equal(result.length, 16);
  assert.deepEqual(
    result.slice(0, adults.length).map(({ id }) => id),
    adults.map(({ id }) => id),
  );
  assert.ok(result.some(({ id }) => id.startsWith('child-')));
});

void test('an explicit child-audience requirement preserves normal lexical ranking', () => {
  const child = make('child-first', {
    title: 'Çocuk Oyunu',
    description: 'Çocuklar için hazırlanan tiyatro oyunu.',
    startsAt: '2026-10-03T09:00:00.000Z',
  });
  const adult = make('adult-later', {
    title: 'Çağdaş Oyun',
    description: 'Yetişkin oyuncuların sahnelediği tiyatro oyunu.',
    startsAt: '2026-10-03T20:00:00.000Z',
  });

  const result = shortlistEvents(
    [child, adult],
    'Çocuklarla tiyatro',
    [],
    2,
    undefined,
    intent([
      { kind: 'audience', value: 'children', policy: 'require_support' },
    ]),
  );

  assert.deepEqual(result.map(({ id }) => id), ['child-first', 'adult-later']);
});

void test('explicit source child-program forms demote, while all-ages ticket policy alone does not', () => {
  const titleEvidence = make('title-child', {
    title: 'Çocuk Stand-up',
    description: 'Her yaştan izleyici bilete tabidir.',
    startsAt: '2026-10-03T09:00:00.000Z',
  });
  const directAudience = make('direct-child', {
    title: 'Bilim Şov',
    description: 'Merhaba çocuklar! Minik seyircileri eğlenceye davet ediyoruz.',
    startsAt: '2026-10-03T10:00:00.000Z',
  });
  const allAgesOnly = make('all-ages-only', {
    title: 'İllüzyon Gösterisi',
    description: 'Her yaştan izleyici bilete tabidir.',
    startsAt: '2026-10-03T11:00:00.000Z',
  });

  const result = shortlistEvents(
    [titleEvidence, directAudience, allAgesOnly],
    'Sevgilimle bir etkinlik',
    [],
    3,
    undefined,
    intent(),
  );

  assert.deepEqual(result.map(({ id }) => id), [
    'all-ages-only',
    'title-child',
    'direct-child',
  ]);
});
