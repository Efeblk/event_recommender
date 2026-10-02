import type { IntentState } from './input-state.ts';

export interface LiteralTitle {
  /** Opaque identifier safe to send to the interpreter. */
  token: string;
  /** Local-only literal; never serialize this mapping into the model request. */
  value: string;
}

export interface MaskedLiteralTitles {
  text: string;
  literals: LiteralTitle[];
}

type TokenPrefix = 'current' | 'pending';

function alphabeticIndex(index: number): string {
  let result = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26))
    result = String.fromCharCode(65 + ((value - 1) % 26)) + result;
  return result;
}

function fold(text: string): string {
  return text
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\u0131/g, 'i');
}

function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === '\\'; cursor--)
    slashes++;
  return slashes % 2 === 1;
}

function wordCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}\p{M}]/u.test(value);
}

function titleFraming(before: string, after: string): boolean {
  const prefix = fold(before);
  const suffix = fold(after);
  return (
    /\b(?:titled|called|named|adi|adli|ismi|isimli|baslikli)(?:\s+(?:bir|a|an))?\s*:?\s*$/u.test(
      prefix,
    ) ||
    /^\s*(?:adli|isimli|baslikli)\b/u.test(suffix) ||
    /^\s*yazan\s+(?:(?:bir|tiyatro)\s+)*(?:oyunu|oyun|gosterisi|gosteri|etkinlik|show|play|event)\b/u.test(
      suffix,
    )
  );
}

/**
 * Isolate explicitly framed, paired quoted titles before harvesting candidates.
 * Ordinary quoted constraints remain visible. The returned literals are local
 * data for restoring a selected token after interpretation, not prompt content.
 */
export function maskLiteralTitles(
  text: string,
  tokenPrefix: TokenPrefix = 'current',
): MaskedLiteralTitles {
  if (typeof text !== 'string') throw new Error('Literal input must be text.');
  if (tokenPrefix !== 'current' && tokenPrefix !== 'pending')
    throw new Error('Invalid literal token namespace.');
  const pairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    '\u201c': '\u201d',
    '\u2018': '\u2019',
  };
  const literals: LiteralTitle[] = [];
  const pieces: string[] = [];
  let copiedThrough = 0;
  let tokenIndex = 0;
  let previousTitleEnd: number | null = null;
  for (let start = 0; start < text.length; start++) {
    const opener = text[start];
    const closer = pairs[opener];
    if (!closer || escaped(text, start)) continue;
    // An ASCII apostrophe attached to a word is an inflection/contraction,
    // never a new quoted span (Kadikoy'de, don't, we're).
    if (opener === "'" && wordCharacter(text[start - 1])) continue;
    let end = start + 1;
    for (; end < text.length; end++) {
      if (text[end] !== closer || escaped(text, end)) continue;
      if (
        (closer === "'" || closer === '\u2019') &&
        wordCharacter(text[end - 1]) &&
        wordCharacter(text[end + 1])
      )
        continue;
      break;
    }
    if (end >= text.length) {
      // Unfinished framed titles must not expose their contents to the model.
      if (titleFraming(text.slice(0, start), ''))
        throw new Error('A framed literal title needs matching quotation marks.');
      continue;
    }
    const coordinatedTitle =
      previousTitleEnd !== null &&
      /^\s*(?:,|and|or|ve|veya|ya da)\s*$/u.test(
        fold(text.slice(previousTitleEnd, start)),
      );
    if (
      end === start + 1 ||
      (!coordinatedTitle &&
        !titleFraming(text.slice(0, start), text.slice(end + 1)))
    ) {
      start = end;
      continue;
    }
    let token: string;
    do {
      token = `LITERAL${tokenPrefix.toUpperCase()}TITLE${alphabeticIndex(tokenIndex++)}`;
    } while (text.toUpperCase().includes(token));
    pieces.push(text.slice(copiedThrough, start), token);
    literals.push({ token, value: text.slice(start + 1, end) });
    copiedThrough = end + 1;
    previousTitleEnd = end + 1;
    start = end;
  }
  pieces.push(text.slice(copiedThrough));
  return { text: pieces.join(''), literals };
}

/** A prompt-only copy: real prior preferences remain in the local reducer. */
export function maskPriorInterests(state: IntentState): IntentState {
  const copy = structuredClone(state);
  copy.preferences.interests = state.preferences.interests.map(
    (_, index) => `PRIORINTEREST${alphabeticIndex(index)}`,
  );
  if (state.primaryTopics?.length)
    copy.primaryTopics = state.primaryTopics.map((_, index) => `PRIORTOPIC${String.fromCharCode(65 + index)}`);
  return copy;
}
