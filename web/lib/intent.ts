import type { Category } from './types.ts';

// "Oyun" is too broad on its own (games, music and idioms). Treat it as
// theatre only when the surrounding request supplies stage/adult-drama context.
const theatrePlay =
  /\b(?:ciddi|dramatik|yetiskin(?:ler|lere)?(?:\s+(?:uygun|yonelik))?|sahne(?:de|ye)?|perde)\b[^.!?\n]{0,48}\boyun(?:u|lar|lari)?\b|\boyun(?:u|lar|lari)?\b[^.!?\n]{0,48}\b(?:ciddi|dramatik|yetiskin(?:ler|lere)?(?:\s+(?:uygun|yonelik))?|sahne(?:de|ye)?|perde)\b/;
const tabletopGame =
  /\b(?:kutu|masa|kart|video|bilgisayar|konsol)\s+oyun(?:u|lari?)?\b/;
const negation = '(?:istemiyorum|istemem|olmasin|degil|haric|disinda|yerine)';

const categoryPatterns: Array<[Category, RegExp]> = [
  ['Konser', /\b(?:konser|muzik|rock|caz|jazz|akustik|techno|elektronik)\b/],
  ['Tiyatro', /\b(?:tiyatro|sahne oyunu)\b/],
  ['Stand-up', /\b(?:stand[ -]?up|komedi|gulecek|gulelim)\b/],
];

export function requestedCategories(normalizedMessage: string): Category[] {
  const positiveText = positiveCategoryText(normalizedMessage);
  const categories = categoryPatterns
    .filter(([, pattern]) => pattern.test(positiveText))
    .map(([category]) => category);
  if (!tabletopGame.test(positiveText) && theatrePlay.test(positiveText))
    categories.push('Tiyatro');
  return [...new Set(categories)];
}

export function positiveCategoryText(normalizedMessage: string) {
  return normalizedMessage
    .replace(
      new RegExp(
        `\\b(?:ciddi|dramatik|yetiskin(?:ler|lere)?(?:\\s+(?:uygun|yonelik))?|sahne(?:de|ye)?|perde)\\b[^,.!?;\\n]{0,48}\\boyun(?:u|lar|lari)?\\s+${negation}\\b`,
        'g',
      ),
      ' ',
    )
    .replace(
      new RegExp(`\\b[\\p{L}-]+(?:\\s+[\\p{L}-]+)?\\s+${negation}\\b`, 'gu'),
      ' ',
    );
}
