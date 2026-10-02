export interface InputRange {
  start: number;
  end: number;
}

export interface InputPropositionScope {
  proposition: InputRange & { text: string };
  context: InputRange & { text: string };
  kind: 'subject' | 'quoted' | 'scope-fallback';
  coordinateSpace: 'input';
  ownership?: {
    kind: 'typed-arm' | 'operation-target' | 'operation-replacement';
    references: string[];
    operation?: 'replace' | 'remove' | 'demote';
  };
}

export interface InputPropositionSubject {
  text: string;
  start: number;
  end: number;
  scope: InputPropositionScope;
}

const closedWords = new Set([
  'concert', 'concerts', 'konser', 'konseri', 'konserler', 'event', 'events',
  'etkinlik', 'etkinlikler', 'theatre', 'theater', 'tiyatro', 'oyun', 'oyunu',
  'show', 'gosteri', 'gösteri', 'standup', 'stand-up', 'comedy', 'komedi',
  'jazz', 'caz', 'blues', 'rock', 'electronic', 'elektronik', 'rap', 'hip-hop',
  'classical', 'klasik', 'drama', 'please', 'lutfen', 'lütfen',
  'ok', 'okay', 'olur',
]);

const fold = (text: string) => text.toLocaleLowerCase('tr-TR').normalize('NFD')
  .replace(/[\u0300-\u036f]/gu, '').replace(/ı/gu, 'i');

function trimRange(input: string, range: InputRange): InputRange {
  let { start, end } = range;
  while (start < end && /[\s,;:!?()[\]{}]/u.test(input[start])) start++;
  while (end > start && /[\s,;:!?()[\]{}.]/u.test(input[end - 1])) end--;
  return { start, end };
}

function overlaps(range: InputRange, excluded: readonly InputRange[]) {
  return excluded.some((item) => range.start < item.end && item.start < range.end);
}

/** Sentence punctuation scanner that leaves titles, apostrophes and numeric dots inert. */
function propositions(input: string): InputRange[] {
  const result: InputRange[] = [];
  let start = 0;
  let quote: string | null = null;
  let escaped = false;
  const closing: Record<string, string> = { '“': '”', '‘': '’' };
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\' && quote) { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === '“' || character === '‘' ||
        (character === "'" && !/[\p{L}\p{N}]/u.test(input[index - 1] ?? ''))) {
      quote = closing[character] ?? character;
      continue;
    }
    const numericDot = character === '.' && /\d/u.test(input[index - 1] ?? '') &&
      /\d/u.test(input[index + 1] ?? '');
    if ((/[;!?\n]/u.test(character) || (character === '.' && !numericDot))) {
      const range = trimRange(input, { start, end: index });
      if (range.end > range.start) result.push(range);
      start = index + 1;
    }
  }
  const range = trimRange(input, { start, end: input.length });
  if (range.end > range.start) result.push(range);
  return result;
}

function quoteSubjects(input: string): Array<{ subject: InputRange; full: InputRange }> {
  const result: Array<{ subject: InputRange; full: InputRange }> = [];
  const closing: Record<string, string> = { '“': '”', '‘': '’' };
  for (let start = 0; start < input.length; start++) {
    const opener = input[start];
    if (opener !== '"' && opener !== '“' && opener !== '‘' && opener !== "'") continue;
    // A straight apostrophe surrounded by word characters is an apostrophe.
    if (opener === "'" && /[\p{L}\p{N}]/u.test(input[start - 1] ?? '')) continue;
    const expected = closing[opener] ?? opener;
    let escaped = false;
    for (let end = start + 1; end < input.length; end++) {
      if (escaped) { escaped = false; continue; }
      if (input[end] === '\\') { escaped = true; continue; }
      if (input[end] !== expected) continue;
      if (end > start + 1 && end - start <= 161)
        result.push({ subject: { start: start + 1, end }, full: { start, end: end + 1 } });
      start = end;
      break;
    }
  }
  return result;
}

function edgeSubject(input: string, proposition: InputRange): InputRange | null {
  let range = trimRange(input, proposition);
  const original = input.slice(range.start, range.end);
  const patterns: RegExp[] = [
    /^(?:i\s+(?:want|would like|need)|we\s+(?:want|would like|need)|want|would like|need|looking for|search for|find|show me|recommend(?: me)?|please)\s+/iu,
    /^(?:(?:a|an|bir|bana|bize|lütfen|lutfen|preferably|ideally|maybe more)\s+)+/iu,
    /^(?:(?:show|event|etkinlik|oyun)\s+(?:called|titled|named|yazan)\s+)+/iu,
    /^(?:(?:and|or|ve|veya|ya da)\s+)+/iu,
    /^(?:lira(?:ya)?|tl|try)\s+/iu,
    /\s+(?:arıyorum|ariyorum|bakıyorum|bakiyorum|bakıyom|bakiyom|istiyorum|isterim|bul(?:ur musun)?|göster|goster|öner|oner|please)$/iu,
    /\s+(?:bakalım|bakalim|tercih ederim|tercih ediyorum)\s*$/iu,
    /\s+(?:is\s+)?(?:mandatory|required|zorunlu|şart|sart)\s*$/iu,
    /\s+(?:konser(?:i|ler)?|concerts?|etkinlik(?:ler)?|events?|tiyatro|theatre|theater|oyun(?:u|lar)?|show|gösteri|gosteri)\s*$/iu,
    /\s+(?:olsun|olabilir|could be|maybe)\s*$/iu,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    const text = input.slice(range.start, range.end);
    for (const pattern of patterns) {
      const match = pattern.exec(text);
      if (!match) continue;
      if (/\b(?:not required|şart değil|sart degil)\b/iu.test(text) &&
          /(?:required|şart|sart)/iu.test(match[0])) continue;
      if (/\b(?:or|veya|ya da)\b/iu.test(text) &&
          /^(?:\s+)(?:konser|concert|events?|etkinlik|theatre|theater|tiyatro|oyun|show)/iu.test(match[0])) continue;
      if (match.index === 0) range.start += match[0].length;
      else range.end = range.start + match.index;
      range = trimRange(input, range);
      changed = true;
      break;
    }
  }
  let text = input.slice(range.start, range.end);
  const replacement = /\b(?:not required|şart değil|sart degil)\b/iu.test(text)
    ? null
    : /^.+?\s+(?:değil|degil|not)\s+(.+)$/iu.exec(text);
  if (replacement?.[1]) {
    range.start += replacement.index + replacement[0].lastIndexOf(replacement[1]);
    text = input.slice(range.start, range.end);
  }
  let match = /^(.*?)(?:\s+ile|yla|yle|la|le)\s+ilgili(?:\s+bir)?$/iu.exec(text);
  if (match?.[1]) range.end = range.start + match[1].length;
  text = input.slice(range.start, range.end);
  match = /^(.*?)(?:\s+ile|yla|yle|la|le)\s+ilgili(?:\s+bir)?\s+(?:etkinlik|aktivite|event|şey|sey|thing)(?:\s+arıyorum|\s+ariyorum)?$/iu.exec(text);
  if (match?.[1]) range.end = range.start + match[1].length;
  text = input.slice(range.start, range.end);
  match = /^(.*?)(?:[-\s]+related)?\s+(?:event|events)(?:\s+(?:please|would be nice))?$/iu.exec(text);
  if (match?.[1]) range.end = range.start + match[1].length;
  text = input.slice(range.start, range.end);
  match = /^(?:(?:a|an|bir)\s+)?(.+?)(?:\s+(?:would be nice|could be nice|olsa güzel olur|olsa guzel olur|olsa iyi olur))(?:\s*,?\s*(?:but|ama)\s+(?:it\s+is\s+)?(?:not required|required değil|şart değil|sart degil))?$/iu.exec(text);
  if (match?.[1]) {
    range.start += match.index + match[0].indexOf(match[1]);
    range.end = range.start + match[1].length;
  }
  range = trimRange(input, range);
  if (range.end <= range.start || !/\p{L}/u.test(input.slice(range.start, range.end))) return null;
  // A clause made solely from closed fields and request glue has no open topic.
  const tokens = fold(input.slice(range.start, range.end)).match(/[\p{L}\p{N}-]+/gu) ?? [];
  const glue = new Set(['a', 'an', 'bir', 'or', 'veya', 'ya', 'da', 'and', 've', 'olsun', 'required', 'must', 'not', 'degil']);
  if (tokens.length && tokens.every((token) => closedWords.has(token) || glue.has(token))) return null;
  if (/^(?:kişi başı|kisi basi|per person|each)?\s*(?:en fazla|en az|at most|at least|under|over|up to|toplam|total)?$/iu.test(input.slice(range.start, range.end)) ||
      /^(?:en yakın tarih|en yakin tarih|yakın tarih|yakin tarih|soonest|earliest|next available date)$/iu.test(input.slice(range.start, range.end)) ||
      /^(?:(?:a|an|bir)\s+)?(?:(?:show|event|etkinlik|oyun)\s+)?(?:called|titled|named|yazan)(?:\s+bir)?$/iu.test(input.slice(range.start, range.end))) return null;
  void original;
  return range;
}

function clauses(input: string, proposition: InputRange, protectedRanges: readonly InputRange[]): InputRange[] {
  const result: InputRange[] = [];
  const boundaries: number[] = [];
  let start = proposition.start;
  for (let index = proposition.start; index < proposition.end; index++) {
    if (input[index] !== ',') continue;
    if (protectedRanges.some((range) => index >= range.start && index < range.end)) continue;
    if (/\d/u.test(input[index - 1] ?? '') && /\d/u.test(input[index + 1] ?? '')) continue;
    if (/^\s*(?:but|ama)\b/iu.test(input.slice(index + 1, proposition.end))) continue;
    boundaries.push(index);
  }
  const text = input.slice(proposition.start, proposition.end);
  for (const match of text.matchAll(/\b(?:and|ve|but|ama|ancak|fakat)\b/giu)) {
    const index = proposition.start + match.index!;
    if (protectedRanges.some((range) => index >= range.start && index < range.end)) continue;
    const left = input.slice(proposition.start, index);
    const right = input.slice(index + match[0].length, proposition.end);
    if (/^\s*(?:it\s+is\s+)?(?:not required|required değil|şart değil|sart degil)\b/iu.test(right)) continue;
    const leftScoped = /\b(?:required|mandatory|must|zorunlu|şart|sart|optional|prefer(?:red)?|tercih|want|istiyorum|arıyorum|ariyorum)\b/iu.test(left);
    const rightScoped = /\b(?:would be nice|could be nice|optional|prefer(?:red|ably)?|mandatory|required|must|olsa (?:güzel|guzel|iyi)|zorunlu|şart|sart)\b/iu.test(right);
    if (leftScoped && rightScoped) boundaries.push(index);
  }
  // Users often omit both punctuation and a conjunction between a completed
  // request/role predicate and a separately scoped wish.
  for (const match of text.matchAll(/\b(?:required|mandatory|zorunlu|istiyorum|arıyorum|ariyorum)\b/giu)) {
    const boundary = proposition.start + match.index! + match[0].length;
    const right = input.slice(boundary, proposition.end);
    if (/^\s+\p{L}[\s\S]{0,100}\b(?:would be nice|could be nice|optional|preferred|olsa (?:güzel|guzel|iyi)|zorunlu|required|mandatory)\b/iu.test(right))
      boundaries.push(boundary);
  }
  for (const match of text.matchAll(/\b(?:i|we)\s+(?:want|would like)\b/giu)) {
    if (match.index === 0) continue;
    const boundary = proposition.start + match.index!;
    const right = input.slice(boundary, proposition.end);
    if (/\b(?:would be nice|could be nice|optional|preferred|olsa (?:güzel|guzel|iyi)|required|mandatory)\b/iu.test(right))
      boundaries.push(boundary);
  }
  boundaries.sort((a, b) => a - b);
  for (const boundary of boundaries) {
    const range = trimRange(input, { start, end: boundary });
    if (range.end > range.start) result.push(range);
    const connector = /^(?:and|ve|but|ama|ancak|fakat)\b/iu.exec(input.slice(boundary));
    start = boundary + (connector?.[0].length ?? 1);
  }
  const range = trimRange(input, { start, end: proposition.end });
  if (range.end > range.start) result.push(range);
  return result;
}

function visibleFragments(input: string, clause: InputRange, excluded: readonly InputRange[]) {
  const cuts = excluded.filter((range) => range.start < clause.end && clause.start < range.end)
    .map((range) => ({ start: Math.max(clause.start, range.start), end: Math.min(clause.end, range.end) }))
    .sort((a, b) => a.start - b.start);
  const result: InputRange[] = [];
  let start = clause.start;
  for (const cut of cuts) {
    const range = trimRange(input, { start, end: cut.start });
    if (range.end > range.start) result.push(range);
    start = Math.max(start, cut.end);
  }
  const range = trimRange(input, { start, end: clause.end });
  if (range.end > range.start) result.push(range);
  return result;
}

function scope(input: string, proposition: InputRange, context: InputRange, kind: InputPropositionScope['kind']): InputPropositionScope {
  return {
    proposition: { ...proposition, text: input.slice(proposition.start, proposition.end) },
    context: { ...context, text: input.slice(context.start, context.end) },
    kind,
    coordinateSpace: 'input',
  };
}

function isMixedClosedAlternative(text: string) {
  if (!/\b(?:or|veya|ya da)\b/iu.test(text)) return false;
  const arms = text.split(/\b(?:or|veya|ya da)\b/iu).map((arm) =>
    fold(arm).match(/[\p{L}\p{N}-]+/gu) ?? []);
  const closed = arms.map((tokens) => tokens.length > 0 && tokens.every((token) =>
    closedWords.has(token) || ['a', 'an', 'bir'].includes(token)));
  return closed.some(Boolean) && closed.some((value) => !value);
}

function captureRange(input: string, base: number, whole: string, capture: string, from = 0): InputRange {
  const offset = whole.indexOf(capture, from);
  return trimRange(input, { start: base + offset, end: base + offset + capture.length });
}

function operationAtoms(input: string, proposition: InputRange) {
  const text = input.slice(proposition.start, proposition.end);
  if (/\bLITERAL[A-Z0-9_]*\b/u.test(text) || quoteSubjects(text).length) return [];
  const replace = /^(?:replace\s+(.+?)\s+with\s+(.+)|(.+?)\s+(?:yerine|değil|degil)\s+(.+))$/iu.exec(text);
  if (replace) {
    const targetText = replace[1] ?? replace[3], replacementText = replace[2] ?? replace[4];
    const target = captureRange(input, proposition.start, text, targetText);
    const replacement = captureRange(input, proposition.start, text, replacementText, target.end - proposition.start);
    return [
      { range: target, kind: 'operation-target' as const, operation: 'replace' as const },
      { range: replacement, kind: 'operation-replacement' as const, operation: 'replace' as const },
    ];
  }
  const remove = /^(?:remove|drop|exclude|kaldır|kaldir|çıkar|cikar)\s+(.+)$/iu.exec(text);
  if (remove) return [{ range: captureRange(input, proposition.start, text, remove[1]), kind: 'operation-target' as const, operation: 'remove' as const }];
  const demotePrefix = /^(?:make|mark)\s+(.+?)\s+(?:optional|a preference)$/iu.exec(text);
  if (demotePrefix) return [{ range: captureRange(input, proposition.start, text, demotePrefix[1]), kind: 'operation-target' as const, operation: 'demote' as const }];
  const demoteSuffix = /^(.+?)\s+(?:optional|opsiyonel|isteğe bağlı)(?:\s+olsun)?$/iu.exec(text);
  if (demoteSuffix) return [{ range: captureRange(input, proposition.start, text, demoteSuffix[1]), kind: 'operation-target' as const, operation: 'demote' as const }];
  const turkishDemote = /^(.+?)\s+şart\s+olmasın\s*,\s*sadece\s+tercih\s+olarak\s+kalsın$/iu.exec(text);
  if (turkishDemote) return [{ range: captureRange(input, proposition.start, text, turkishDemote[1]), kind: 'operation-target' as const, operation: 'demote' as const }];
  return [];
}

function typedArm(text: string) {
  const normalized = fold(text);
  const requirements = /\b(?:and|or|ve|veya|ya da|but|ama)\b/iu.test(text) ? []
    : deriveRequirements(text, []).filter((item) => !item.value.includes('|'));
  if (requirements.length === 1)
    return `req_${requirements[0].kind}_${requirements[0].value}`;
  if (/^(?:a |an |bir )?(?:wheelchair(?:[- ]accessible| access)?|step[- ]free(?: access| entry)?|accessible toilet|tekerlekli sandalye(?: erisimi)?|erisilebilir tuvalet|basamaksiz(?: erisim)?)(?: (?:is|are|olsun))?(?: required| mandatory| zorunlu| sart)?$/u.test(normalized)) return 'req_accessibility';
  const tokens = normalized.match(/[\p{L}\p{N}-]+/gu) ?? [];
  const framing = new Set(['a', 'an', 'bir', 'is', 'are', 'olsun', 'optional', 'required', 'mandatory', 'zorunlu', 'sart', 'tercihen', 'would', 'be', 'nice', 'ariyorum', 'istiyorum', 'please', 'istemiyorum', 'avoid', 'exclude', 'without', 'no', 'olmayan', 'disi', 'toplam', 'total', 'lira', 'liraya', 'tl', 'try', 'bakalim']);
  const meaningful = tokens.filter((token) => !framing.has(token) && !/^\d+(?:[.,]\d+)?$/u.test(token));
  if (!meaningful.length || !meaningful.every((token) => closedWords.has(token))) return null;
  const categoryIds = new Map([
    ['concert', 'concert'], ['concerts', 'concert'], ['konser', 'concert'], ['konseri', 'concert'], ['konserler', 'concert'],
    ['theatre', 'theatre'], ['theater', 'theatre'], ['tiyatro', 'theatre'], ['oyun', 'theatre'], ['oyunu', 'theatre'],
    ['standup', 'standup'], ['stand-up', 'standup'], ['comedy', 'standup'], ['komedi', 'standup'],
  ]);
  const ids = [...new Set(meaningful.map((token) => categoryIds.get(token)).filter((value): value is string => Boolean(value)))];
  return ids.length === 1 ? `category_${ids[0]}` : ids.length > 1 ? 'category_closed' : null;
}

const exactNegativeCategoryResidue = (text: string) =>
  /^(?:gidebileceğim|gidebilecegim|gideceğim|gidecegim)\s+(?:etkinlik\s+)?(?:concert|konser)\s+(?:dışı|disi|olmayan)(?:\s+etkinlik)?$/iu.test(text.trim()) ||
  /^(?:gidebileceğim|gidebilecegim|gideceğim|gidecegim)\s+(?:etkinlik\s+)?(?:konser|tiyatro)(?:\s+veya\s+(?:konser|tiyatro))+\s+olmasın$/iu.test(text.trim());

function ownedGrammarFragment(
  input: string,
  fragment: InputRange,
  clause: InputRange,
  excluded: readonly InputRange[],
) {
  const text = input.slice(fragment.start, fragment.end).trim();
  if (/^(?:olan|bir\s+de\s+kesin|de\s+kesin|diğerleri\s+aynı|digerleri\s+ayni)$/iu.test(text)) return true;
  if (!/^(?:kişi\s+başı|kisi\s+basi|per person|each)\s+(?:maks|max|maksimum|maximum|en\s+(?:fazla|çok|cok)|at most|up to|under|below)$/iu.test(text)) return false;
  return excluded.some((range) => range.start >= fragment.end && range.start < clause.end &&
    /^\s*$/u.test(input.slice(fragment.end, range.start)));
}

const typedBudgetCorrection = (text: string) =>
  /^(?:pardon\s+)?(?:toplam|kişi\s+başı|kisi\s+basi)\s+(?:değil|degil)\s+(?:toplam|kişi\s+başı|kisi\s+basi)\s+\d[\d.,]*(?:\s*(?:tl|try|lira))?\s+demek\s+istemiştim$/iu.test(text.trim());

function conjunctionAtoms(input: string, clause: InputRange) {
  const text = input.slice(clause.start, clause.end);
  const matches = [...text.matchAll(/\b(?:and|ve|or|veya|ya da)\b/giu)];
  if (matches.length !== 1) return null;
  const connector = fold(matches[0][0]);
  const boundary = clause.start + matches[0].index!;
  const left = trimRange(input, { start: clause.start, end: boundary });
  const right = trimRange(input, { start: boundary + matches[0][0].length, end: clause.end });
  const arms = [left, right].map((range) => ({ range, typed: typedArm(input.slice(range.start, range.end)) }));
  if (!arms.some(({ typed }) => typed)) return null;
  return { connector, arms };
}

function coordinatedBothAtoms(input: string, proposition: InputRange): InputRange[] {
  const text = input.slice(proposition.start, proposition.end);
  const english = /\bboth\s+([\p{L}\p{N}][\p{L}\p{N}'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’-]*){0,3})\s+and\s+([\p{L}\p{N}][\p{L}\p{N}'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’-]*){0,3})$/iu.exec(text);
  if (english) {
    const first = captureRange(input, proposition.start, text, english[1]);
    return [first, captureRange(input, proposition.start, text, english[2], first.end - proposition.start)];
  }
  const turkish = /\bhem\s+([\p{L}\p{N}][\p{L}\p{N}'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’-]*){0,3})\s+hem(?:\s+de)?\s+([\p{L}\p{N}][\p{L}\p{N}'’-]*(?:\s+[\p{L}\p{N}][\p{L}\p{N}'’-]*){0,3})$/iu.exec(text);
  if (!turkish) return [];
  const first = captureRange(input, proposition.start, text, turkish[1]);
  return [first, captureRange(input, proposition.start, text, turkish[2], first.end - proposition.start)];
}

export function harvestInputPropositions(
  input: string,
  excluded: readonly InputRange[] = [],
): InputPropositionSubject[] {
  const result: InputPropositionSubject[] = [];
  const quoted = quoteSubjects(input);
  const literalRanges = [...input.matchAll(/\bLITERAL[A-Z0-9_]*\b/g)].map((match) => ({
    start: match.index!, end: match.index! + match[0].length,
  }));
  for (const { subject } of quoted) {
    const proposition = propositions(input).find((item) => subject.start >= item.start && subject.end <= item.end) ?? subject;
    result.push({ ...subject, text: input.slice(subject.start, subject.end), scope: scope(input, proposition, proposition, 'quoted') });
  }
  for (const subject of literalRanges) {
    const proposition = propositions(input).find((item) => subject.start >= item.start && subject.end <= item.end) ?? subject;
    result.push({ ...subject, text: input.slice(subject.start, subject.end), scope: scope(input, proposition, proposition, 'quoted') });
  }
  for (const proposition of propositions(input)) {
    if (typedBudgetCorrection(input.slice(proposition.start, proposition.end))) continue;
    const operations = operationAtoms(input, proposition);
    if (operations.length) {
      for (const atom of operations) {
        const text = input.slice(atom.range.start, atom.range.end);
        result.push({ ...atom.range, text, scope: {
          ...scope(input, proposition, proposition, 'subject'),
          ownership: { kind: atom.kind, references: [], operation: atom.operation },
        } });
      }
      continue;
    }
    const both = coordinatedBothAtoms(input, proposition);
    if (both.length) {
      for (const subject of both) {
        const text = input.slice(subject.start, subject.end);
        if (typedArm(text)) continue;
        result.push({ ...subject, text, scope: scope(input, proposition, proposition, 'subject') });
      }
      continue;
    }
    const protectedRanges = [
      ...quoted.map(({ full }) => full),
      ...literalRanges,
    ].filter((range) => range.start < proposition.end && proposition.start < range.end);
    for (const clause of clauses(input, proposition, protectedRanges)) {
      const clauseText = input.slice(clause.start, clause.end);
      if (exactNegativeCategoryResidue(clauseText)) continue;
      const ownedClause = typedArm(clauseText);
      if (ownedClause?.startsWith('category_')) {
        const optional = /\b(?:would be nice|could be nice|optional|prefer(?:red|ably)?|tercihen|olsa (?:güzel|guzel|iyi))\b/iu.test(clauseText);
        if (optional) {
          const category = /\b(?:concerts?|konser(?:i|ler)?|theatre|theater|tiyatro|oyun|show|stand[ -]?up|comedy|komedi|jazz|caz|blues|rock|electronic|elektronik|rap|hip[ -]?hop|classical|klasik|drama)\b/iu.exec(clauseText);
          if (category) {
            const subject = { start: clause.start + category.index, end: clause.start + category.index + category[0].length };
            result.push({ ...subject, text: input.slice(subject.start, subject.end), scope: {
              ...scope(input, proposition, proposition, 'subject'),
              ownership: { kind: 'typed-arm', references: [ownedClause] },
            } });
          }
        }
        continue;
      }
      if (ownedClause) {
        const subject = edgeSubject(input, clause) ?? trimRange(input, clause);
        if (subject.end > subject.start) {
          result.push({ ...subject, text: input.slice(subject.start, subject.end), scope: {
            ...scope(input, proposition, proposition, 'subject'),
            ownership: { kind: 'typed-arm', references: [ownedClause] },
          } });
        }
        continue;
      }
      const conjunction = conjunctionAtoms(input, clause);
      if (conjunction) {
        if (conjunction.arms.every((atom) => atom.typed)) continue;
        if (conjunction.connector === 'or' || conjunction.connector === 'veya' || conjunction.connector === 'ya da') {
          const visible = trimRange(input, clause), text = input.slice(visible.start, visible.end);
          result.push({ ...visible, text, scope: scope(input, proposition, proposition, 'scope-fallback') });
        } else {
          for (const atom of conjunction.arms) {
            if (atom.typed) continue;
            const subject = edgeSubject(input, atom.range);
            if (!subject) continue;
            const text = input.slice(subject.start, subject.end);
            result.push({ ...subject, text, scope: scope(input, proposition, proposition, 'subject') });
          }
        }
        continue;
      }
      let emitted = false;
      for (const fragment of visibleFragments(input, clause, [...excluded, ...protectedRanges])) {
        if (ownedGrammarFragment(input, fragment, clause, excluded)) continue;
        if (exactNegativeCategoryResidue(input.slice(fragment.start, fragment.end))) continue;
        const subject = edgeSubject(input, fragment);
        if (!subject || overlaps(subject, excluded) || subject.end - subject.start > 160) continue;
        const text = input.slice(subject.start, subject.end);
        const coordinatedProtected = protectedRanges.length > 0 && /\b(?:or|veya|ya da)\b/iu.test(input.slice(proposition.start, proposition.end));
        const scalarWrapper = /^(?:kişi başı|kisi basi|per person|each)(?!\p{L})/iu.test(text);
        result.push({ ...subject, text, scope: scope(input, proposition, proposition, coordinatedProtected || scalarWrapper || isMixedClosedAlternative(text) ? 'scope-fallback' : 'subject') });
        emitted = true;
      }
      if (emitted) continue;
      const visible = trimRange(input, clause);
      const text = input.slice(visible.start, visible.end);
      if (/^(?:it\s+has\s+to\s+be|both\s+of\s+them|ikisi\s+de)$/iu.test(text)) continue;
      const hasUnexcludedWord = [...text.matchAll(/\p{L}+/gu)].some((match) =>
        !overlaps({ start: visible.start + match.index!, end: visible.start + match.index! + match[0].length }, excluded));
      const tokens = fold(text).match(/[\p{L}\p{N}-]+/gu) ?? [];
      const needsFallback = /\b(?:required|must|need(?:ed)?|zorunlu|şart|sart|mecbur|accessible|erişim|erisim|without|except|hariç|haric|başlamasın|baslamasin|bitmesin)\b/iu.test(text);
      if (hasUnexcludedWord && needsFallback && text.length <= 160 &&
          !tokens.every((token) => closedWords.has(token) || ['a', 'an', 'bir', 'or', 'veya', 'and', 've', 'please'].includes(token))) {
        result.push({ ...visible, text, scope: scope(input, proposition, proposition, 'scope-fallback') });
      }
    }
  }
  return result;
}
import { deriveRequirements } from './requirements.ts';
