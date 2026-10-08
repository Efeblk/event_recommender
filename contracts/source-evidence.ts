export const SOURCE_QUARANTINE_REASONS = [
  'session_time_conflict',
  'session_availability_conflict',
  'venue_conflict',
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

const GENERIC_VENUE_TOKENS = new Set([
  'acik',
  'hava',
  'arena',
  'etkinlik',
  'gosteri',
  'istanbul',
  'kultur',
  'merkez',
  'merkezi',
  'mekan',
  'performans',
  'salon',
  'salonu',
  'sahne',
  'sahnesi',
  'sanat',
  'tiyatro',
  'tiyatrosu',
  'yer',
]);

function distinctiveVenueTokens(value: string): Set<string> {
  return new Set(
    evidenceText(value)
      .split(' ')
      .filter((token) => token.length > 1 && !GENERIC_VENUE_TOKENS.has(token)),
  );
}

function localDayMonth(startsAt: string): string | undefined {
  const instant = new Date(startsAt);
  if (!Number.isFinite(instant.getTime())) return undefined;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      day: 'numeric',
      month: 'long',
    })
      .formatToParts(instant)
      .map(({type, value}) => [type, evidenceText(value)]),
  );
  return parts.day && parts.month ? `${parts.day} ${parts.month}` : undefined;
}

/** Detects a listing whose own programme sentence assigns the exact title and
 * local date to a different named venue. Undated venue boilerplate is ignored. */
export function hasExplicitSameEventVenueConflict(input: {
  title: string;
  description: string;
  startsAt: string;
  venue: string;
  city: string;
}): boolean {
  if (evidenceText(input.city) !== 'istanbul') return false;
  const title = evidenceText(input.title);
  const description = evidenceText(input.description);
  const date = localDayMonth(input.startsAt);
  if (!title || !description || !date) return false;
  const exactTitleProgramme = new RegExp(
    `\\b${escapePattern(title)}\\b` +
      `(?:\\s+(?:konseri|gosterisi|oyunu|muzikali|etkinligi|programi))?` +
      `\\s+${escapePattern(date)}\\s+` +
      `(?:(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\\s+)?` +
      `gunu\\s+([a-z0-9]+(?:\\s+[a-z0-9]+){0,11}?)\\s*(?:nda|nde)\\b`,
  );
  const leadingTitle = evidenceText(input.title.split(/[\u201c\u201d"\u2018\u2019]/, 1)[0]);
  const titleEvidence = [title, leadingTitle].some(
    (candidate) =>
      candidate.length >= 5 &&
      candidate.split(' ').length >= 2 &&
      description.includes(candidate),
  );
  const datedCurrentProgramme = new RegExp(
    `\\b${escapePattern(date)}\\b\\s+` +
      `(?:(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)\\s+)?` +
      `(?:(?:aksami|sabah(?:i)?|ogleden\\s+sonra)\\s+)?` +
      `([a-z0-9]+(?:\\s+[a-z0-9]+){0,11}?)\\s*(?:nda|nde)\\s+` +
      `gerceklesecek\\s+bu\\s+bulusma\\b`,
  );
  const statedVenue =
    exactTitleProgramme.exec(description)?.[1] ??
    (titleEvidence ? datedCurrentProgramme.exec(description)?.[1] : undefined);
  if (!statedVenue) return false;
  const structuredTokens = distinctiveVenueTokens(input.venue);
  const statedTokens = distinctiveVenueTokens(statedVenue);
  return (
    structuredTokens.size > 0 &&
    statedTokens.size > 0 &&
    ![...structuredTokens].some((token) => statedTokens.has(token))
  );
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
  if (evidenceText(input.city) !== 'istanbul') return false;
  const description = evidenceText(input.description);
  const title = evidenceText(input.title);
  const venue = evidenceText(input.venue);
  if (!title || !venue || !description.includes(title)) return false;
  const date = localDayMonth(input.startsAt);
  if (!date) return false;
  const sameIstanbulConcertSoldOut = new RegExp(
    `\\b${escapePattern(date)}\\b(?:\\s+(?:de|da))?\\s+${escapePattern(venue)}` +
      `(?:\\s+(?:ta|te|da|de))?\\s+gerceklesecek\\s+istanbul\\s+konserinin\\s+biletleri` +
      `(?:\\s+kisa\\s+surede)?\\s+tukendi\\b`,
  );
  return sameIstanbulConcertSoldOut.test(description);
}
