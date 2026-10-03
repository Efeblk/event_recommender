import type { Category } from './types.ts';

export function isFullPreferenceReset(message: string): boolean {
  const text = message
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
  if (
    /\b(?:her seyi|herseyi|tumunu) unutma\b|\b(?:don't|dont|do not) forget everything\b/.test(
      text,
    )
  )
    return false;
  return /\b(?:bastan basla(?:yalim)?|onceki (?:sartlari|kosullari|tercihleri) unut|(?:her seyi|herseyi|tumunu) unut|start (?:over|again)|forget everything|forget (?:the )?(?:previous|earlier) (?:preferences|constraints|conditions))\b/.test(
    text,
  );
}

export function isAlternativesRequest(message: string): boolean {
  const normalized = message
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return /\b(?:baska var mi|baska oner(?:i|ir misin)?|baska goster|bunlari begenmedim|bunlar(?:i)? olmadi baska|baska bir sey oner|something else|anything else)\b|^baska$|\b(?:other|different|more)\s+(?:options|events|suggestions|recommendations)\b|\b(?:show|suggest)\s+(?:me\s+)?alternatives\b|\b(?:baska|diger|alternatif)\b[^.!?\n]{0,32}\b(?:secenek|etkinlik|oneri|alternatif)(?:ler|leri)?\b/.test(
    normalized,
  );
}

/** Exact discourse-only commands may reuse a validated plan without AI. */
export function isStandaloneAlternativesRequest(message: string): boolean {
  const text = message.toLocaleLowerCase('tr-TR').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  return /^(?:(?:bunlari begenmedim|bunlar olmadi)\s+)?(?:baska|baska (?:var mi|goster|oneri|onerir misin)|baska (?:secenekler|etkinlikler|oneriler)(?: var mi)?|baska bir sey oner|anything else|something else|(?:show|suggest)(?: me)? alternatives|(?:other|different|more) (?:options|events|suggestions|recommendations)(?: please)?)$/u.test(text);
}

// "Oyun" is too broad on its own (games, music and idioms). Treat it as
// theatre only when the surrounding request supplies stage/adult-drama context.
const theatrePlay =
  /\b(?:ciddi|dramatik|yetiskin(?:ler|lere)?(?:\s+(?:uygun|yonelik))?|sahne(?:de|ye)?|perde|bilet|izle(?:mek|yelim)?|seyret(?:mek|yelim)?)\b[^.!?\n]{0,48}\boyun(?:u|lar|lari)?\b|\boyun(?:u|lar|lari)?\b[^.!?\n]{0,48}\b(?:ciddi|dramatik|yetiskin(?:ler|lere)?(?:\s+(?:uygun|yonelik))?|sahne(?:de|ye)?|perde|bilet|izle(?:mek|yelim)?|seyret(?:mek|yelim)?)\b/;
const tabletopGame =
  /\b(?:kutu|masa|kart|video|bilgisayar|konsol)\s+oyun(?:u|lari?)?\b/;
export const CATEGORY_NEGATION =
  '(?:istemiyorum|istemiyoruz|istemem|istemeyiz|aramiyorum|aramayiz|olmasin|olmasinlar|degil|haric|disi|disinda|disindaki|yerine|bosver)';

const rejectionTerms = [
  ['workshop', /\b(?:workshops?|atolye(?:ler)?)\b/, 'Workshop'],
  ['sergi', /\b(?:sergi(?:ler)?|exhibitions?)\b/, 'Sergi'],
  ['festival', /\bfestivals?\b/, 'Festival'],
  ['spor', /\b(?:spor(?:\s+etkinligi)?|sports?(?:\s+events?)?)\b/, 'Spor'],
  ['sinema', /\b(?:sinema|cinema|movie\s+screenings?|film\s+gosterimi)\b/, 'Sinema'],
  ['soylesi', /\b(?:soylesi(?:ler)?|talks?)\b/, 'Söyleşi'],
  ['dans', /\b(?:dans\s+gosterisi|dance\s+performances?)\b/, 'Dans'],
  ['gosteri', /\b(?:gosteri(?:ler)?|stage\s+shows?)\b/, 'Gösteri'],
  ['egitim', /\b(?:egitim\s+etkinligi|training\s+events?|classes|courses)\b/, 'Eğitim'],
  ['gezi', /\b(?:gezi(?:ler)?|guided\s+tours?)\b/, 'Gezi'],
  ['muze', /\b(?:muze(?:ler)?|museums?)\b/, 'Müze'],
  ['diger', /\b(?:diger\s+kategori|other\s+category)\b/, 'Diğer'],
  ['elektronik muzik', /\belektronik\s+muzik\b/, null],
  ['cocuk tiyatrosu', /\bcocuk\s+tiyatro(?:su(?:na|nda|nu)?|ya|yu)?\b/, null],
  ['cocuk etkinligi', /\bcocuk\s+etkinligi\b/, null],
  ['cocuk oyunu', /\bcocuk\s+oyunu\b/, null],
  ['sahne oyunu', /\bsahne\s+oyunu\b/, null],
  ['stand-up', /\bstand[ -]?up\b/, 'Stand-up'],
  ['akustik', /\bakustik\b/, null],
  ['techno', /\btechno\b/, null],
  ['rock', /\brock\b/, null],
  ['jazz', /\bjazz\b/, null],
  ['caz', /\bcaz\b/, null],
  ['comedy', /\bcomedy\b/, null],
  ['komedi', /\bkomedi\b/, null],
  [
    'konser',
    /\b(?:konser(?:ler(?:e|i|in|den|de)?|e|i|in|den|de)?|concerts?)\b/,
    'Konser',
  ],
  [
    'tiyatro',
    /\b(?:tiyatro(?:lar(?:a|i|in|dan|da)?|ya|yu|nun|dan|da|su(?:na|nda|nu)?)?|theatre|theater)\b/,
    'Tiyatro',
  ],
  ['muzik', /\b(?:muzik|music)\b/, 'Konser'],
] as const satisfies ReadonlyArray<readonly [string, RegExp, Category | null]>;

export interface CategoryIntent {
  positiveText: string;
  requestedCategories: Category[];
  excludedCategories: Category[];
  rejectedTerms: string[];
}

function normalizedIntentText(message: string) {
  return message
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
}

function rejectionAnalysis(message: string) {
  const text = normalizedIntentText(message);
  const rejected = new Set<string>();
  const excluded = new Set<Category>();
  const positiveClauses: string[] = [];
  const clauses = text.split(/(\b(?:ama|fakat|ancak|but)\b|[,;.!?\n])/);
  const suffix = new RegExp(
    `\\b(?:gitmek|izlemek|dinlemek)?\\s*${CATEGORY_NEGATION}\\b`,
  );
  const englishPrefix =
    /\b(?:anything\s+except|we do not want|we don't want|we dont want|do not want|don't want|dont want|no|not|without|excluding?|except)\s+(?:any\s+)?/;

  for (const clause of clauses) {
    if (/^(?:ama|fakat|ancak|but|,|;|\.|!|\?)$/.test(clause.trim())) {
      positiveClauses.push(clause);
      continue;
    }
    let masked = clause;
    const suffixMatch = suffix.exec(clause);
    if (suffixMatch) {
      const beforeMarker = clause.slice(0, suffixMatch.index);
      const lastPositive = Math.max(
        beforeMarker.lastIndexOf(' istiyorum '),
        beforeMarker.lastIndexOf(' olsun '),
        beforeMarker.lastIndexOf(' please '),
      );
      const candidateStart = lastPositive >= 0 ? lastPositive + 1 : 0;
      const candidate = beforeMarker.slice(candidateStart);
      let first = Number.POSITIVE_INFINITY;
      for (const [term, pattern, category] of rejectionTerms) {
        const match = pattern.exec(candidate);
        if (!match) continue;
        const matchStart = match.index ?? 0;
        const tail = candidate.slice(matchStart + match[0].length);
        const coordinatedTail =
          /^\s*(?:da|de)?\s*$|^\s*(?:ve|veya|ya da|and|or|,)\s+(?:cocuk\s+etkinligi|cocuk\s+tiyatro(?:su(?:na|nda|nu)?|ya|yu)?|cocuk\s+oyunu|konser(?:ler(?:e|i|in|den|de)?|e|i|in|den|de)?|concerts?|muzik|music|tiyatro(?:lar|ya|yu|su(?:na|nda|nu)?)?|theatre|theater|stand[ -]?up|workshops?|atolye(?:ler)?|sergi(?:ler)?|exhibitions?|festivals?|spor(?:\s+etkinligi)?|sports?(?:\s+events?)?|sinema|cinema|movie\s+screenings?|film\s+gosterimi|soylesi(?:ler)?|talks?|dans\s+gosterisi|dance\s+performances?|gosteri(?:ler)?|stage\s+shows?|egitim\s+etkinligi|training\s+events?|classes|courses|gezi(?:ler)?|guided\s+tours?|muze(?:ler)?|museums?|diger\s+kategori|other\s+category)\s*$/.test(
            tail,
          );
        const genreBeforeConcert =
          /^(?:rock|caz|jazz|akustik|techno)$/i.test(term) &&
          /^\s+konser(?:ler(?:e|i|in|den|de)?|e|i|in|den|de)?\s*$/.test(tail);
        if (!coordinatedTail && !genreBeforeConcert) continue;
        if (
          (term === 'muzik' && /\belektronik\s+muzik\b/.test(candidate)) ||
          (term === 'tiyatro' && /\bcocuk\s+tiyatro/.test(candidate)) ||
          (term === 'konser' &&
            /\b(?:rock|caz|jazz|akustik|techno)\s+konser/.test(candidate))
        )
          continue;
        rejected.add(term.startsWith('cocuk ') ? 'cocuk' : term);
        if (category) excluded.add(category);
        first = Math.min(first, candidateStart + matchStart);
      }
      if (Number.isFinite(first))
        masked =
          clause.slice(0, first) +
          ' ' +
          clause.slice(suffixMatch.index + suffixMatch[0].length);
    }

    const englishList = masked.match(
      new RegExp(
        `${englishPrefix.source}([^,;.!]+?)(?=\\b(?:please|recommend|show|find)\\b|[,;.!]|$)`,
        'i',
      ),
    );
    if (englishList) {
      for (const [term, pattern, category] of rejectionTerms) {
        if (!pattern.test(englishList[1])) continue;
        if (
          (term === 'muzik' && /\belektronik\s+muzik\b/.test(englishList[1])) ||
          (term === 'tiyatro' && /\bcocuk\s+tiyatro/.test(englishList[1])) ||
          (term === 'konser' &&
            /\b(?:rock|jazz|acoustic|techno)\s+concerts?\b/.test(
              englishList[1],
            ))
        )
          continue;
        rejected.add(term.startsWith('cocuk ') ? 'cocuk' : term);
        if (category) excluded.add(category);
      }
      masked = masked.replace(englishList[0], ' ');
    }
    for (const [term, pattern, category] of rejectionTerms) {
      const source = pattern.source.replace(/^\\b|\\b$/g, '');
      const prefixed = new RegExp(
        `${englishPrefix.source}(?:${source})\\b`,
        'g',
      );
      if (!prefixed.test(masked)) continue;
      rejected.add(term.startsWith('cocuk ') ? 'cocuk' : term);
      if (category) excluded.add(category);
      masked = masked.replace(prefixed, ' ');
    }
    positiveClauses.push(masked);
  }
  return {
    positiveText: positiveClauses.join(' '),
    excludedCategories: [...excluded],
    rejectedTerms: [...rejected],
  };
}

const categoryPatterns: Array<[Category, RegExp]> = [
  [
    'Konser',
    /\b(?:konser(?:ler(?:e|i|in|den|de)?|e|i|in|den|de)?|concerts?|music|muzik|rock|caz|jazz|akustik|techno|elektronik)\b/,
  ],
  [
    'Tiyatro',
    /\b(?:tiyatro(?:ya|da|yu|lar|su(?:na|nda|nu)?)?|theatre|theater|sahne oyunu|comedy play)\b/,
  ],
  ['Stand-up', /\b(?:stand[ -]?up)\b/],
  ['Workshop', /\b(?:workshops?|atolye(?:ler)?)\b/],
  ['Sergi', /\b(?:sergi(?:ler)?|exhibitions?)\b/],
  ['Festival', /\bfestivals?\b/],
  ['Spor', /\b(?:spor(?:\s+etkinligi)?|sports?(?:\s+events?)?)\b/],
  ['Sinema', /\b(?:sinema|cinema|movie\s+screenings?|film\s+gosterimi)\b/],
  ['Söyleşi', /\b(?:soylesi(?:ler)?|talks?)\b/],
  ['Dans', /\b(?:dans\s+gosterisi|dance\s+performances?)\b/],
  [
    'Gösteri',
    /\b(?:stage\s+shows?|sahne\s+gosteri(?:si|ye|ler)?|gosteri(?:ye|ler)?\s+(?:olsun|istiyorum|isterim|gidelim|izlemek|oner\w*|bul\w*))\b/,
  ],
  ['Eğitim', /\b(?:egitim\s+etkinligi|training\s+events?|classes|courses)\b/],
  ['Gezi', /\b(?:gezi(?:ler)?|guided\s+tours?)\b/],
  ['Müze', /\b(?:muze(?:ler)?|museums?)\b/],
  ['Diğer', /\b(?:diger\s+kategori|other\s+category)\b/],
];

export function requestedCategories(normalizedMessage: string): Category[] {
  const positiveText = positiveCategoryText(normalizedMessage).replace(
    /\b(?:workshops?|atolye(?:ler)?)\s+(?:olabilir|de olabilir|could be (?:nice|good|fine)|would be (?:nice|good|fine))\b/g,
    ' ',
  );
  const categories = categoryPatterns
    .filter(([, pattern]) => pattern.test(positiveText))
    .map(([category]) => category);
  if (!tabletopGame.test(positiveText) && theatrePlay.test(positiveText))
    categories.push('Tiyatro');
  if (/\b(?:komedi oyunu|comedy play|comic play)\b/.test(positiveText))
    categories.push('Tiyatro');
  return [...new Set(categories)];
}

export function positiveCategoryText(normalizedMessage: string) {
  return rejectionAnalysis(normalizedMessage)
    .positiveText.split(/(\b(?:ama|fakat|ancak|but)\b)/)
    .map((clause) =>
      clause
        .replace(
          new RegExp(
            `\\b(?:ciddi|dramatik|yetiskin(?:ler|lere)?(?:\\s+(?:uygun|yonelik))?|sahne(?:de|ye)?|perde)\\b[^,.!?;\\n]{0,48}\\boyun(?:u|lar|lari)?\\s+${CATEGORY_NEGATION}\\b`,
            'g',
          ),
          ' ',
        )
        .replace(
          /\b(?:no|without|excluding?|except)\s+(?:any\s+)?(?:concerts?|music|theatre|theater|plays?|stand[ -]?up)(?:\s*(?:and|or)\s*(?:children(?:['’]s)?\s+)?(?:shows?|concerts?|music|theatre|theater|plays?|stand[ -]?up))*/g,
          ' ',
        ),
    )
    .join(' ');
}

export function categoryIntent(message: string): CategoryIntent {
  const termCategory = (term: string): Category | null =>
    term === 'konser' || term === 'muzik'
      ? 'Konser'
      : term === 'tiyatro'
        ? 'Tiyatro'
        : term === 'stand-up'
          ? 'Stand-up'
          : rejectionTerms.find(([name]) => name === term)?.[2] ?? null;
  const categoryState = new Map<Category, 'positive' | 'negative'>();
  const rejected = new Set<string>();
  const positiveParts: string[] = [];
  for (const clause of normalizedIntentText(message).split(
    /\b(?:ama|fakat|ancak|but)\b|[,;.!?\n]/,
  )) {
    const analysis = rejectionAnalysis(clause);
    positiveParts.push(analysis.positiveText);
    for (const category of analysis.excludedCategories)
      categoryState.set(category, 'negative');
    for (const term of analysis.rejectedTerms) rejected.add(term);
    const positive = requestedCategories(analysis.positiveText);
    for (const category of positive) categoryState.set(category, 'positive');
    for (const term of rejected) {
      const category = termCategory(term);
      if (category && positive.includes(category)) rejected.delete(term);
      else if (
        new RegExp(
          `\\b${term.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\b`,
        ).test(analysis.positiveText)
      )
        rejected.delete(term);
    }
  }
  for (const category of requestedCategories(positiveParts.join(' ')))
    if (!categoryState.has(category)) categoryState.set(category, 'positive');
  return {
    positiveText: positiveParts.join(' '),
    requestedCategories: [...categoryState]
      .filter(([, state]) => state === 'positive')
      .map(([category]) => category),
    excludedCategories: [...categoryState]
      .filter(([, state]) => state === 'negative')
      .map(([category]) => category),
    rejectedTerms: [...rejected],
  };
}
