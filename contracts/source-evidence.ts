export const SOURCE_QUARANTINE_REASONS = [
  'session_time_conflict',
  'session_availability_conflict',
] as const;

export type SourceQuarantineReason = (typeof SOURCE_QUARANTINE_REASONS)[number];

export function isSourceQuarantineReason(value: unknown): value is SourceQuarantineReason {
  return SOURCE_QUARANTINE_REASONS.includes(value as SourceQuarantineReason);
}

function evidenceText(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Detects only an available Istanbul listing whose own text says that the
 * concert on its local date and at its venue will take place and sold out. */
export function hasExplicitSameEventSoldOutConflict(input: {
  title: string;
  description: string;
  startsAt: string;
  venue: string;
  city: string;
  availability: string;
}): boolean {
  if (input.availability !== 'available') return false;
  const instant = new Date(input.startsAt);
  if (!Number.isFinite(instant.getTime())) return false;
  if (evidenceText(input.city) !== 'istanbul') return false;
  const description = evidenceText(input.description);
  const title = evidenceText(input.title);
  const venue = evidenceText(input.venue);
  if (!title || !venue || !description.includes(title)) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      day: 'numeric',
      month: 'long',
    })
      .formatToParts(instant)
      .map(({type, value}) => [type, evidenceText(value)]),
  );
  if (!parts.day || !parts.month) return false;
  const date = `${parts.day} ${parts.month}`;
  const sameIstanbulConcertSoldOut = new RegExp(
    `\\b${escapePattern(date)}\\b(?:\\s+(?:de|da))?\\s+${escapePattern(venue)}` +
      `(?:\\s+(?:ta|te|da|de))?\\s+gerceklesecek\\s+istanbul\\s+konserinin\\s+biletleri` +
      `(?:\\s+kisa\\s+surede)?\\s+tukendi\\b`,
  );
  return sameIstanbulConcertSoldOut.test(description);
}
