import type { Requirement, RequirementKind } from './requirements.ts';
import { validateFilters } from './search.ts';
import { emptyFilters, type Filters } from './types.ts';

export interface IntentState {
  version: 1;
  filters: Filters;
  requirements: Requirement[];
  preferences: {
    mood: 'calm' | 'energetic' | 'uplifting' | null;
    companion: 'partner' | 'friends' | 'family' | null;
    interests: string[];
  };
}

const STATE_KEYS = ['version', 'filters', 'requirements', 'preferences'];
const FILTER_KEYS = [
  'dateFrom',
  'dateTo',
  'maxPrice',
  'maxPriceExclusive',
  'partySize',
  'totalBudget',
  'category',
  'excludedCategories',
  'district',
  'startTimeFrom',
  'startTimeTo',
  'startTimeFromExclusive',
  'startTimeToExclusive',
  'categories',
];
const PREFERENCE_KEYS = ['mood', 'companion', 'interests'];
const REQUIREMENT_KEYS = ['kind', 'value', 'policy'];
const MOODS = ['calm', 'energetic', 'uplifting'] as const;
const COMPANIONS = ['partner', 'friends', 'family'] as const;
const POLICIES = ['require_support', 'exclude_positive_evidence'] as const;

const REQUIREMENT_VALUES: Record<RequirementKind, ReadonlySet<string>> = {
  genre: new Set([
    'jazz',
    'blues',
    'rock',
    'electronic',
    'rap',
    'classical',
    'comedy',
    'drama',
  ]),
  activity: new Set([
    'kayaking',
    'rowing',
    'alcohol_free',
    'quiet',
    'seated',
    'romantic',
    'uncrowded',
  ]),
  audience: new Set(['children', 'family_friendly']),
  content: new Set(['swearing', 'sexual_content']),
  accessibility: new Set(['step_free', 'accessible_toilet']),
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
) {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error(`${label} has invalid keys.`);
}

function requirementParts(kind: RequirementKind, value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 160 ||
    value.trim() !== value
  )
    throw new Error('Requirement value is invalid.');
  const parts = value.split('|');
  if (
    parts.length > 8 ||
    parts.some((part) => !part || part.trim() !== part) ||
    new Set(parts).size !== parts.length
  )
    throw new Error('Requirement alternatives are invalid.');
  for (const part of parts) {
    if (kind === 'audience' && /^age:(?:[0-9]|1[0-7])$/.test(part)) continue;
    if (!REQUIREMENT_VALUES[kind].has(part))
      throw new Error('Requirement value is unsupported.');
  }
  // Age evidence is evaluated as one numeric scalar. Multiple child ages are
  // independent AND requirements, never pipe alternatives.
  if (parts.length > 1 && parts.some((part) => part.startsWith('age:')))
    throw new Error('Age requirements must be separate.');
  // Activity pipes cannot safely represent a conjunction in the current
  // evidence checker (some activity values have scalar handling). Express
  // every mandatory activity as its own Requirement entry in state v1.
  if (kind === 'activity' && parts.length > 1)
    throw new Error('Activity requirements must be separate.');
  return parts;
}

export function emptyIntentState(filters: Filters = emptyFilters): IntentState {
  return {
    version: 1,
    filters: validateStrictFilters(filters),
    requirements: [],
    preferences: { mood: null, companion: null, interests: [] },
  };
}

function validateStrictFilters(value: unknown) {
  const input = record(value, 'Filters');
  exactKeys(input, FILTER_KEYS, ['dateFrom', 'dateTo', 'maxPrice', 'category'], 'Filters');
  const rawSelected = Array.isArray(input.categories)
    ? input.categories
    : input.category == null
      ? []
      : [input.category];
  const rawExcluded = Array.isArray(input.excludedCategories)
    ? input.excludedCategories
    : [];
  if (
    rawSelected.some((category) => rawExcluded.includes(category))
  )
    throw new Error('A category cannot be both selected and excluded.');
  const filters = validateFilters(input);
  const selected = filters.categories ?? (filters.category ? [filters.category] : []);
  if (selected.some((category) => filters.excludedCategories?.includes(category)))
    throw new Error('A category cannot be both selected and excluded.');
  if (
    filters.startTimeFrom &&
    filters.startTimeTo &&
    (filters.startTimeFrom > filters.startTimeTo ||
      (filters.startTimeFrom === filters.startTimeTo &&
        (filters.startTimeFromExclusive || filters.startTimeToExclusive)))
  )
    throw new Error('Time window is empty or reversed.');
  return filters;
}

export function validateIntentState(value: unknown): IntentState {
  const input = record(value, 'Intent state');
  exactKeys(input, STATE_KEYS, STATE_KEYS, 'Intent state');
  if (input.version !== 1) throw new Error('Intent state version is invalid.');

  if (!Array.isArray(input.requirements) || input.requirements.length > 24)
    throw new Error('Requirements are invalid.');
  const requirements: Requirement[] = [];
  const required = new Map<RequirementKind, Set<string>>();
  const excluded = new Map<RequirementKind, Set<string>>();
  for (const raw of input.requirements) {
    const item = record(raw, 'Requirement');
    exactKeys(item, REQUIREMENT_KEYS, REQUIREMENT_KEYS, 'Requirement');
    if (!Object.hasOwn(REQUIREMENT_VALUES, item.kind as PropertyKey))
      throw new Error('Requirement kind is invalid.');
    if (!POLICIES.includes(item.policy as (typeof POLICIES)[number]))
      throw new Error('Requirement policy is invalid.');
    const kind = item.kind as RequirementKind;
    const policy = item.policy as Requirement['policy'];
    const parts = requirementParts(kind, item.value);
    const own = policy === 'require_support' ? required : excluded;
    const opposite = policy === 'require_support' ? excluded : required;
    if (parts.some((part) => opposite.get(kind)?.has(part)))
      throw new Error('Requirement is both required and excluded.');
    const values = own.get(kind) ?? new Set<string>();
    parts.forEach((part) => values.add(part));
    own.set(kind, values);
    requirements.push({ kind, value: parts.join('|'), policy });
  }

  const preferences = record(input.preferences, 'Preferences');
  exactKeys(preferences, PREFERENCE_KEYS, PREFERENCE_KEYS, 'Preferences');
  if (
    preferences.mood !== null &&
    !MOODS.includes(preferences.mood as (typeof MOODS)[number])
  )
    throw new Error('Mood is invalid.');
  if (
    preferences.companion !== null &&
    !COMPANIONS.includes(preferences.companion as (typeof COMPANIONS)[number])
  )
    throw new Error('Companion is invalid.');
  if (
    !Array.isArray(preferences.interests) ||
    preferences.interests.length > 12 ||
    preferences.interests.some(
      (interest) =>
        typeof interest !== 'string' ||
        interest.trim() !== interest ||
        !interest.length ||
        interest.length > 80,
    ) ||
    new Set(preferences.interests).size !== preferences.interests.length
  )
    throw new Error('Interests are invalid.');

  return {
    version: 1,
    filters: validateStrictFilters(input.filters),
    requirements,
    preferences: {
      mood: preferences.mood as IntentState['preferences']['mood'],
      companion: preferences.companion as IntentState['preferences']['companion'],
      interests: [...(preferences.interests as string[])],
    },
  };
}

/** Builds bounded positive retrieval/ranking text from validated current state. */
export function intentQuery(state: IntentState): string {
  const current = validateIntentState(state);
  const excluded = new Set(
    current.requirements
      .filter((item) => item.policy === 'exclude_positive_evidence')
      .flatMap((item) => item.value.split('|')),
  );
  const parts: string[] = [];
  const add = (part: string | null | undefined) => {
    if (part && parts.join(' ').length + part.length + 1 <= 1200) parts.push(part);
  };
  const categories = current.filters.categories ??
    (current.filters.category ? [current.filters.category] : []);
  categories.forEach((category) => add(`category:${category}`));
  add(current.filters.district ? `district:${current.filters.district}` : null);
  current.requirements
    // Strict content requirements mean evidence of absence. Emitting their
    // values as positive query terms would retrieve the prohibited content.
    // Pipe values for content/accessibility are conjunctive in source checks;
    // pipes are alternatives only for the other supported kinds.
    .filter(
      (item) => item.policy === 'require_support' && item.kind !== 'content',
    )
    .forEach((item) => add(`${item.kind}:${item.value}`));
  add(current.preferences.mood ? `mood:${current.preferences.mood}` : null);
  add(
    current.preferences.companion
      ? `companion:${current.preferences.companion}`
      : null,
  );
  for (const interest of current.preferences.interests) {
    const normalized = interest.toLocaleLowerCase('en-US').replace(/[ -]+/g, '_');
    if (![...excluded].some((term) => normalized.includes(term)))
      add(`interest:${interest}`);
  }
  return parts.join(' ') || 'Istanbul events';
}
