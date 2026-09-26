import type { EventRecord } from './types.ts';

const normalizeEvidence = (value: string) =>
  value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const unsupportedFormat =
  /\b(?:atolye(?:si|de|den|ye|nin|miz(?:de)?)?|workshop|soylesi(?:si|de)?|panel(?:ist(?:ler)?)?|moderator|seminer|kurs)\b/;

export function hasSupportedEventFormat(
  event: Pick<EventRecord, 'title' | 'description'>,
) {
  const title = normalizeEvidence(event.title);
  const leadingDescription = normalizeEvidence(event.description.slice(0, 512)).slice(0, 240);
  const unsupported = leadingDescription.search(unsupportedFormat);
  const explicitPerformance = leadingDescription.search(
    /\b(?:tiyatro oyunu|stand up gosterisi|canli konser)\b/,
  );
  if (unsupported >= 0 && (explicitPerformance < 0 || unsupported < explicitPerformance))
    return false;
  if (explicitPerformance >= 0) return true;
  return !unsupportedFormat.test(title);
}
