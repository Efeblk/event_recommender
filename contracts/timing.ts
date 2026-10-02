export type AttendanceTiming =
  | {kind: 'timed_session'; evidence: 'provider_sessions_and_source_text'}
  | {kind: 'unknown'; evidence: 'insufficient_source_evidence'}
  | {kind: 'admission_window'; evidence: 'provider_flexible_window'; validFrom: string; validThrough: string};

const exactKeys = (value: Record<string, unknown>, expected: string[]) => {
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const canonicalIso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;

/** Strictly validates untrusted persisted timing metadata. */
export function parseAttendanceTiming(value: unknown): AttendanceTiming | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid attendance timing');
  const timing = value as Record<string, unknown>;
  if (timing.kind === 'timed_session' && exactKeys(timing, ['kind', 'evidence']) && timing.evidence === 'provider_sessions_and_source_text')
    return { kind: timing.kind, evidence: timing.evidence };
  if (timing.kind === 'unknown' && exactKeys(timing, ['kind', 'evidence']) && timing.evidence === 'insufficient_source_evidence')
    return { kind: timing.kind, evidence: timing.evidence };
  if (timing.kind === 'admission_window' && exactKeys(timing, ['kind', 'evidence', 'validFrom', 'validThrough']) && timing.evidence === 'provider_flexible_window' && canonicalIso(timing.validFrom) && canonicalIso(timing.validThrough) && Date.parse(timing.validFrom) <= Date.parse(timing.validThrough))
    return { kind: timing.kind, evidence: timing.evidence, validFrom: timing.validFrom, validThrough: timing.validThrough };
  throw new Error('Invalid attendance timing');
}

function exactInstant(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/** Classifies only timing semantics explicitly supported by Biletix. */
export function biletixAttendanceTiming(input: {
  category: string; description: string; flexibleTimeEventCheck?: unknown;
  startShowDate?: unknown; endShowDate?: unknown; performanceDates: unknown[];
}): AttendanceTiming | undefined {
  const validFrom = exactInstant(input.startShowDate), validThrough = exactInstant(input.endShowDate);
  if (input.flexibleTimeEventCheck === true && validFrom && validThrough && Date.parse(validFrom) <= Date.parse(validThrough))
    return { kind: 'admission_window', evidence: 'provider_flexible_window', validFrom, validThrough };
  if (input.flexibleTimeEventCheck === true) return { kind: 'unknown', evidence: 'insufficient_source_evidence' };
  if (!['Müze', 'Sergi'].includes(input.category)) return undefined;
  const instants = input.performanceDates.map(exactInstant).filter((value): value is string => value !== null);
  const localDays = new Map<string, Set<string>>();
  for (const instant of instants) {
    const local = new Intl.DateTimeFormat('en-CA', {timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) => local.find((item) => item.type === type)?.value ?? '';
    const day = `${part('year')}-${part('month')}-${part('day')}`, times = localDays.get(day) ?? new Set<string>();
    times.add(`${part('hour')}:${part('minute')}`); localDays.set(day, times);
  }
  const explicitSession = /\bseans(?:lar|ı|in|iniz| saati| saatinden)?\b/iu.test(input.description);
  const explicitLateConsequence = /ge[çc]\s*kal|ge[çc] kal/iu.test(input.description);
  if ([...localDays.values()].some((times) => times.size > 1) && explicitSession && explicitLateConsequence)
    return { kind: 'timed_session', evidence: 'provider_sessions_and_source_text' };
  return { kind: 'unknown', evidence: 'insufficient_source_evidence' };
}
