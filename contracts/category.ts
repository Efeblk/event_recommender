export const CATEGORIES = [
  'Konser', 'Tiyatro', 'Stand-up', 'Sinema', 'Sergi', 'Müze', 'Spor',
  'Söyleşi', 'Eğitim', 'Workshop', 'Festival', 'Dans', 'Gösteri', 'Gezi', 'Diğer',
] as const;
export type Category = (typeof CATEGORIES)[number];

const normalizeEvidence = (value: string) => value.toLocaleLowerCase('tr-TR')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i')
  .replace(/[^a-z0-9]+/g, ' ').trim();

/** Maps provider taxonomy labels without deciding whether a specific event fits. */
export function categoryFromSource(label: string): Category | null {
  const text = normalizeEvidence(label);
  const formats: [RegExp, Category][] = [
    [/\b(?:stand up|standup)\b/, 'Stand-up'],
    [/\b(?:atolye\w*|workshop\w*)\b/, 'Workshop'],
    [/\b(?:tiyatro|theatre|theater|musical|muzikal)\b/, 'Tiyatro'],
    [/\b(?:sinema|film|cinema)\b/, 'Sinema'], [/\b(?:sergi|exhibition)\b/, 'Sergi'],
    [/\b(?:muze|museum)\b/, 'Müze'],
    [/\b(?:spor|sport|sports|basketbol|basketball|futbol|football|tenis|voleybol)\b/, 'Spor'],
    [/\b(?:soylesi|seminer|konferans|panel|talk|conference)\b/, 'Söyleşi'],
    [/\b(?:egitim|mebonayliegitim|kurs|education|course)\b/, 'Eğitim'],
    [/\b(?:konser|muzik|music|pop|rock|jazz|caz|klasik|rap|hiphop|party)\b/, 'Konser'],
    [/\b(?:festival)\b/, 'Festival'], [/\b(?:bale|dans|dance)\b/, 'Dans'],
    [/\b(?:opera|gosteri|sirk|show|circus|sahne sanatlari)\b/, 'Gösteri'],
    [/\b(?:gezi|tur|tour)\b/, 'Gezi'],
  ];
  return formats.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

function explicitProgramFormat(event: {title: string; description: string}): Category | null {
  const title = normalizeEvidence(event.title);
  const leading = normalizeEvidence(event.description.slice(0, 512)).slice(0, 240);
  const performance = leading.search(/\b(?:tiyatro oyunu|stand up gosterisi|canli konser)\b/);
  const workshopTerm = /\b(?:atolye(?:si|de|den|ye|nin|miz(?:de)?)?|workshop)\b/;
  const participation = /\b(?:katilimci|katilimcilar|egitmen|ogren|uretir|uretecek|yapacak|tasarla|uygulama|malzeme|kontenjan|kayit)\w*\b/;
  const workshopMatch = workshopTerm.exec(leading);
  const workshop = workshopMatch && participation.test(leading.slice(Math.max(0, workshopMatch.index - 80), workshopMatch.index + workshopMatch[0].length + 120)) ? workshopMatch.index : -1;
  const talk = leading.search(/\b(?:soylesi(?:si|de)?|panel(?:ist(?:ler)?)?|moderator|seminer)\b/);
  const instruction = leading.search(/\b(?:kurs|egitim programi)\b/);
  const first = ([[workshop, 'Workshop'], [talk, 'Söyleşi'], [instruction, 'Eğitim']] as [number, Category][])
    .filter(([index]) => index >= 0 && (performance < 0 || index < performance)).sort((a, b) => a[0] - b[0])[0];
  if (first) return first[1];
  if (/\b(?:konser(?:i)?|concert)\b/.test(title)) return 'Konser';
  if (/\b(?:tiyatro oyunu|cocuk oyunu|muzikal(?:i)?|theatre play|theater play)\b/.test(title)) return 'Tiyatro';
  if (performance >= 0) return null;
  if (/\b(?:atolye(?:si|leri)?|workshop)\b/.test(title)) return 'Workshop';
  if (/\b(?:soylesi(?:si)?|seminer|konferans)\b/.test(title)) return 'Söyleşi';
  return null;
}

export function categoryForEvent(sourceLabel: string, title: string, description: string): Category {
  return explicitProgramFormat({ title, description }) ?? categoryFromSource(sourceLabel)
    ?? (CATEGORIES.includes(sourceLabel as Category) ? sourceLabel as Category : 'Diğer');
}
