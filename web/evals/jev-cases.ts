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
export const evaluationCases: {
  id: string;
  message: string;
  filters: Filters;
  history: Message[];
  acceptableTop: string[];
}[] = [
  {
    id: 'acoustic',
    message: 'Elektronik müzik değil, akustik gitar dinlemek istiyorum.',
    acceptableTop: ['acoustic'],
  },
  {
    id: 'dance',
    message:
      'Oturup dinlemek istemiyorum, dans edebileceğim elektronik müzik arıyorum.',
    acceptableTop: ['electronic'],
  },
  {
    id: 'family',
    message:
      'Beş yaşındaki çocuğumla yaşına uygun bir gösteriye gitmek istiyorum.',
    acceptableTop: ['children'],
  },
  {
    id: 'comedy',
    message: 'Biraz gülmek istiyorum, yetişkinlere yönelik stand-up öner.',
    acceptableTop: ['comedy'],
  },
  {
    id: 'drama',
    message:
      'Komedi değil, aile ilişkileri üzerine dramatik bir tiyatro oyunu arıyorum.',
    acceptableTop: ['drama'],
  },
  {
    id: 'rock',
    message: 'Sesi yüksek, elektro gitar ve davul olan bir rock konseri.',
    acceptableTop: ['rock'],
  },
  {
    id: 'seated',
    message: 'Ayakta durmak istemiyorum. Oturmalı düzende caz dinleyelim.',
    acceptableTop: ['acoustic'],
  },
  {
    id: 'negation',
    message:
      'Çocuk oyunu istemiyorum, yetişkinlere uygun ciddi bir oyun olsun.',
    acceptableTop: ['drama'],
  },
  {
    id: 'budget',
    message: '500 TL altında akustik konser arıyorum.',
    filters: { ...emptyFilters, maxPrice: 500, category: 'Konser' as const },
    acceptableTop: ['acoustic'],
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
    acceptableTop: ['acoustic'],
  },
  {
    id: 'unsupported-romance',
    message: 'Kesin romantik ve kalabalık olmayan bir yer istiyorum.',
    acceptableTop: [],
  },
  {
    id: 'unsupported-access',
    message: 'Tekerlekli sandalye erişimi açıkça doğrulanmış bir gösteri.',
    acceptableTop: [],
  },
].map((item) => ({ filters: { ...emptyFilters }, history: [], ...item }));
