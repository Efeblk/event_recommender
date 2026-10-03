import type { Atom, Condition, Plan } from '../parser/contract.ts';
import { eventLocation, placeOf, sideNamed } from './istanbul-location.ts';
import { planPartyCount } from './plan-evidence.ts';
import { normalize } from './search.ts';
import type { EventRecord } from './types.ts';

/**
 * Soft preferences nudge an already eligible relevance ranking; they never
 * admit or remove an event. Phase 1 scores location and budget preferences
 * only (docs/archive/soft-ranking-plan.md). Unknown evidence is neutral.
 */
export interface SoftPreferences {
  preferences: Condition[];
  partyCount: number | null;
}

/** Largest relative score change, so relevance stays dominant. */
export const MAX_SOFT_ADJUSTMENT = 0.25;
const RANK_K = 60;

const scoredKinds = new Set<Atom['kind']>(['location', 'budget']);
const scores = (condition: Condition): boolean =>
  condition.type === 'atom'
    ? scoredKinds.has(condition.atom.kind)
    : condition.type !== 'not' && condition.children.some(scores);

export function softPreferencesFor(plan: Plan): SoftPreferences | undefined {
  const preferences = plan.preferences.filter(scores);
  return preferences.length
    ? { preferences, partyCount: planPartyCount(plan) }
    : undefined;
}

// Preference names are few; normalize each once rather than once per event.
type WantedPlace = { district?: string; side: 'europe' | 'asia' } | null;
const wantedPlaces = new Map<string, WantedPlace>();
function wantedPlace(atom: Extract<Atom, { kind: 'location' }>): WantedPlace {
  const key = `${atom.precision}:${atom.name}`;
  if (!wantedPlaces.has(key)) {
    if (wantedPlaces.size > 256) wantedPlaces.clear();
    const name = normalize(atom.name).trim();
    const side = atom.precision === 'side' ? sideNamed(name) : null;
    wantedPlaces.set(key, atom.precision === 'side' ? side && { side } : placeOf(name));
  }
  return wantedPlaces.get(key)!;
}

function locationSignal(
  event: EventRecord,
  atom: Extract<Atom, { kind: 'location' }>,
): number | null {
  const wanted = wantedPlace(atom);
  if (!wanted) return null;
  const actual = eventLocation(event);
  if (!actual.side) return 0;
  if (actual.side !== wanted.side) return -0.5;
  if (atom.precision === 'side') return 1;
  if (wanted.district && actual.district === wanted.district)
    return atom.precision === 'neighborhood' ? 0.75 : 1;
  return 0.25;
}

function budgetSignal(
  event: EventRecord,
  atom: Extract<Atom, { kind: 'budget' }>,
  partyCount: number | null,
): number | null {
  if (atom.currency !== 'TRY' || !(atom.amount > 0)) return null;
  if (
    event.price === null ||
    event.currency !== 'TRY' ||
    !Number.isFinite(event.price)
  )
    return 0;
  if (atom.basis === 'group_total' && partyCount === null) return 0;
  const price =
    atom.basis === 'group_total' ? event.price * partyCount! : event.price;
  const ratio = (price - atom.amount) / atom.amount;
  switch (atom.comparison) {
    case 'lt':
      return price < atom.amount ? 1 : -Math.min(1, 2 * ratio);
    case 'lte':
      return ratio <= 0 ? 1 : -Math.min(1, 2 * ratio);
    case 'gt':
      return price > atom.amount ? 1 : -0.5;
    case 'gte':
      return ratio >= 0 ? 1 : -0.5;
    case 'approx':
      return Math.abs(ratio) <= 0.2 ? 1 : -Math.min(1, Math.abs(ratio));
  }
}

/** Null when the condition carries no scored preference. */
function conditionSignal(
  event: EventRecord,
  condition: Condition,
  partyCount: number | null,
): number | null {
  if (condition.type === 'atom') {
    const { atom } = condition;
    if (atom.kind === 'location') return locationSignal(event, atom);
    if (atom.kind === 'budget') return budgetSignal(event, atom, partyCount);
    return null;
  }
  // Negated soft preferences are not scored in Phase 1.
  if (condition.type === 'not') return null;
  const signals = condition.children.flatMap((child) => {
    const signal = conditionSignal(event, child, partyCount);
    return signal === null ? [] : [signal];
  });
  if (!signals.length) return null;
  return condition.type === 'any'
    ? Math.max(...signals)
    : signals.reduce((sum, signal) => sum + signal, 0) / signals.length;
}

/** Mean preference signal in [-1, 1]; 0 when no preference applies. */
export function softPreferenceSignal(
  event: EventRecord,
  soft: SoftPreferences,
): number {
  const signals = soft.preferences.flatMap((condition) => {
    const signal = conditionSignal(event, condition, soft.partyCount);
    return signal === null ? [] : [signal];
  });
  if (!signals.length) return 0;
  const mean = signals.reduce((sum, signal) => sum + signal, 0) / signals.length;
  return Math.max(-1, Math.min(1, mean));
}

/**
 * Reorders a relevance ranking by a bounded multiplier on a rank-derived
 * score. Ties keep the incoming relevance order.
 */
export function applySoftPreferences(
  ranked: EventRecord[],
  soft: SoftPreferences | undefined,
): EventRecord[] {
  if (!soft) return ranked;
  return ranked
    .map((event, rank) => ({
      event,
      rank,
      score:
        (1 + MAX_SOFT_ADJUSTMENT * softPreferenceSignal(event, soft)) /
        (RANK_K + rank + 1),
    }))
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .map(({ event }) => event);
}
