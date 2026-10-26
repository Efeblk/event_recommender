import { validatePlanState } from '../lib/plan-state.ts';
import type { Atom, Condition, Plan } from '../parser/contract.ts';

export type HardCaseKind =
  | 'mood'
  | 'combined'
  | 'negation'
  | 'typo'
  | 'numbers'
  | 'refuse';

export type HardOutcome = 'search' | 'decline';

export interface HardCase {
  id: string;
  language: 'tr' | 'en';
  kind: HardCaseKind;
  message: string;
  outcome: HardOutcome;
  expected?: Plan;
  alternatives?: Plan[];
  declineAcceptable?: boolean;
  notes?: string;
}

export interface HardFixture {
  schemaVersion: 1;
  name: string;
  referenceTime: string;
  timezone: 'Europe/Istanbul';
  contract: string;
  source: string;
  cases: HardCase[];
}

export type ActualOutcome =
  | { outcome: 'search'; plan: Plan }
  | { outcome: 'decline'; reason: string };

export interface KindCounts {
  tp: number;
  fp: number;
  fn: number;
}

export interface CaseScore {
  id: string;
  kind: HardCaseKind;
  expectedOutcome: HardOutcome;
  pass: boolean;
  outcomeCorrect: boolean;
  missing: string[];
  extra: string[];
  promotedPreferences: string[];
  orderCorrect: boolean;
  byKind: Record<string, KindCounts>;
}

export interface KindSummary extends KindCounts {
  precision: number;
  recall: number;
}

export interface PlanEvalSummary {
  cases: number;
  passed: number;
  outcomeAccuracy: number;
  discardedClearRequests: number;
  wrongSearches: number;
  promotedPreferences: number;
  orderAccuracy: number;
  byKind: Record<string, KindSummary>;
  failedIds: string[];
}

const VALID_KINDS = new Set<HardCaseKind>([
  'mood',
  'combined',
  'negation',
  'typo',
  'numbers',
  'refuse',
]);

/** The Phase 1 golden fixture as plan cases: every request expects a search. */
export function fromGoldenFixture(value: {
  referenceTime: string;
  cases: { id: string; language: 'tr' | 'en'; message: string; expected: Plan; reviewSummary?: string }[];
}): HardFixture {
  return {
    schemaVersion: 1,
    name: 'golden-v1',
    referenceTime: value.referenceTime,
    timezone: 'Europe/Istanbul',
    contract: 'phase-1 golden',
    source: 'web/fixtures/golden-v1.json',
    cases: value.cases.map((c) => ({
      id: c.id, language: c.language, kind: 'combined', message: c.message,
      outcome: 'search', expected: c.expected, notes: c.reviewSummary,
    })),
  };
}

export function validateHardFixture(value: unknown): HardFixture {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid hard fixture.');
  const fixture = value as HardFixture;
  if (
    fixture.schemaVersion !== 1 ||
    typeof fixture.name !== 'string' ||
    !fixture.name.trim() ||
    fixture.timezone !== 'Europe/Istanbul' ||
    !Number.isFinite(Date.parse(fixture.referenceTime)) ||
    typeof fixture.contract !== 'string' ||
    !fixture.contract.trim() ||
    typeof fixture.source !== 'string' ||
    !fixture.source.trim() ||
    !Array.isArray(fixture.cases) ||
    fixture.cases.length === 0
  )
    throw new Error('Invalid hard fixture envelope.');

  const ids = new Set<string>();
  for (const item of fixture.cases) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid hard case.');
    if (
      typeof item.id !== 'string' ||
      !/^[a-z]+\d{2}$/.test(item.id) ||
      ids.has(item.id)
    )
      throw new Error(`Invalid or duplicate hard case id: ${String(item.id)}`);
    ids.add(item.id);

    if (item.language !== 'tr' && item.language !== 'en')
      throw new Error(`Invalid language for case ${item.id}.`);
    if (!VALID_KINDS.has(item.kind))
      throw new Error(`Invalid kind for case ${item.id}.`);
    if (
      typeof item.message !== 'string' ||
      !item.message.trim() ||
      item.message.length > 1200
    )
      throw new Error(`Invalid message for case ${item.id}.`);
    if (
      item.declineAcceptable !== undefined &&
      (typeof item.declineAcceptable !== 'boolean' || item.outcome !== 'search')
    )
      throw new Error(`Invalid declineAcceptable for case ${item.id}.`);
    if (item.notes !== undefined && typeof item.notes !== 'string')
      throw new Error(`Invalid notes for case ${item.id}.`);

    if (item.outcome === 'search') {
      if (!item.expected)
        throw new Error(`Search case ${item.id} requires expected plan.`);
      validatePlanState({
        version: 2,
        revision: 0,
        plan: item.expected,
        requests: [item.message],
      });
      if (item.alternatives !== undefined) {
        if (!Array.isArray(item.alternatives))
          throw new Error(`Invalid alternatives for case ${item.id}.`);
        for (const alt of item.alternatives) {
          validatePlanState({
            version: 2,
            revision: 0,
            plan: alt,
            requests: [item.message],
          });
        }
      }
    } else if (item.outcome === 'decline') {
      if (item.expected !== undefined)
        throw new Error(`Decline case ${item.id} must not have expected plan.`);
      if (item.alternatives !== undefined && item.alternatives.length > 0)
        throw new Error(`Decline case ${item.id} must not have alternatives.`);
    } else {
      throw new Error(`Invalid outcome for case ${item.id}.`);
    }
  }
  return fixture;
}

export function foldTurkishDiacritics(value: string): string {
  return value
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Equivalent atoms compare equal: days before the reference date cannot
 * match an event, and the evidence treats per-person and per-ticket alike. */
let referenceDay: string | null = null;
function atomSignature(atom: Atom): string {
  const normalized: Record<string, unknown> =
    atom.kind === 'location'
      ? { ...atom, name: foldTurkishDiacritics(atom.name).trim() }
      : atom.kind === 'date' && referenceDay && atom.from < referenceDay
        ? { ...atom, from: referenceDay }
        : atom.kind === 'budget' && atom.basis === 'per_person'
          ? { ...atom, basis: 'per_ticket' }
          : { ...atom };
  const sortedEntries = Object.entries(normalized)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(sortedEntries));
}

function singleSignature(cond: Condition): string {
  if (cond.type === 'atom') return atomSignature(cond.atom);
  if (cond.type === 'not') return `!${singleSignature(cond.child)}`;
  if (cond.type === 'any') {
    const childSigs = cond.children
      .flatMap((child) => [...conditionSignatures(child)])
      .sort();
    return `any(${childSigs.join('|')})`;
  }
  const childSigs = cond.children
    .flatMap((child) => [...conditionSignatures(child)])
    .sort();
  return childSigs.length === 1 ? childSigs[0] : `all(${childSigs.join('&')})`;
}

export function conditionSignatures(cond: Condition): Set<string> {
  if (cond.type === 'all') {
    const sigs: string[] = [];
    for (const child of cond.children) {
      for (const sig of conditionSignatures(child)) sigs.push(sig);
    }
    return new Set(sigs.sort());
  }
  return new Set([singleSignature(cond)]);
}

export function signatureKind(sig: string): string {
  const negated = sig.startsWith('!');
  const inner = sig.replace(/^!+/, '');
  if (inner.startsWith('any(')) return negated ? '!any' : 'any';
  const parsed = JSON.parse(inner) as { kind: string };
  return negated ? `!${parsed.kind}` : parsed.kind;
}

function buildByKind(
  expected: Set<string>,
  actual: Set<string>,
): Record<string, KindCounts> {
  const byKind: Record<string, KindCounts> = {};
  const ensure = (kind: string): KindCounts => {
    byKind[kind] ??= { tp: 0, fp: 0, fn: 0 };
    return byKind[kind];
  };
  for (const sig of expected) {
    const counts = ensure(signatureKind(sig));
    if (actual.has(sig)) counts.tp++;
    else counts.fn++;
  }
  for (const sig of actual) {
    if (!expected.has(sig)) {
      ensure(signatureKind(sig)).fp++;
    }
  }
  return byKind;
}

function compareAgainstPlan(target: Plan, actual: Plan) {
  const expectedHard = conditionSignatures(target.hard);
  const actualHard = conditionSignatures(actual.hard);
  const missing = [...expectedHard].filter((s) => !actualHard.has(s)).sort();
  const extra = [...actualHard].filter((s) => !expectedHard.has(s)).sort();
  const prefSigs = new Set(
    target.preferences.flatMap((pref) => [...conditionSignatures(pref)]),
  );
  const promotedPreferences = extra.filter((s) => prefSigs.has(s));
  const orderCorrect = actual.order === target.order;
  // Order is reported separately; it does not change which events qualify.
  const pass = missing.length === 0 && extra.length === 0;
  const byKind = buildByKind(expectedHard, actualHard);
  return {
    pass,
    missing,
    extra,
    promotedPreferences,
    orderCorrect,
    byKind,
    distance: missing.length + extra.length,
  };
}

export function scoreCase(
  fixtureCase: HardCase,
  actual: ActualOutcome,
  referenceDate: string | null = null,
): CaseScore {
  referenceDay = referenceDate;
  const attachOutcome = (score: Omit<CaseScore, 'expectedOutcome'>): CaseScore => ({
    ...score,
    expectedOutcome: fixtureCase.outcome,
  });

  if (fixtureCase.outcome === 'decline') {
    if (actual.outcome === 'decline') {
      return attachOutcome({
        id: fixtureCase.id,
        kind: fixtureCase.kind,
        pass: true,
        outcomeCorrect: true,
        missing: [],
        extra: [],
        promotedPreferences: [],
        orderCorrect: true,
        byKind: {},
      });
    }
    const actualHard = conditionSignatures(actual.plan.hard);
    return attachOutcome({
      id: fixtureCase.id,
      kind: fixtureCase.kind,
      pass: false,
      outcomeCorrect: false,
      missing: [],
      extra: [...actualHard].sort(),
      promotedPreferences: [],
      orderCorrect: false,
      byKind: buildByKind(new Set(), actualHard),
    });
  }

  const candidates = [
    fixtureCase.expected!,
    ...(fixtureCase.alternatives ?? []),
  ];

  if (actual.outcome === 'decline') {
    if (fixtureCase.declineAcceptable) {
      return attachOutcome({
        id: fixtureCase.id,
        kind: fixtureCase.kind,
        pass: true,
        outcomeCorrect: true,
        missing: [],
        extra: [],
        promotedPreferences: [],
        orderCorrect: true,
        byKind: {},
      });
    }
    const expectedHard = conditionSignatures(fixtureCase.expected!.hard);
    return attachOutcome({
      id: fixtureCase.id,
      kind: fixtureCase.kind,
      pass: false,
      outcomeCorrect: false,
      missing: [...expectedHard].sort(),
      extra: [],
      promotedPreferences: [],
      orderCorrect: false,
      byKind: buildByKind(expectedHard, new Set()),
    });
  }

  let best = compareAgainstPlan(candidates[0], actual.plan);
  for (let i = 1; i < candidates.length; i++) {
    if (best.pass) break;
    const current = compareAgainstPlan(candidates[i], actual.plan);
    if (current.pass || current.distance < best.distance) {
      best = current;
    }
  }

  return attachOutcome({
    id: fixtureCase.id,
    kind: fixtureCase.kind,
    pass: best.pass,
    outcomeCorrect: true,
    missing: best.missing,
    extra: best.extra,
    promotedPreferences: best.promotedPreferences,
    orderCorrect: best.orderCorrect,
    byKind: best.byKind,
  });
}

export function summarize(scores: CaseScore[]): PlanEvalSummary {
  const cases = scores.length;
  let passed = 0;
  let outcomeMatches = 0;
  let discardedClearRequests = 0;
  let wrongSearches = 0;
  let promotedPreferences = 0;
  let orderMatches = 0;
  const failedIds: string[] = [];
  const rawByKind: Record<string, KindCounts> = {};

  for (const score of scores) {
    if (score.orderCorrect) orderMatches++;
    if (score.pass) passed++;
    else failedIds.push(score.id);

    if (score.outcomeCorrect) {
      outcomeMatches++;
    } else {
      if (score.expectedOutcome === 'search') discardedClearRequests++;
      else wrongSearches++;
    }

    promotedPreferences += score.promotedPreferences.length;

    for (const [kind, counts] of Object.entries(score.byKind)) {
      rawByKind[kind] ??= { tp: 0, fp: 0, fn: 0 };
      rawByKind[kind].tp += counts.tp;
      rawByKind[kind].fp += counts.fp;
      rawByKind[kind].fn += counts.fn;
    }
  }

  const byKind: Record<string, KindSummary> = {};
  for (const kind of Object.keys(rawByKind).sort()) {
    const { tp, fp, fn } = rawByKind[kind];
    byKind[kind] = {
      tp,
      fp,
      fn,
      precision: tp + fp > 0 ? tp / (tp + fp) : 0,
      recall: tp + fn > 0 ? tp / (tp + fn) : 0,
    };
  }

  return {
    cases,
    passed,
    outcomeAccuracy: cases > 0 ? outcomeMatches / cases : 0,
    discardedClearRequests,
    wrongSearches,
    promotedPreferences,
    orderAccuracy: cases > 0 ? orderMatches / cases : 0,
    byKind,
    failedIds,
  };
}
