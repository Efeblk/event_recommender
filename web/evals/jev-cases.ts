import {
  emptyFilters,
  type EventRecord,
  type Filters,
  type Message,
} from '../lib/types.ts';

// Fictional evaluation fixtures; never imported into the public event catalog.
export const evaluationTime = new Date('2026-09-22T09:00:00Z');
const base: EventRecord = {
  id: '',
  title: '',
  description: '',
  startsAt: '2026-09-26T17:00:00Z',
  checkedAt: evaluationTime.toISOString(),
  venue: 'Deneme Sahnesi',
  city: 'İstanbul',
  district: '',
  address: '',
  price: 500,
  currency: 'TRY',
  url: 'https://example.com/evaluation-only',
  imageUrl: '',
  category: 'Konser',
  availability: 'available',
};
export const evaluationEvents: EventRecord[] = [
  {
    ...base,
    id: 'acoustic',
    title: 'Akustik Üçlü',
    description:
      'Vokal, akustik gitar ve kontrbasla caz standartları. Oturmalı düzen. Amplifikasyonsuz akustik performans.',
  },
  {
    ...base,
    id: 'electronic',
    title: 'Gece Ritmi',
    price: 900,
    description:
      'Elektronik dans müziği ve techno DJ setleri. Ayakta dans alanı, yüksek sesli sahne sistemi. 18 yaş ve üzeri.',
  },
  {
    ...base,
    id: 'comedy',
    title: 'Gündelik Hayatlar',
    category: 'Stand-up',
    price: 400,
    description:
      'Gündelik hayata dair yetişkinlere yönelik stand-up gösterisi. 18 yaş sınırı.',
  },
  {
    ...base,
    id: 'children',
    title: 'Ormandaki Arkadaşlar',
    category: 'Tiyatro',
    price: 250,
    description:
      '4–8 yaş çocuklar ve aileleri için kukla tiyatrosu. Süre 45 dakika. Çocuklar yetişkin refakatinde katılır.',
  },
  {
    ...base,
    id: 'drama',
    title: 'Son Mektup',
    category: 'Tiyatro',
    price: 600,
    description:
      'Ayrılık, yas ve aile ilişkilerini ele alan dramatik yetişkin oyunu. Komedi değildir. 16 yaş üzeri.',
  },
  {
    ...base,
    id: 'rock',
    title: 'Gitar Gecesi',
    price: 700,
    description:
      'Elektro gitar, bas ve davulla rock konseri. Yüksek sesli, ayakta izlenen performans. 18 yaş üzeri.',
  },
  {
    ...base,
    id: 'unknown',
    title: 'Sürpriz Sahne',
    description: 'Program ayrıntıları henüz açıklanmadı.',
  },
].map((event) => ({
  ...event,
  url: `https://example.com/evaluation-only/${event.id}`,
}));
export interface JevEvaluationCase {
  id: string;
  message: string;
  filters: Filters;
  history: Message[];
  /** Every event that may safely appear anywhere in the recommendation list. */
  acceptableRecommendationIds: string[];
  /** Explicitly incorrect events, including incorrect secondary results. */
  forbiddenRecommendationIds: string[];
  expectedNoMatch: boolean;
}

const allEventIds = evaluationEvents.map(({ id }) => id);
const labeledCase = (
  item: Omit<
    JevEvaluationCase,
    'filters' | 'history' | 'forbiddenRecommendationIds' | 'expectedNoMatch'
  > &
    Partial<Pick<JevEvaluationCase, 'filters' | 'history'>>,
): JevEvaluationCase => ({
  filters: { ...emptyFilters },
  history: [],
  ...item,
  forbiddenRecommendationIds: allEventIds.filter(
    (id) => !item.acceptableRecommendationIds.includes(id),
  ),
  expectedNoMatch: item.acceptableRecommendationIds.length === 0,
});

// These twelve cases are the fixed live suite. Keep additions in a separate
// offline suite so --live can never exceed the established 12-call ceiling.
export const evaluationCases: JevEvaluationCase[] = [
  {
    id: 'acoustic',
    message: 'Elektronik müzik değil, akustik gitar dinlemek istiyorum.',
    acceptableRecommendationIds: ['acoustic'],
  },
  {
    id: 'dance',
    message:
      'Oturup dinlemek istemiyorum, dans edebileceğim elektronik müzik arıyorum.',
    acceptableRecommendationIds: ['electronic'],
  },
  {
    id: 'family',
    message:
      'Beş yaşındaki çocuğumla yaşına uygun bir gösteriye gitmek istiyorum.',
    acceptableRecommendationIds: ['children'],
  },
  {
    id: 'comedy',
    message: 'Biraz gülmek istiyorum, yetişkinlere yönelik stand-up öner.',
    acceptableRecommendationIds: ['comedy'],
  },
  {
    id: 'drama',
    message:
      'Komedi değil, aile ilişkileri üzerine dramatik bir tiyatro oyunu arıyorum.',
    acceptableRecommendationIds: ['drama'],
  },
  {
    id: 'rock',
    message: 'Sesi yüksek, elektro gitar ve davul olan bir rock konseri.',
    acceptableRecommendationIds: ['rock'],
  },
  {
    id: 'seated',
    message: 'Ayakta durmak istemiyorum. Oturmalı düzende caz dinleyelim.',
    acceptableRecommendationIds: ['acoustic'],
  },
  {
    id: 'negation',
    message:
      'Çocuk oyunu istemiyorum, yetişkinlere uygun ciddi bir oyun olsun.',
    acceptableRecommendationIds: ['drama'],
  },
  {
    id: 'budget',
    message: '500 TL altında akustik konser arıyorum.',
    filters: { ...emptyFilters, maxPrice: 500, category: 'Konser' as const },
    acceptableRecommendationIds: ['acoustic'],
  },
  {
    id: 'followup',
    message: 'Bunun yerine daha sakin ve oturmalı bir şey olsun.',
    history: [
      {
        role: 'user' as const,
        content: 'Yüksek sesli elektronik dans gecesi düşünüyordum.',
      },
    ],
    acceptableRecommendationIds: ['acoustic'],
  },
  {
    id: 'unsupported-romance',
    message: 'Kesin romantik ve kalabalık olmayan bir yer istiyorum.',
    acceptableRecommendationIds: [],
  },
  {
    id: 'unsupported-access',
    message: 'Tekerlekli sandalye erişimi açıkça doğrulanmış bir gösteri.',
    acceptableRecommendationIds: [],
  },
].map(labeledCase);
