import { validateIntentState, type IntentState } from './input-state.ts';
import { EXPERIENCES } from './input-experiences.ts';

const CATEGORY_TEXT = {
  Konser: 'konser concert music',
  Tiyatro: 'tiyatro theatre play',
  'Stand-up': 'stand-up comedy komedi',
  Workshop: 'workshop atölye uygulamalı etkinlik',
  Sergi: 'sergi exhibition',
  Festival: 'festival',
  Spor: 'spor sports',
  Sinema: 'sinema film cinema',
  Söyleşi: 'söyleşi talk seminar conference',
  Dans: 'dans dance ballet',
  Gösteri: 'gösteri show performance',
  Eğitim: 'eğitim course learning',
  Gezi: 'gezi tour',
  Müze: 'müze museum',
  Diğer: 'etkinlik event',
} as const;

const REQUIREMENT_TEXT: Record<string, string> = {
  jazz: 'jazz caz',
  blues: 'blues',
  rock: 'rock',
  electronic: 'electronic elektronik müzik',
  rap: 'rap hip-hop',
  classical: 'classical klasik müzik',
  comedy: 'comedy komedi',
  drama: 'drama',
  kayaking: 'kayaking kano',
  rowing: 'rowing kürek',
  alcohol_free: 'alcohol-free alkolsüz',
  quiet: 'quiet sessiz',
  seated: 'seated oturmalı',
  romantic: 'romantic romantik',
  uncrowded: 'uncrowded kalabalık olmayan',
  children: 'children çocuk etkinliği',
  family_friendly: 'family-friendly aile dostu',
  step_free: 'step-free wheelchair access basamaksız tekerlekli sandalye erişimi',
  accessible_toilet: 'accessible toilet erişilebilir tuvalet',
};

const MOOD_TEXT: Record<NonNullable<IntentState['preferences']['mood']>, string> = {
  calm: 'sakin rahat bir akşam planı',
  energetic: 'enerjik canlı bir etkinlik',
  uplifting: 'keyifli moral yükselten bir etkinlik',
};

const COMPANION_TEXT: Record<NonNullable<IntentState['preferences']['companion']>, string> = {
  partner: 'partnerle birlikte bir etkinlik',
  friends: 'arkadaşlarla birlikte bir etkinlik',
  family: 'aileyle birlikte bir etkinlik',
};

const fold = (value: string) =>
  value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replaceAll('\u0131', 'i')
    .replace(/[ -]+/g, '_');

/**
 * Builds deterministic, positive natural-language text for dense and lexical
 * retrieval. Dates, times and prices remain structured filters and are not
 * repeated here.
 */
export function retrievalQuery(state: IntentState): string {
  return queryText(state, true);
}

/** Keeps search expansions out of the user's request shown to the ranker. */
export function recommendationQuery(state: IntentState): string {
  return queryText(state, false);
}

function queryText(state: IntentState, expandExperiences: boolean): string {
  const current = validateIntentState(state);
  const prohibited = new Set(
    current.requirements
      .filter((item) => item.policy === 'exclude_positive_evidence')
      .flatMap((item) => item.value.split('|')),
  );
  const parts: string[] = [];
  let length = 0;
  const add = (part: string | null | undefined) => {
    if (!part) return;
    const extra = part.length + (parts.length ? 1 : 0);
    if (length + extra > 1200) return;
    parts.push(part);
    length += extra;
  };

  const categories =
    current.filters.categories ??
    (current.filters.category ? [current.filters.category] : []);
  for (const category of categories) add(CATEGORY_TEXT[category]);
  add(current.filters.district);

  for (const requirement of current.requirements) {
    // Content requirements ask for evidence that content is absent. Negative
    // requirements likewise must never become positive retrieval terms.
    if (
      requirement.policy !== 'require_support' ||
      requirement.kind === 'content'
    )
      continue;
    for (const value of requirement.value.split('|')) {
      if (requirement.kind === 'audience' && value.startsWith('age:')) {
        add(`${value.slice(4)} yaş çocuk`);
      } else {
        add(REQUIREMENT_TEXT[value]);
      }
    }
  }

  if (current.preferences.mood) add(MOOD_TEXT[current.preferences.mood]);
  if (current.preferences.companion)
    add(COMPANION_TEXT[current.preferences.companion]);

  for (const experience of current.preferences.experiences ?? []) {
    // These suggest search concepts, never a category filter or source fact.
    // Omit an expansion when it would positively name an excluded genre.
    const feature = EXPERIENCES[experience];
    const terms = expandExperiences ? feature.query : feature.label;
    const conflicts = [...prohibited].some((value) =>
      (REQUIREMENT_TEXT[value] ?? value).split(/\s+/u).some((term) =>
        term.length > 2 && fold(terms).split('_').includes(fold(term)),
      ),
    );
    add(conflicts ? feature.label : terms);
  }

  for (const interest of current.preferences.interests) {
    const normalized = fold(interest);
    if (![...prohibited].some((value) => normalized.includes(fold(value))))
      add(interest);
  }

  return parts.join(' ') || 'İstanbul etkinlikleri Istanbul events';
}
