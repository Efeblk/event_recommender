import {
  CATEGORIES,
  emptyFilters,
  type EventRecord,
  type Filters,
  type Category,
} from './types.ts';
import {
  CATEGORY_NEGATION,
  isFullPreferenceReset,
  positiveCategoryText,
  requestedCategories,
} from './intent.ts';
export const normalize = (s: string) =>
  s
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
export function todayInIstanbul(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
export function addDays(day: string, count: number) {
  return new Date(Date.parse(day + 'T12:00:00Z') + count * 86400000)
    .toISOString()
    .slice(0, 10);
}
export function validDay(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(v)) &&
    new Date(v).toISOString().slice(0, 10) === v
  );
}
export function validateFilters(value: unknown): Filters {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Filtreler geçersiz.');
  const f = value as Record<string, unknown>;
  for (const key of ['dateFrom', 'dateTo'])
    if (f[key] != null && !validDay(f[key]))
      throw new Error('Tarih biçimi geçersiz.');
  if (
    f.maxPrice != null &&
    (typeof f.maxPrice !== 'number' ||
      !Number.isFinite(f.maxPrice) ||
      f.maxPrice < 0 ||
      f.maxPrice > 100000)
  )
    throw new Error('Bütçe 0–100.000 TL arasında olmalı.');
  if (f.category != null && !CATEGORIES.includes(f.category as never))
    throw new Error('Kategori geçersiz.');
  if (
    f.categories != null &&
    (!Array.isArray(f.categories) ||
      !f.categories.length ||
      f.categories.some((category) => !CATEGORIES.includes(category as never)))
  )
    throw new Error('Kategoriler geçersiz.');
  if (
    f.excludedCategories != null &&
    (!Array.isArray(f.excludedCategories) ||
      f.excludedCategories.some(
        (category) => !CATEGORIES.includes(category as never),
      ))
  )
    throw new Error('Hariç tutulan kategori geçersiz.');
  const result = {
    ...emptyFilters,
    ...Object.fromEntries(
      Object.keys(emptyFilters).map((k) => [k, f[k] ?? null]),
    ),
  } as Filters;
  if (typeof f.district === 'string' && f.district.trim())
    result.district = f.district.trim().slice(0, 80);
  else if (f.district != null) throw new Error('İlçe geçersiz.');
  for (const key of ['startTimeFrom', 'startTimeTo'] as const) {
    if (
      f[key] != null &&
      (typeof f[key] !== 'string' ||
        !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(f[key]))
    )
      throw new Error('Saat biçimi geçersiz.');
    if (typeof f[key] === 'string') result[key] = f[key];
  }
  for (const key of [
    'startTimeFromExclusive',
    'startTimeToExclusive',
  ] as const) {
    if (f[key] != null && typeof f[key] !== 'boolean')
      throw new Error('Kesinlik alanı geçersiz.');
    if (typeof f[key] === 'boolean') result[key] = f[key];
  }
  if (Array.isArray(f.categories)) {
    result.categories = [...new Set(f.categories as Category[])];
    result.category = null;
  }
  const exclusions = [
    ...new Set((f.excludedCategories as Category[] | undefined) ?? []),
  ].filter((category) => category !== result.category);
  if (exclusions.length) result.excludedCategories = exclusions;
  if (result.dateFrom && result.dateTo && result.dateFrom > result.dateTo)
    throw new Error('Bitiş tarihi başlangıçtan önce olamaz.');
  return result;
}

export type ConstraintIssue =
  | 'budget_ambiguous'
  | 'date_ambiguous'
  | 'unsupported_location'
  | 'constraint_ambiguous';

const categoryTerms: Array<[Category, RegExp, RegExp]> = [
  ['Stand-up', /\b(?:stand[ -]?up)\b/, /\b(?:stand[ -]?up|komedi|comedy)\b/],
  [
    'Tiyatro',
    /\b(?:tiyatro|sahne oyunu|komedi oyunu|comedy play|theatre|theater)\b/,
    /\b(?:tiyatro|sahne oyunu|theatre|theater)\b/,
  ],
  [
    'Konser',
    /\b(?:konser|concert|music|muzik|caz|jazz|rock|akustik)\b/,
    /\b(?:konser|concerts?)\b/,
  ],
];

function parseCategories(q: string, previous: Filters) {
  let category = previous.category;
  const excluded = new Set(previous.excludedCategories ?? []);
  if (
    /her (?:tur|kategori)|kategori.*(?:kaldir|fark etmez|onemli degil)/.test(q)
  )
    return {
      category: null,
      excludedCategories: [] as Category[],
      ambiguous: false,
    };

  const negated = new Set<Category>();
  const clauses = q.split(/\b(?:ama|fakat|ancak|but)\b/);
  for (const [candidate, , exclusionTerms] of categoryTerms) {
    const suffix = CATEGORY_NEGATION;
    const hardNegation = new RegExp(
      `(${exclusionTerms.source})[^,.!?;]{0,60}\\s+${suffix}`,
      'g',
    );
    if (clauses.some((clause) => hardNegation.test(clause)))
      negated.add(candidate);
    const englishNegation = new RegExp(
      `\\b(?:no|without|excluding?|except)\\s+(?:any\\s+)?${exclusionTerms.source}`,
      'g',
    );
    if (clauses.some((clause) => englishNegation.test(clause)))
      negated.add(candidate);
  }
  for (const candidate of negated) {
    excluded.add(candidate);
    if (category === candidate) category = null;
  }
  const positiveText = positiveCategoryText(q);
  const distinct = requestedCategories(positiveText);
  const hasChoice = /\b(?:veya|ya da|yahut|or)\b/.test(positiveText);
  if (distinct.length === 1) {
    category = distinct[0];
    excluded.delete(category);
    if (
      new RegExp(
        `\\b(?:sadece|yalniz)\\s+${categoryTerms.find(([c]) => c === category)![1].source}`,
      ).test(positiveText)
    )
      excluded.clear();
  }
  return {
    category,
    categories: distinct.length > 1 && hasChoice ? distinct : undefined,
    excludedCategories: [...excluded],
    ambiguous: distinct.length > 1 && !hasChoice && !negated.size,
  };
}

function budgetIssue(q: string): ConstraintIssue | null {
  const freeWaived =
    /(?:ucretsiz|bedava)[^.!?]{0,32}(?:sart degil|zorunlu degil|gerekli degil)/.test(
      q,
    );
  if (
    /butce(?:yi)?.*(?:yok|sinir.*yok|kaldir|bosver)|fiyat.*(?:onemli degil|fark etmez)|(?:no budget limit|without a budget limit)|butcesiz/.test(
      q,
    ) ||
    (!freeWaived && /ucretsiz|bedava/.test(q))
  )
    return null;
  if (/\bbutce(?:m|miz)?\s*-\s*\d/.test(q)) return 'budget_ambiguous';
  const currencyAmounts = [
    ...q.matchAll(
      /(?:₺\s*\d[\d.,]*|\d[\d.,]*\s*(?:tl|try|turkish liras?|lira|₺))(?=\s|$|[.,!?])/g,
    ),
  ];
  const bareBudget = q.match(/\bbutce(?:m|miz)?\s*(\d[\d.]*(?:,\d{1,2})?)/);
  const amounts = currencyAmounts.length
    ? currencyAmounts.map((match) => match[0])
    : bareBudget
      ? [bareBudget[1]]
      : [];
  if (
    !amounts.length &&
    partySize(q) !== null &&
    /\b(?:toplam(?=\b|\d)|toplamda\b|total\b|altogether\b)/.test(q) &&
    /\b(?:ayni|same)\b/.test(q)
  )
    return 'budget_ambiguous';
  if (amounts.length > 1) return 'budget_ambiguous';
  if (!amounts.length) return null;
  const amount = Number(
    amounts[0]
      .replace(/^₺\s*/, '')
      .replace(/\s*(?:tl|try|turkish liras?|lira|₺).*$/, '')
      .replaceAll('.', '')
      .replace(',', '.'),
  );
  if (!Number.isFinite(amount) || amount < 0 || amount > 100000)
    return 'budget_ambiguous';
  if (/-\s*\d[\d.]*(?:,\d{1,2})?\s*(?:tl|lira|₺)/.test(q))
    return 'budget_ambiguous';
  const total =
    /\b(?:toplam(?=\b|\d)|toplamda\b|butun grup\b|hepimiz icin\b|total\b|altogether\b|for (?:the )?(?:whole )?group\b)/.test(
      q,
    );
  const perPerson = /\b(?:kisi basi|per[ -]?person|each|per ticket)\b/.test(q);
  const hasParty = partySize(q) !== null;
  if (total && perPerson) return 'budget_ambiguous';
  if (total) return hasParty ? null : 'budget_ambiguous';
  if (hasParty && !perPerson) return 'budget_ambiguous';
  return null;
}

function partySize(q: string): number | null {
  const groupPronoun = q.match(/\b(ikimiz|ucumuz|dordumuz|both of us)\b/);
  if (groupPronoun) {
    const values: Record<string, number> = {
      ikimiz: 2,
      ucumuz: 3,
      dordumuz: 4,
      'both of us': 2,
    };
    return values[groupPronoun[1]] ?? null;
  }
  const numeric = q.match(
    /\b([1-9]\d?)\s*(?:kisi(?:yiz|lik)?|people|persons?|of us)\b/,
  );
  if (numeric) return Number(numeric[1]);
  const word = q.match(
    /\b(bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:kisi(?:yiz|lik)?|people|persons?|of us)\b/,
  );
  if (!word) return null;
  const values: Record<string, number> = {
    bir: 1,
    iki: 2,
    uc: 3,
    dort: 4,
    bes: 5,
    alti: 6,
    yedi: 7,
    sekiz: 8,
    dokuz: 9,
    on: 10,
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  return values[word[1]] ?? null;
}

const ISTANBUL_DISTRICTS = [
  'adalar',
  'arnavutkoy',
  'atasehir',
  'avcilar',
  'bagcilar',
  'bahcelievler',
  'bakirkoy',
  'basaksehir',
  'bayrampasa',
  'besiktas',
  'beykoz',
  'beylikduzu',
  'beyoglu',
  'buyukcekmece',
  'catalca',
  'cekmekoy',
  'esenler',
  'esenyurt',
  'eyupsultan',
  'fatih',
  'gaziosmanpasa',
  'gungoren',
  'kadikoy',
  'kagithane',
  'kartal',
  'kucukcekmece',
  'maltepe',
  'pendik',
  'sancaktepe',
  'sariyer',
  'silivri',
  'sultanbeyli',
  'sultangazi',
  'sile',
  'sisli',
  'tuzla',
  'umraniye',
  'uskudar',
  'zeytinburnu',
] as const;

const displayDistrict = (district: string) =>
  district.replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase('tr-TR'));

function parsedDistrict(q: string): {
  district?: string;
  ambiguous: boolean;
  negativeOnly: boolean;
} {
  let hasNegative = false;
  const positive = ISTANBUL_DISTRICTS.filter((name) => {
    const matches = [
      ...q.matchAll(
        new RegExp(
          `\\b${name}(?=\\b|['’]?(?:da|de|ta|te|dan|den|tan|ten)\\b)`,
          'g',
        ),
      ),
    ];
    return matches.some((match) => {
      const index = match.index ?? 0;
      const after = q.slice(
        index + match[0].length,
        index + match[0].length + 32,
      );
      const negated =
        /^(?:['’]?[a-z]{0,8})?\s*(?:degil|olmasin|haric|disinda|istemiyorum|istemem)\b/.test(
          after,
        );
      if (negated) hasNegative = true;
      return !negated;
    });
  });
  return {
    district: positive.length === 1 ? displayDistrict(positive[0]) : undefined,
    ambiguous: positive.length > 1,
    negativeOnly: hasNegative && positive.length === 0,
  };
}

const localClock = '(?:[01]?\\d|2[0-3])(?:[:.]?[0-5]\\d)';

function withoutRecognizedLocalTimes(q: string): string {
  return [
    new RegExp(
      `\\b(?:saat\\s*)?${localClock}['’]?(?:dan|den|tan|ten)\\s+(?:sonra|once)\\b`,
      'g',
    ),
    new RegExp(
      `\\b(?:after|before|once|until|by|sonra|itibaren|from)\\s+(?:saat\\s*)?${localClock}\\b`,
      'g',
    ),
  ].reduce((text, pattern) => text.replace(pattern, ' '), q);
}

function parseLocalTimes(q: string) {
  const result: Pick<
    Filters,
    | 'startTimeFrom'
    | 'startTimeTo'
    | 'startTimeFromExclusive'
    | 'startTimeToExclusive'
  > = {};
  const format = (raw: string) => {
    const digits = raw.replace('.', ':');
    if (/^\d{1,2}$/.test(digits)) return `${digits.padStart(2, '0')}:00`;
    if (digits.includes(':')) {
      const [hour, minute] = digits.split(':');
      return `${hour.padStart(2, '0')}:${minute}`;
    }
    return `${digits.slice(0, -2).padStart(2, '0')}:${digits.slice(-2)}`;
  };
  const from = q.match(
    new RegExp(
      `\\b(after|sonra|itibaren|from)\\s+(?:saat\\s*)?(${localClock})\\b`,
    ),
  );
  const fromPrefix = q.match(
    new RegExp(
      `\\b(?:saat\\s*)?(${localClock})['’]?(?:dan|den|tan|ten)\\s+sonra\\b`,
    ),
  );
  const eveningFromPrefix = q.match(
    /\baksam\s+([1-9]|1[01])['’]?(?:dan|den|tan|ten)\s+sonra\b/,
  );
  const to = q.match(
    new RegExp(`\\b(before|once|until|by)\\s+(?:saat\\s*)?(${localClock})\\b`),
  );
  const toPrefix = q.match(
    new RegExp(
      `\\b(?:saat\\s*)?(${localClock})['’]?(?:dan|den|tan|ten)\\s+once\\b`,
    ),
  );
  const chosenFromPrefix =
    eveningFromPrefix && (!fromPrefix || eveningFromPrefix.index! <= fromPrefix.index!)
      ? eveningFromPrefix
      : fromPrefix;
  const fromUsesPrefix =
    !!chosenFromPrefix && (!from || chosenFromPrefix.index! <= from.index!);
  const toUsesPrefix = !!toPrefix && (!to || toPrefix.index! <= to.index!);
  let fromMatch = fromUsesPrefix ? chosenFromPrefix![1] : from?.[2];
  if (fromUsesPrefix && chosenFromPrefix === eveningFromPrefix)
    fromMatch = String(Number(fromMatch) + 12);
  const toMatch = toUsesPrefix ? toPrefix[1] : to?.[2];
  if (fromMatch) {
    result.startTimeFrom = format(fromMatch);
    result.startTimeFromExclusive =
      fromUsesPrefix || /\b(?:after|sonra)\b/.test(from![1]);
  }
  if (toMatch) {
    result.startTimeTo = format(toMatch);
    result.startTimeToExclusive =
      toUsesPrefix || /\b(?:before|once)\b/.test(to![1]);
  }
  return result;
}

function unsupportedLocation(q: string) {
  const cities = [
    'adana',
    'adiyaman',
    'afyon',
    'afyonkarahisar',
    'agri',
    'aksaray',
    'amasya',
    'ankara',
    'antalya',
    'ardahan',
    'artvin',
    'aydin',
    'balikesir',
    'bartin',
    'batman',
    'bayburt',
    'bilecik',
    'bingol',
    'bitlis',
    'bolu',
    'burdur',
    'bursa',
    'canakkale',
    'cankiri',
    'corum',
    'denizli',
    'diyarbakir',
    'duzce',
    'edirne',
    'elazig',
    'erzincan',
    'erzurum',
    'eskisehir',
    'gaziantep',
    'giresun',
    'gumushane',
    'hakkari',
    'hatay',
    'igdir',
    'isparta',
    'izmir',
    'kahramanmaras',
    'karabuk',
    'karaman',
    'kars',
    'kastamonu',
    'kayseri',
    'kilis',
    'kirikkale',
    'kirklareli',
    'kirsehir',
    'kocaeli',
    'konya',
    'kutahya',
    'malatya',
    'manisa',
    'maras',
    'mardin',
    'mersin',
    'mugla',
    'mus',
    'nevsehir',
    'nigde',
    'ordu',
    'osmaniye',
    'rize',
    'sakarya',
    'samsun',
    'siirt',
    'sinop',
    'sivas',
    'sanliurfa',
    'sirnak',
    'tekirdag',
    'tokat',
    'trabzon',
    'tunceli',
    'urfa',
    'usak',
    'van',
    'yalova',
    'yozgat',
    'zonguldak',
  ];
  return cities.some((city) => {
    const matches = [...q.matchAll(new RegExp(`\\b${city}\\b`, 'g'))];
    return matches.some((match) => {
      const index = match.index ?? 0;
      const after = q.slice(
        index + match[0].length,
        index + match[0].length + 24,
      );
      const before = q.slice(Math.max(0, index - 14), index);
      if (city === 'van' && /^\s+gogh\b/.test(after)) return false;
      return (
        !/^(?:['’]?[a-z]{0,5})?\s*(?:degil|haric|disinda|istemiyorum)\b/.test(
          after,
        ) && !/(?:degil|haric|disinda)\s*$/.test(before)
      );
    });
  });
}

const recognizedDateToken =
  '(?:yarin|tomorrow|bugun|today|tonight|pazartesi|monday|sali|tuesday|carsamba|wednesday|persembe|thursday|cuma|friday|cumartesi|saturday|pazar|sunday)';

function maskNegatedRecognizedDates(q: string) {
  let hadNegatedDate = false;
  const mask = (_match: string) => {
    hadNegatedDate = true;
    return ' ';
  };
  const text = q
    .replace(new RegExp(`\\bnot\\s+${recognizedDateToken}\\b`, 'g'), mask)
    .replace(
      new RegExp(`\\b${recognizedDateToken}\\s+(?:degil|not)\\b`, 'g'),
      mask,
    );
  return { text, hadNegatedDate };
}

function hasRecognizedDate(q: string) {
  return new RegExp(`\\b${recognizedDateToken}\\b`).test(q) ||
    /hafta sonu|haftasonu|\\b(?:this )?weekend\\b/.test(q);
}

function hasAmbiguousBareHourBound(q: string) {
  const matches = [
    ...q.matchAll(
      /\b(?:saat\s*)?(?:[1-9]|1[0-2])['’]?(?:dan|den|tan|ten)\s+(?:sonra|once)\b/g,
    ),
  ];
  return matches.some((match) => {
    const before = q.slice(Math.max(0, (match.index ?? 0) - 12), match.index);
    return !/\baksam\s*$/.test(before);
  });
}

function dateIssue(q: string, previous: Filters): ConstraintIssue | null {
  q = withoutRecognizedLocalTimes(q);
  const negatedDates = maskNegatedRecognizedDates(q);
  q = negatedDates.text;
  const iso = [...q.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map((m) => m[0]);
  if (iso.length)
    return iso.length <= 2 && iso.every(validDay) ? null : 'date_ambiguous';
  if (/\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/.test(q)) return 'date_ambiguous';
  if (
    /\b\d{1,2}\s+(?:ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)\b/.test(
      q,
    )
  )
    return 'date_ambiguous';
  if (/\bgelecek hafta\b/.test(q)) return 'date_ambiguous';
  if (negatedDates.hadNegatedDate && !hasRecognizedDate(q))
    return 'date_ambiguous';
  const sameDate =
    /\b(?:ayni (?:tarih(?:te)?|gun(?:de)?)|same (?:date|day))\b/g;
  if (sameDate.test(q)) {
    if (!previous.dateFrom && !previous.dateTo) return 'date_ambiguous';
    q = q.replace(sameDate, ' ');
  }
  const dateSalient =
    /\b(?:tarih|gun|hafta|haftasonu|ay|ayin|bugun|yarin|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\b/.test(
      q,
    ) || /\bbu aksam\b/.test(q);
  if (!dateSalient) return null;
  if (
    /tarih.*(?:fark etmez|kaldir)|herhangi bir gun|any date (?:is )?fine/.test(q)
  )
    return null;
  const supported =
    /\b(?:bugun|bu aksam|yarin|hafta sonu|haftasonu|bu hafta|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\b/.test(
      q,
    );
  return supported ? null : 'date_ambiguous';
}
export function parseFilters(
  message: string,
  previous: Filters = emptyFilters,
  now = new Date(),
): Filters {
  const q = normalize(message);
  const positiveDateText = maskNegatedRecognizedDates(q).text;
  const f = { ...previous };
  const today = todayInIstanbul(now);
  if (
    /butce(?:yi)?.*(yok|sinir.*yok|kaldir|bosver)|fiyat.*(onemli degil|fark etmez)|no budget limit|without a budget limit|butcesiz/.test(
      q,
    )
  )
    f.maxPrice = null;
  else {
    const prefixedMoney = q.match(/₺\s*(\d[\d.]*(?:,\d{1,2})?)/);
    const suffixedMoney = q.match(
      /(\d[\d.]*(?:,\d{1,2})?)\s*(?:tl|try|turkish liras?|₺|lira)/,
    );
    const money =
      prefixedMoney ||
      suffixedMoney ||
      q.match(/butce(?:m|miz)?(?:\s+de)?\s*(\d[\d.]*)/);
    if (money) {
      let amount = Number(money[1].replaceAll('.', '').replace(',', '.'));
      if (
        /\b(?:toplam(?=\b|\d)|toplamda\b|butun grup\b|hepimiz icin\b|total\b|altogether\b|for (?:the )?(?:whole )?group\b)/.test(
          q,
        )
      ) {
        const size = partySize(q);
        if (size) amount /= size;
      }
      f.maxPrice = amount;
    }
    if (
      /ucretsiz|bedava/.test(q) &&
      !/(?:ucretsiz|bedava)[^.!?]{0,32}(?:sart degil|zorunlu degil|gerekli degil)/.test(
        q,
      )
    )
      f.maxPrice = 0;
  }
  const parsedCategories = parseCategories(q, f);
  f.category = parsedCategories.category;
  f.excludedCategories = parsedCategories.excludedCategories;
  if (parsedCategories.categories) f.categories = parsedCategories.categories;
  else if (parsedCategories.category) delete f.categories;
  else if (
    /her (?:tur|kategori)|kategori.*(?:kaldir|fark etmez|onemli degil)/.test(q)
  )
    delete f.categories;
  if (
    /\b(?:konum|ilce|district|location).*(?:fark etmez|onemli degil|kaldir|anywhere)\b|\banywhere in istanbul\b/.test(
      q,
    )
  ) {
    delete f.district;
  } else {
    const parsed = parsedDistrict(q);
    if (parsed.ambiguous) throw new Error('İlçe seçimi belirsiz.');
    if (parsed.district) f.district = parsed.district;
  }
  if (/\b(?:saat|time).*(?:fark etmez|onemli degil|kaldir|anytime)\b/.test(q)) {
    delete f.startTimeFrom;
    delete f.startTimeTo;
    delete f.startTimeFromExclusive;
    delete f.startTimeToExclusive;
  } else Object.assign(f, parseLocalTimes(q));
  if (
    /tarih.*(fark etmez|kaldir)|herhangi bir gun|any date (?:is )?fine/.test(q)
  ) {
    f.dateFrom = null;
    f.dateTo = null;
  } else if (/\b(?:yarin|tomorrow)\b/.test(positiveDateText)) {
    f.dateFrom = addDays(today, 1);
    f.dateTo = f.dateFrom;
  } else if (/\b(?:bugun|bu aksam|today|tonight)\b/.test(positiveDateText)) {
    f.dateFrom = today;
    f.dateTo = today;
  } else if (
    /hafta sonu|haftasonu|\b(?:this )?weekend\b/.test(positiveDateText)
  ) {
    const day = new Date(today + 'T12:00:00Z').getUTCDay();
    const delta = day === 0 ? 0 : (6 - day + 7) % 7;
    f.dateFrom = addDays(today, delta);
    f.dateTo = addDays(f.dateFrom, day === 0 ? 0 : 1);
    if (/gelecek|onumuzdeki/.test(q) && day >= 6) {
      f.dateFrom = addDays(today, (6 - day + 7) % 7 || 7);
      f.dateTo = addDays(f.dateFrom, 1);
    }
  } else if (/bu hafta/.test(q)) {
    const day = new Date(today + 'T12:00:00Z').getUTCDay();
    f.dateFrom = today;
    f.dateTo = addDays(today, (7 - day) % 7);
  } else {
    const iso = q.match(/\b(\d{4}-\d{2}-\d{2})\b/g);
    if (iso?.length && iso.every(validDay)) {
      f.dateFrom = iso[0];
      f.dateTo = iso[1] || iso[0];
    } else {
      const weekdays = [
        '(?:pazar|sunday)',
        '(?:pazartesi|monday)',
        '(?:sali|tuesday)',
        '(?:carsamba|wednesday)',
        '(?:persembe|thursday)',
        '(?:cuma|friday)',
        '(?:cumartesi|saturday)',
      ];
      const found = weekdays.findIndex((d) =>
        new RegExp(`\\b${d}\\b`).test(positiveDateText),
      );
      if (found >= 0) {
        f.dateFrom = addDays(
          today,
          (found - new Date(today + 'T12:00:00Z').getUTCDay() + 7) % 7,
        );
        f.dateTo = f.dateFrom;
      }
    }
  }
  return validateFilters(f);
}

export function interpretConstraints(
  message: string,
  previous: Filters = emptyFilters,
  now = new Date(),
): { filters: Filters; issue: ConstraintIssue | null } {
  const q = normalize(message);
  const previousFilters = isFullPreferenceReset(message)
    ? emptyFilters
    : validateFilters(previous);
  const category = parseCategories(q, previousFilters);
  const district = parsedDistrict(q);
  let issue: ConstraintIssue | null = null;
  if (unsupportedLocation(q)) issue = 'unsupported_location';
  else if (budgetIssue(q)) issue = 'budget_ambiguous';
  else if (hasAmbiguousBareHourBound(q)) issue = 'constraint_ambiguous';
  else if (dateIssue(q, previousFilters)) issue = 'date_ambiguous';
  else if (district.negativeOnly) issue = 'constraint_ambiguous';
  else if (district.ambiguous) issue = 'constraint_ambiguous';
  else if (category.ambiguous) issue = 'constraint_ambiguous';
  if (issue) return { filters: previousFilters, issue };
  try {
    const filters = parseFilters(message, previousFilters, now);
    if (
      filters.startTimeFrom &&
      filters.startTimeTo &&
      (filters.startTimeFrom > filters.startTimeTo ||
        (filters.startTimeFrom === filters.startTimeTo &&
          (filters.startTimeFromExclusive || filters.startTimeToExclusive)))
    )
      return { filters: previousFilters, issue: 'constraint_ambiguous' };
    return { filters, issue: null };
  } catch {
    const dateLike =
      /\b(?:tarih|gun|hafta|ay|bugun|yarin|pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\b/.test(
        q,
      ) || /\b\d{4}-\d{2}-\d{2}\b/.test(q);
    const budgetLike = /\b(?:butce|fiyat|tl|lira|ucretsiz|bedava)\b|₺/.test(q);
    return {
      filters: previousFilters,
      issue: dateLike
        ? 'date_ambiguous'
        : budgetLike
          ? 'budget_ambiguous'
          : 'constraint_ambiguous',
    };
  }
}
export function isEligible(
  e: EventRecord,
  f: Filters,
  now = new Date(),
): boolean {
  const start = Date.parse(e.startsAt),
    checked = Date.parse(e.checkedAt);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(checked) ||
    start < now.getTime() ||
    checked < now.getTime() - 72 * 3600000 ||
    checked > now.getTime() + 300000 ||
    e.city !== 'İstanbul' ||
    e.availability !== 'available'
  )
    return false;
  const day = todayInIstanbul(new Date(start));
  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(start));
  const eventDistrict = normalize(e.district);
  const requestedDistrict = f.district ? normalize(f.district) : null;
  const hasSpecificDistrict = (
    ISTANBUL_DISTRICTS as readonly string[]
  ).includes(eventDistrict);
  const normalizedAddress = normalize(e.address);
  const addressDistricts = ISTANBUL_DISTRICTS.filter((district) =>
    new RegExp(`\\b${district}\\b\\s*(?:(?:/|,)\\s*istanbul\\b|$)`).test(
      normalizedAddress,
    ),
  );
  const addressDistrict =
    addressDistricts.length === 1 ? addressDistricts[0] : null;
  const hasDistrictConflict =
    hasSpecificDistrict &&
    addressDistrict !== null &&
    addressDistrict !== eventDistrict;
  const venueEvidence = normalize(e.venue);
  const districtMatches =
    !requestedDistrict ||
    (!hasDistrictConflict &&
      (eventDistrict === requestedDistrict ||
        (!hasSpecificDistrict &&
          (addressDistrict
            ? addressDistrict === requestedDistrict
            : new RegExp(`\\b${requestedDistrict}\\b`).test(venueEvidence)))));
  const afterFrom =
    !f.startTimeFrom ||
    (f.startTimeFromExclusive
      ? localTime > f.startTimeFrom
      : localTime >= f.startTimeFrom);
  const beforeTo =
    !f.startTimeTo ||
    (f.startTimeToExclusive
      ? localTime < f.startTimeTo
      : localTime <= f.startTimeTo);
  return (
    (!f.dateFrom || day >= f.dateFrom) &&
    (!f.dateTo || day <= f.dateTo) &&
    districtMatches &&
    afterFrom &&
    beforeTo &&
    (!f.category || e.category === f.category) &&
    (!f.categories || f.categories.includes(e.category as Category)) &&
    !(f.excludedCategories ?? []).includes(e.category as Category) &&
    (f.maxPrice === null ||
      (e.price !== null && e.currency === 'TRY' && e.price <= f.maxPrice))
  );
}
export function cosine(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
const stop = new Set([
  'bir',
  'biraz',
  'icin',
  'olsun',
  'bana',
  'gore',
  'olan',
  'var',
  'neler',
  'ne',
  'bu',
  've',
  'ile',
  'etkinlik',
  'istiyorum',
  'plan',
  'daha',
  'tl',
  'lira',
  'hafta',
  'sonu',
]);
export function rankEvents(
  events: EventRecord[],
  query: string,
  queryVector: number[] | null = null,
  vectors = new Map<string, number[]>(),
) {
  const tokens = normalize(query)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !stop.has(t));
  return events
    .map((e) => {
      const text = normalize(
        e.title + ' ' + e.description + ' ' + e.venue + ' ' + e.category,
      );
      const lexical =
        tokens.reduce((sum, t) => sum + (text.includes(t) ? 1 : 0), 0) /
        Math.max(tokens.length, 1);
      const vector = vectors.get(e.id);
      return {
        event: e,
        score:
          lexical * 0.35 +
          (queryVector && vector ? cosine(queryVector, vector) * 0.65 : 0),
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score || a.event.startsAt.localeCompare(b.event.startsAt),
    )
    .map((x) => x.event);
}
export const productionIdentity = (event: EventRecord) =>
  event.canonicalProductionKey || event.productionKey || event.url;
export function uniqueEvents(events: EventRecord[], limit = 5) {
  const seen = new Set<string>();
  return events
    .filter((e) => {
      const key = productionIdentity(e);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}
export function sourceReason(e: EventRecord, f: Filters) {
  return [
    f.category
      ? `${e.category} tercihinle eşleşiyor.`
      : `${e.category} kategorisinden bir seçenek.`,
    f.maxPrice !== null
      ? `İlan edilen başlangıç fiyatı kişi başı bütçene uyuyor.`
      : null,
    f.dateFrom ? 'Seçtiğin tarih aralığında.' : null,
  ]
    .filter(Boolean)
    .join(' ');
}
