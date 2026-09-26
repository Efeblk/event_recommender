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

// "Oyun" is too broad on its own (games, music and idioms). Treat it as
// theatre only when the surrounding request supplies stage/adult-drama context.
const theatrePlay =
  /\b(?:ciddi|dramatik|yetiskin(?:ler|lere)?(?:\s+(?:uygun|yonelik))?|sahne(?:de|ye)?|perde|bilet|izle(?:mek|yelim)?|seyret(?:mek|yelim)?)\b[^.!?\n]{0,48}\boyun(?:u|lar|lari)?\b|\boyun(?:u|lar|lari)?\b[^.!?\n]{0,48}\b(?:ciddi|dramatik|yetiskin(?:ler|lere)?(?:\s+(?:uygun|yonelik))?|sahne(?:de|ye)?|perde|bilet|izle(?:mek|yelim)?|seyret(?:mek|yelim)?)\b/;
const tabletopGame =
  /\b(?:kutu|masa|kart|video|bilgisayar|konsol)\s+oyun(?:u|lari?)?\b/;
export const CATEGORY_NEGATION =
  '(?:istemiyorum|istemem|istemeyiz|aramiyorum|aramayiz|olmasin|olmasinlar|degil|haric|disinda|yerine|bosver)';

const categoryPatterns: Array<[Category, RegExp]> = [
  [
    'Konser',
    /\b(?:konser(?:de|e|i|ler)?|concerts?|music|muzik|rock|caz|jazz|akustik|techno|elektronik)\b/,
  ],
  [
    'Tiyatro',
    /\b(?:tiyatro(?:ya|da|yu|lar|su(?:na|nda|nu)?)?|theatre|theater|sahne oyunu|comedy play)\b/,
  ],
  ['Stand-up', /\b(?:stand[ -]?up)\b/],
];

export function requestedCategories(normalizedMessage: string): Category[] {
  const positiveText = positiveCategoryText(normalizedMessage);
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
  return normalizedMessage
    .split(/(\b(?:ama|fakat|ancak|but)\b)/)
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
          new RegExp(
            `(?:^|[,.!?;]\\s*)[^,.!?;\\n]{0,80}\\s+${CATEGORY_NEGATION}\\b`,
            'gu',
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
