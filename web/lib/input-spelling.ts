export type InputSpellingCandidateKind =
  | 'district'
  | 'weekday'
  | 'category'
  | 'companion'
  | 'negation';

export interface InputSpellingCandidate {
  text: string;
  normalized: string;
  kind: InputSpellingCandidateKind;
  start: number;
  end: number;
}

const fold = (value: string) =>
  value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');

const DISTRICTS = [
  'adalar', 'arnavutkoy', 'atasehir', 'avcilar', 'bagcilar',
  'bahcelievler', 'bakirkoy', 'basaksehir', 'bayrampasa', 'besiktas',
  'beykoz', 'beylikduzu', 'beyoglu', 'buyukcekmece', 'catalca',
  'cekmekoy', 'esenler', 'esenyurt', 'eyupsultan', 'fatih',
  'gaziosmanpasa', 'gungoren', 'kadikoy', 'kagithane', 'kartal',
  'kucukcekmece', 'maltepe', 'pendik', 'sancaktepe', 'sariyer',
  'silivri', 'sultanbeyli', 'sultangazi', 'sile', 'sisli', 'tuzla',
  'umraniye', 'uskudar', 'zeytinburnu',
] as const;

const WEEKDAYS = [
  'pazar', 'pazartesi', 'sali', 'carsamba', 'persembe', 'cuma',
  'cumartesi', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday',
] as const;

const LEXICON: ReadonlyArray<{
  kind: InputSpellingCandidateKind;
  normalized: string;
  aliases?: readonly string[];
}> = [
  ...DISTRICTS.map((normalized) => ({ kind: 'district' as const, normalized })),
  ...WEEKDAYS.map((normalized) => ({ kind: 'weekday' as const, normalized })),
  { kind: 'weekday', normalized: 'pazartesi', aliases: ['pzt'] },
  { kind: 'weekday', normalized: 'cumartesi', aliases: ['cmt', 'cmrtesi'] },
  { kind: 'category', normalized: 'konser', aliases: ['concert'] },
  { kind: 'category', normalized: 'tiyatro', aliases: ['theatre', 'theater'] },
  { kind: 'category', normalized: 'sergi', aliases: ['exhibition'] },
  { kind: 'category', normalized: 'atolye', aliases: ['workshop'] },
  { kind: 'companion', normalized: 'kisi', aliases: ['kisiyiz', 'people', 'person'] },
  { kind: 'companion', normalized: 'yetiskin', aliases: ['adult', 'adults'] },
  { kind: 'companion', normalized: 'cocuk', aliases: ['child', 'children', 'kids'] },
  { kind: 'companion', normalized: 'sevgilimle' },
  { kind: 'companion', normalized: 'partnerimle' },
  { kind: 'negation', normalized: 'degil', aliases: ['not', 'without'] },
  { kind: 'negation', normalized: 'istemiyorum' },
  { kind: 'negation', normalized: 'olmasin' },
];

const DISTRICT_SUFFIXES = [
  'dan', 'den', 'tan', 'ten', 'nda', 'nde', 'ya', 'ye', 'da', 'de',
  'ta', 'te', 'na', 'ne', 'a', 'e',
] as const;

function editDistance(left: string, right: string, limit: number) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let beforePrevious: number[] | null = null;
  for (let row = 1; row <= left.length; row++) {
    const current = [row];
    let smallest = row;
    for (let column = 1; column <= right.length; column++) {
      let value = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      if (
        beforePrevious && row > 1 && column > 1 &&
        left[row - 1] === right[column - 2] &&
        left[row - 2] === right[column - 1]
      ) value = Math.min(value, beforePrevious[column - 2] + 1);
      current[column] = value;
      smallest = Math.min(smallest, value);
    }
    if (smallest > limit) return limit + 1;
    beforePrevious = previous;
    previous = current;
  }
  return previous[right.length];
}

function quotedRanges(message: string) {
  return [...message.matchAll(/["“”']([^"“”']{1,160})["“”']/gu)].map((match) => ({
    start: match.index!,
    end: match.index! + match[0].length,
  }));
}

/** Return bounded spelling suggestions without rewriting the user's message. */
export function findInputSpellingCandidates(message: string): InputSpellingCandidate[] {
  if (typeof message !== 'string' || message.length > 1200) return [];
  const quoted = quotedRanges(message);
  const result: InputSpellingCandidate[] = [];
  for (const match of message.matchAll(/\p{L}[\p{L}\p{M}]*/gu)) {
    const start = match.index!, end = start + match[0].length;
    if (quoted.some((range) => start >= range.start && end <= range.end)) continue;
    const token = fold(match[0]);
    const forms = new Set([token]);
    for (const suffix of DISTRICT_SUFFIXES)
      if (token.length - suffix.length >= 4 && token.endsWith(suffix))
        forms.add(token.slice(0, -suffix.length));

    const exactKinds = new Set(
      LEXICON.filter((entry) => forms.has(entry.normalized)).map(({ kind }) => kind),
    );

    for (const entry of LEXICON) {
      if (exactKinds.has(entry.kind)) continue;
      const targets = [entry.normalized, ...(entry.aliases ?? [])];
      let matched = false;
      for (const form of forms) {
        for (const target of targets) {
          const exactAlias = form === target && target !== entry.normalized;
          const maxDistance = target.length >= 8 ? 2 : target.length >= 5 ? 1 :
            entry.kind === 'companion' ? 1 : 0;
          if (exactAlias || (form !== entry.normalized && editDistance(form, target, maxDistance) <= maxDistance)) {
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
      if (!matched) continue;
      const candidate = { text: message.slice(start, end), normalized: entry.normalized, kind: entry.kind, start, end };
      if (!result.some((item) => item.start === start && item.end === end && item.kind === entry.kind && item.normalized === entry.normalized))
        result.push(candidate);
      if (result.length >= 32) return result;
    }
  }
  return result;
}
