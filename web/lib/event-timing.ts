import type { AttendanceTiming } from './types.ts';

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index]);
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

/** Strictly validates untrusted persisted timing metadata. */
export function parseAttendanceTiming(value: unknown): AttendanceTiming | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid attendance timing');
  const timing = value as Record<string, unknown>;
  if (timing.kind === 'timed_session') {
    if (!exactKeys(timing, ['kind', 'evidence']) || timing.evidence !== 'provider_sessions_and_source_text')
      throw new Error('Invalid attendance timing');
    return { kind: timing.kind, evidence: timing.evidence };
  }
  if (timing.kind === 'unknown') {
    if (!exactKeys(timing, ['kind', 'evidence']) || timing.evidence !== 'insufficient_source_evidence')
      throw new Error('Invalid attendance timing');
    return { kind: timing.kind, evidence: timing.evidence };
  }
  if (timing.kind === 'admission_window') {
    if (
      !exactKeys(timing, ['kind', 'evidence', 'validFrom', 'validThrough']) ||
      timing.evidence !== 'provider_flexible_window' ||
      !canonicalIso(timing.validFrom) ||
      !canonicalIso(timing.validThrough) ||
      Date.parse(timing.validFrom) > Date.parse(timing.validThrough)
    ) throw new Error('Invalid attendance timing');
    return {
      kind: timing.kind,
      evidence: timing.evidence,
      validFrom: timing.validFrom,
      validThrough: timing.validThrough,
    };
  }
  throw new Error('Invalid attendance timing');
}

type BiletixTimingInput = {
  category: string;
  description: string;
  flexibleTimeEventCheck?: unknown;
  startShowDate?: unknown;
  endShowDate?: unknown;
  performanceDates: unknown[];
};

function exactInstant(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Classifies only semantics explicitly supported by the Biletix source. */
export function biletixAttendanceTiming(input: BiletixTimingInput): AttendanceTiming | undefined {
  const validFrom = exactInstant(input.startShowDate);
  const validThrough = exactInstant(input.endShowDate);
  if (
    input.flexibleTimeEventCheck === true &&
    validFrom &&
    validThrough &&
    Date.parse(validFrom) <= Date.parse(validThrough)
  ) {
    return {
      kind: 'admission_window',
      evidence: 'provider_flexible_window',
      validFrom,
      validThrough,
    };
  }
  if (input.flexibleTimeEventCheck === true)
    return { kind: 'unknown', evidence: 'insufficient_source_evidence' };

  if (!['Müze', 'Sergi'].includes(input.category)) return undefined;

  const instants = input.performanceDates
    .map(exactInstant)
    .filter((value): value is string => value !== null);
  const localDays = new Map<string, Set<string>>();
  for (const instant of instants) {
    const local = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) => local.find((item) => item.type === type)?.value ?? '';
    const day = `${part('year')}-${part('month')}-${part('day')}`;
    const times = localDays.get(day) ?? new Set<string>();
    times.add(`${part('hour')}:${part('minute')}`);
    localDays.set(day, times);
  }
  const hasMultipleTimesOnOneDay = [...localDays.values()].some((times) => times.size > 1);
  const explicitSession = /\bseans(?:lar|ı|in|iniz| saati| saatinden)?\b/iu.test(input.description);
  const explicitLateConsequence = /ge[çc]\s*kal|ge[çc] kal/iu.test(input.description);
  if (hasMultipleTimesOnOneDay && explicitSession && explicitLateConsequence) {
    return { kind: 'timed_session', evidence: 'provider_sessions_and_source_text' };
  }

  return { kind: 'unknown', evidence: 'insufficient_source_evidence' };
}
