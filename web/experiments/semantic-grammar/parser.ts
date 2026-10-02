import { LIMITS, emptyPlan, type Atom, type BudgetBasis, type Comparison, type Condition,
  type Evidence, type Interpretation, type Operation, type Ownership, type ParserInput, type ParserResult } from './contract.ts';
import { chart, ChartLimit, AlternativeLimit, type Edge, type Rule } from './chart.ts';
import { CATEGORIES, COMPANIONS, EXPERIENCES, LOCATIONS, NUMBER_WORDS, TOPICS, normalize } from './lexicon.ts';
import { applyOperations, validatePlan } from './state.ts';
import { canonicalInterpretation, stable } from './semantics.ts';

type Expr = { tag: 'atom'; condition: Condition }
  | { tag: 'and' | 'or'; left: Expr; right: Expr }
  | { tag: 'not' | 'preferred' | 'hard'; child: Expr };
interface Value { expr?: Expr; operations?: Operation[]; scalar?: string | number;
  evidence: Evidence[]; ownership: Ownership[] }
interface Token { norm: string; start: number; end: number }
const one = (atom: Atom): Expr => ({ tag: 'atom', condition: { type: 'atom', atom } });

function condition(expr: Expr): Condition | null {
  if (expr.tag === 'atom') return expr.condition;
  if (expr.tag === 'preferred' || expr.tag === 'hard') return null;
  if (expr.tag === 'not') { const child = condition(expr.child); return child ? { type: 'not', child } : null; }
  if (expr.tag !== 'and' && expr.tag !== 'or') return null;
  const left = condition(expr.left), right = condition(expr.right);
  if (!left || !right) return null;
  const type = expr.tag === 'and' ? 'all' : 'any';
  const children = [left, right].flatMap((c) => c.type === type ? c.children : [c]);
  return { type, children };
}

function operations(expr: Expr): Operation[] | null {
  if (expr.tag === 'and') {
    const left = operations(expr.left), right = operations(expr.right);
    return left && right ? [...left, ...right] : null;
  }
  const strength = expr.tag === 'preferred' ? 'preferred' : 'hard';
  const c = condition(expr.tag === 'preferred' || expr.tag === 'hard' ? expr.child : expr);
  return c ? [{ op: 'add', strength, condition: c }] : null;
}
const combine = (values: Value[], extra: Partial<Value> = {}): Value => ({
  evidence: values.flatMap((v) => v.evidence), ownership: values.flatMap((v) => v.ownership), ...extra,
});
const binary = (tag: 'and' | 'or', left: Value, right: Value, values: Value[]): Value | null =>
  left.expr && right.expr ? combine(values, { expr: { tag, left: left.expr, right: right.expr } }) : null;

function grammar(): Rule<Value>[] {
  const r = (name: string, symbols: string[], build: Rule<Value>['build']): Rule<Value> => ({ name, symbols, build });
  const id = (v: Value[]) => v[0];
  const wrap = (tag: 'not' | 'preferred' | 'hard', i: number) => (v: Value[]) =>
    v[i].expr ? combine(v, { expr: { tag, child: v[i].expr! } }) : null;
  const seq = (v: Value[]) => v[0].operations && v.at(-1)?.operations ? combine(v, {
    operations: [...v[0].operations, ...v.at(-1)!.operations!],
  }) : null;
  const b = (basis?: BudgetBasis) => (v: Value[]): Value | null => {
    const amount = v.find((x) => typeof x.scalar === 'number')?.scalar as number | undefined;
    const comparison = v.find((x) => ['lt', 'lte', 'gt', 'gte', 'approx'].includes(String(x.scalar)))?.scalar as Comparison | undefined;
    const selectedBasis = basis ?? v.find((x) => ['per_person', 'per_ticket', 'group_total'].includes(String(x.scalar)))?.scalar as BudgetBasis | undefined;
    return amount !== undefined && comparison && selectedBasis ? combine(v, {
      expr: one({ kind: 'budget', amount, comparison, basis: selectedBasis, currency: 'TRY' }),
    }) : null;
  };
  const rules = [
    r('S', ['R'], id), r('R', ['E'], (v) => {
      const ops = v[0].expr && operations(v[0].expr); return ops ? combine(v, { operations: ops }) : null;
    }), r('R', ['$ACTION'], id),
    r('R', ['R', '$SEP', 'R'], seq),
    r('R', ['$REQUEST', 'R'], (v) => combine(v, { operations: v[1].operations })),
    r('R', ['R', '$ENDING'], (v) => combine(v, { operations: v[0].operations })),
    r('R', ['R', '$STOP'], (v) => combine(v, { operations: v[0].operations })),
    r('E', ['T'], id), r('E', ['E', '$OR', 'T'], (v) => binary('or', v[0], v[2], v)),
    r('T', ['U'], id), r('T', ['T', '$AND', 'U'], (v) => binary('and', v[0], v[2], v)),
    r('T', ['T', 'U'], (v) => binary('and', v[0], v[1], v)),
    r('U', ['P'], id), r('U', ['$NOT', 'U'], wrap('not', 1)),
    r('U', ['$SOFT', 'U'], wrap('preferred', 1)), r('U', ['$HARD', 'U'], wrap('hard', 1)),
    r('U', ['$LP', 'E', '$RP'], (v) => combine(v, { expr: v[1].expr })),
    r('U', ['P', '$NOTEND'], wrap('not', 0)), r('U', ['P', '$SOFTEND'], wrap('preferred', 0)),
    r('U', ['$HEAD', 'U'], (v) => combine(v, { expr: v[1].expr })),
    r('U', ['U', '$HEAD'], (v) => combine(v, { expr: v[0].expr })),
    r('P', ['$ATOM'], id), r('P', ['B'], id),
    r('P', ['$MODIFIER', '$CATEGORY'], (v) => binary('and', v[0], v[1], v)),
    r('P', ['$CATEGORY', '$MODIFIER'], (v) => binary('and', v[0], v[1], v)),
    r('P', ['$NEITHER', 'E'], wrap('not', 1)),
    r('B', ['$BASIS', '$COMPARE', 'M'], b()), r('B', ['$COMPARE', 'M', '$BASIS'], b()),
    r('B', ['M', '$COMPARE', '$BASIS'], b()), r('B', ['$BASIS', 'M', '$COMPARE'], b()),
    r('M', ['$NUMBER', '$CURRENCY'], (v) => combine(v, { scalar: v[0].scalar })),
    r('M', ['$CURRENCY', '$NUMBER'], (v) => combine(v, { scalar: v[1].scalar })),
  ];
  for (const basis of ['per_person', 'per_ticket', 'group_total'] as const) {
    for (const symbols of [['$COMPARE', 'M'], ['M', '$COMPARE']]) rules.push(r('B', symbols, b(basis)));
  }
  return rules;
}

function number(text: string): number | null {
  if (!/^\d+(?:[.,]\d+)*$/u.test(text)) return NUMBER_WORDS.get(text) ?? null;
  const parts = text.split(/[.,]/u), last = parts.at(-1)!;
  const n = parts.length === 1 ? Number(text) : last.length === 3 ? Number(parts.join(''))
    : last.length <= 2 ? Number(`${parts.slice(0, -1).join('')}.${last}`) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null;
}
const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10);
};
const weekdays = new Map([['sunday', 0], ['pazar', 0], ['monday', 1], ['pazartesi', 1], ['tuesday', 2], ['sali', 2],
  ['wednesday', 3], ['carsamba', 3], ['thursday', 4], ['persembe', 4], ['friday', 5], ['cuma', 5], ['saturday', 6], ['cumartesi', 6]]);
const comparisons = new Map<string, Comparison>([
  ['maximum', 'lte'], ['max', 'lte'], ['maks', 'lte'], ['maksimum', 'lte'], ['en fazla', 'lte'], ['at most', 'lte'],
  ['under', 'lt'], ['below', 'lt'], ['less than', 'lt'], ['altinda', 'lt'], ['alti', 'lt'],
  ['minimum', 'gte'], ['min', 'gte'], ['en az', 'gte'], ['at least', 'gte'],
  ['over', 'gt'], ['above', 'gt'], ['more than', 'gt'], ['uzeri', 'gt'], ['ustunde', 'gt'],
  ['around', 'approx'], ['about', 'approx'], ['yaklasik', 'approx'], ['roughly', 'approx'],
]);
const bases = new Map<string, BudgetBasis>([
  ['per person', 'per_person'], ['per-person', 'per_person'], ['kisi basi', 'per_person'], ['kisi basina', 'per_person'],
  ['per ticket', 'per_ticket'], ['per-ticket', 'per_ticket'], ['bilet basi', 'per_ticket'], ['bilet basina', 'per_ticket'],
  ['total', 'group_total'], ['toplam', 'group_total'], ['group total', 'group_total'], ['grup toplami', 'group_total'],
]);
const phrases: Record<string, string[]> = {
  $OR: ['or', 'veya', 'ya da', 'nor'], $AND: ['and', 've', 'ile', 'olan'], $SEP: [',', ';'], $STOP: ['.', '!', '?'],
  $LP: ['('], $RP: [')'], $NOT: ['not', 'no', 'without', 'excluding', 'except', 'outside'],
  $NOTEND: ['olmasin', 'istemiyorum', 'istemem', 'haric', 'degil', 'disinda', 'disi'],
  $SOFT: ['prefer', 'preferably', 'optionally', 'maybe', 'tercihen', 'mumkunse'],
  $SOFTEND: ['optional', 'olabilir', 'would be nice', 'olursa guzel olur'],
  $HARD: ['must', 'required', 'mutlaka', 'sart'], $NEITHER: ['neither'],
  $HEAD: ['a', 'an', 'the', 'bir', 'events', 'event', 'etkinlik', 'etkinlikler', 'gosterileri', 'etkinlikleri'],
  $REQUEST: ['find', 'show me', 'show us', 'recommend', 'i want', 'i would like', 'we want', 'bana', 'bize', 'lutfen'],
  $ENDING: ['bul', 'olsun', 'ariyorum', 'please', 'i can attend', 'gidebilecegim'],
};

function scanner(input: ParserInput, tokens: Token[]) {
  const cache = new Map<string, Edge<Value>[]>();
  const edge = (start: number, end: number, role: string, data: Partial<Value>, kind: Ownership['kind'] = 'semantic'): Edge<Value> => {
    const span = { start: tokens[start].start, end: tokens[end - 1].end,
      text: input.utterance.slice(tokens[start].start, tokens[end - 1].end), role };
    return { end, value: { evidence: kind === 'semantic' ? [span] : [], ownership: [{ ...span, kind }], ...data } };
  };
  return (symbol: string, start: number): Edge<Value>[] => {
    const key = `${symbol}/${start}`, cached = cache.get(key); if (cached) return cached;
    const found: Edge<Value>[] = [];
    if (start >= tokens.length) return found;
    const word = tokens[start].norm;
    const atom = (end: number, value: Atom) => found.push(edge(start, end, value.kind, { expr: one(value) }));
    if (symbol === '$COMPARE' || symbol === '$BASIS') {
      const map = symbol === '$COMPARE' ? comparisons : bases;
      for (let end = start + 1; end <= Math.min(tokens.length, start + 3); end++) {
        const scalar = map.get(tokens.slice(start, end).map((t) => t.norm).join(' '));
        if (scalar) found.push(edge(start, end, symbol, { scalar }));
      }
    } else if (symbol === '$NUMBER') {
      const n = number(word); if (n !== null) found.push(edge(start, start + 1, 'amount', { scalar: n }));
    } else if (symbol === '$CURRENCY' && ['tl', 'try', 'lira', '₺'].includes(word)) found.push(edge(start, start + 1, 'currency', {}));
    else if (['$ATOM', '$MODIFIER', '$CATEGORY'].includes(symbol)) {
      let noun = word;
      for (const suffix of ['daki', 'deki', 'da', 'de', 'ta', 'te', 'leri', 'lari', 'ler', 'lar', 'ni', 'yi']) {
        const stem = word.endsWith(suffix) ? word.slice(0, -suffix.length) : '';
        if (CATEGORIES.has(stem) || TOPICS.has(stem) || LOCATIONS.has(stem)) { noun = stem; break; }
      }
      const category = CATEGORIES.get(noun), topic = TOPICS.get(noun), experience = EXPERIENCES.get(noun);
      if (category && symbol !== '$MODIFIER') atom(start + 1, { kind: 'category', value: category });
      if (topic && symbol !== '$CATEGORY') atom(start + 1, { kind: 'topic', value: topic });
      if (experience && symbol !== '$CATEGORY') atom(start + 1, { kind: 'experience', value: experience });
      if (symbol === '$ATOM') {
        const place = LOCATIONS.get(noun); if (place) atom(start + 1, { kind: 'location', ...place });
        if (['in', 'at'].includes(word)) {
          const p = LOCATIONS.get(tokens[start + 1]?.norm); if (p) atom(start + 2, { kind: 'location', ...p });
        }
        const companion = COMPANIONS.get(word);
        if (companion && input.language === 'tr' && word.endsWith('le')) atom(start + 1, { kind: 'companion', value: companion });
        for (let end = start + 2; end <= Math.min(tokens.length, start + 4); end++) {
          const p = tokens.slice(start, end).map((t) => t.norm).join(' ');
          const m = /^with (?:my |our )?(partner|girlfriend|boyfriend|friends|family|children|kids)$/u.exec(p);
          if (m && COMPANIONS.has(m[1])) atom(end, { kind: 'companion', value: COMPANIONS.get(m[1])! });
          if (p === 'kiz arkadasimla' || p === 'erkek arkadasimla') atom(end, { kind: 'companion', value: 'partner' });
          const group = /^(?:we are|biz) (\w+)$/u.exec(p) ?? /^(\w+) (?:people|persons|kisiyiz|kisi)$/u.exec(p);
          if (group) { const n = number(group[1]); if (n !== null && Number.isInteger(n) && n > 0 && n <= 1000) atom(end, { kind: 'party', count: n }); }
        }
        const day = (from: string, to = from, end = start + 1) => atom(end, { kind: 'date', from, to });
        if (['today', 'bugun'].includes(word)) day(input.referenceDate);
        if (['tomorrow', 'yarin'].includes(word)) day(addDays(input.referenceDate, 1));
        if (/^\d{4}-\d{2}-\d{2}$/u.test(word)) day(word);
        const ref = new Date(`${input.referenceDate}T12:00:00Z`).getUTCDay(), weekday = weekdays.get(word);
        if (weekday !== undefined) day(addDays(input.referenceDate, (weekday - ref + 7) % 7));
        if (['this', 'bu', 'on'].includes(word) && weekdays.has(tokens[start + 1]?.norm))
          day(addDays(input.referenceDate, (weekdays.get(tokens[start + 1].norm)! - ref + 7) % 7), undefined, start + 2);
        if (['next', 'gelecek'].includes(word) && weekdays.has(tokens[start + 1]?.norm)) {
          const offset = (weekdays.get(tokens[start + 1].norm)! - ref + 7) % 7;
          day(addDays(input.referenceDate, offset || 7), undefined, start + 2);
          if (offset) day(addDays(input.referenceDate, offset + 7), undefined, start + 2);
        }
        const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/u, next = tokens[start + 1]?.norm;
        if (time.test(word)) atom(start + 1, { kind: 'time', from: word, to: word });
        if (next && time.test(next)) {
          if (word === 'after') atom(start + 2, { kind: 'time', from: next, fromExclusive: true });
          if (word === 'before') atom(start + 2, { kind: 'time', to: next, toExclusive: true });
          if (word === 'at') atom(start + 2, { kind: 'time', from: next, to: next });
        }
        if (time.test(word) && ['sonra', 'sonrasi'].includes(next)) atom(start + 2, { kind: 'time', from: word, fromExclusive: true });
        if (time.test(word) && ['once', 'oncesi'].includes(next)) atom(start + 2, { kind: 'time', to: word, toExclusive: true });
        if (['profanity', 'kufur'].includes(word)) atom(start + 1, { kind: 'content', value: 'profanity' });
      }
    } else if (symbol === '$ACTION') {
      const plan = input.previousState?.plan;
      const top = [...(plan?.hard.type === 'all' ? plan.hard.children : []), ...(plan?.preferences ?? [])];
      for (let end = start + 1; end <= Math.min(tokens.length, start + 9); end++) {
        const p = tokens.slice(start, end).map((t) => t.norm).join(' ');
        let ops: Operation[] | null = null;
        if (['reset', 'start over', 'forget everything', 'sifirla', 'bastan basla', 'her seyi sifirla'].includes(p)) ops = [{ op: 'reset' }];
        if (['soonest', 'earliest', 'en yakin tarih', 'en erken tarih'].includes(p)) ops = [{ op: 'order', value: 'soonest' }];
        if (['cheapest', 'en ucuz'].includes(p)) ops = [{ op: 'order', value: 'cheapest' }];
        if (['nearest', 'closest', 'en yakin'].includes(p)) ops = [{ op: 'order', value: 'nearest' }];
        if (ops) found.push(edge(start, end, 'operation', { operations: ops }));
        const remove = /^(?:remove|delete) (?:that|this|it|the condition|that condition)$/u.test(p)
          || ['bu kosulu kaldir', 'onu kaldir', 'kosulu kaldir'].includes(p);
        const prefer = ['make that a preference', 'make it optional', 'onu tercihe cevir'].includes(p);
        const typed = /^remove (?:the )?(budget|date|location|category|preference)(?: condition| limit)?$/u.exec(p)
          ?? /^(butce|tarih|konum|kategori|tercih)(?: kosulunu| sinirini)? kaldir$/u.exec(p);
        const kinds: Record<string, string> = { butce: 'budget', tarih: 'date', konum: 'location', kategori: 'category', tercih: 'preference' };
        const kind = typed ? kinds[typed[1]] ?? typed[1] : null;
        if (remove || prefer || typed) for (const c of top) {
          if (!c.id || (kind && !(kind === 'preference' ? plan?.preferences.includes(c) : c.type === 'atom' && c.atom.kind === kind))) continue;
          const op: Operation = prefer ? { op: 'replace', targetId: c.id, strength: 'preferred', condition: c } : { op: 'remove', targetId: c.id };
          found.push(edge(start, end, 'correction', { operations: [op] }));
        }
      }
    } else if (phrases[symbol]) for (const phrase of phrases[symbol]) {
      const parts = phrase.split(' ');
      if (parts.every((p, i) => tokens[start + i]?.norm === p))
        found.push(edge(start, start + parts.length, symbol, {}, ['$REQUEST', '$ENDING', '$HEAD'].includes(symbol) ? 'discourse' : 'structural'));
    }
    cache.set(key, found); return found;
  };
}

export function parse(input: ParserInput): ParserResult {
  const started = performance.now(); let items = 0, tokenCount = 0;
  const diag = (materialAlternatives = 0) => ({ tokenCount, chartItems: items, materialAlternatives, elapsedMs: performance.now() - started });
  const refuse = (reason: string, guard?: 'input_length' | 'token_limit' | 'chart_limit' | 'alternative_limit'): ParserResult => ({
    status: 'unsupported', reason, unresolvedSpans: [{ start: 0, end: input.utterance.length, text: input.utterance, role: 'unresolved' }],
    evidence: [], ownership: [], diagnostics: { ...diag(), ...(guard ? { guard } : {}) },
  });
  if (input.utterance.length > LIMITS.characters) return refuse('input limit', 'input_length');
  const tokens: Token[] = [];
  // Catch-all retains every unknown non-whitespace symbol. Normalization never changes offsets.
  const re = /\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|\d+(?:[.,]\d+)*|[\p{L}]+(?:[-’'][\p{L}]+)*|[^\s]/gu;
  for (const m of input.utterance.matchAll(re)) {
    if (tokens.length >= LIMITS.tokens) { tokenCount = tokens.length + 1; return refuse('token limit', 'token_limit'); }
    tokens.push({ norm: normalize(m[0]), start: m.index, end: m.index + m[0].length });
  }
  tokenCount = tokens.length; if (!tokenCount) return refuse('empty request');
  try {
    const ref = new Date(`${input.referenceDate}T12:00:00Z`);
    if (input.timezone !== 'Europe/Istanbul' || !Number.isFinite(ref.getTime()) || ref.toISOString().slice(0, 10) !== input.referenceDate) return refuse('invalid request clock');
    if (input.previousState) validatePlan(input.previousState.plan);
    const meaningKey = (value: Value) => value.operations ? canonicalInterpretation({ operations: value.operations,
      resultingPlan: emptyPlan() }) : stable(value.expr);
    const valueKey = (value: Value) => stable({ expr: value.expr, operations: value.operations, scalar: value.scalar });
    const result = chart(grammar(), tokens.length, scanner(input, tokens), valueKey, meaningKey, LIMITS.chartItems, LIMITS.alternatives);
    items = result.items;
    const alternatives = new Map<string, { interpretation: Interpretation; value: Value }>();
    for (const value of result.values) {
      if (!value.operations?.length) continue;
      const interpretation = { operations: value.operations, resultingPlan: applyOperations(input.previousState, value.operations) };
      alternatives.set(canonicalInterpretation(interpretation), { interpretation, value });
    }
    if (!alternatives.size) return refuse('no complete grammatical reading; unresolved material retained');
    const readings = [...alternatives.values()], { evidence, ownership } = readings[0].value;
    if (readings.length === 1) return { status: 'accepted', ...readings[0].interpretation, evidence, ownership, diagnostics: diag(1) };
    return { status: 'ambiguous', reason: 'multiple complete grammatical readings', alternatives: readings.map((a) => a.interpretation),
      evidence, ownership, diagnostics: diag(readings.length) };
  } catch (error) {
    if (error instanceof ChartLimit) { items = error.items; return refuse('chart limit before insertion', 'chart_limit'); }
    if (error instanceof AlternativeLimit) { items = error.items; return refuse('material alternative limit before insertion', 'alternative_limit'); }
    return refuse(`validation failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
