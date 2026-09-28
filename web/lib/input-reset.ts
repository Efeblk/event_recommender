/** Recognize only a complete, unquoted reset command, never a search suffix. */
export function isStandaloneInputReset(message: string): boolean {
  const normalized = message
    .trim()
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\u0131/g, 'i')
    .replace(/\s+/gu, ' ');

  // Keep quotes, negations and other words intact: none belong to this grammar.
  // In particular, stripping punctuation broadly would turn quoted titles into
  // commands. Only separators between independently complete reset clauses are
  // allowed. Compound reset-and-search messages need full interpretation.
  const clause =
    '(?:sifirla|reset|bastan basla(?:yalim)?|onceki kosullari unut|hepsini unut|her seyi unut|forget everything|start over)';
  return new RegExp(`^${clause}(?:\\s*[,;.!]\\s*${clause})*[.!]*$`, 'u').test(
    normalized,
  );
}
