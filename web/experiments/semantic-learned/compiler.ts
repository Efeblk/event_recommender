import type { Atom, BudgetBasis, Condition, Evidence, Interpretation, Operation, Ownership, ParserInput, ParserResult } from '../semantic-grammar/contract.ts';
import { applyOperations } from '../semantic-grammar/state.ts';
import { canonicalInterpretation } from '../semantic-grammar/semantics.ts';
import { explicitBases, lower, prepareInput, resolveLocation, type ExactValue, type PreparedInput } from './values.ts';
import { KINDS, VALUES, TOPICS, type WireNode, type WireResult, type WireReading } from './wire.ts';
export { prepareInput } from './values.ts';
function check(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  check(value && typeof value === 'object' && !Array.isArray(value), 'object required');
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'missing/extra properties');
}
function strings(value: unknown): asserts value is string[] { check(Array.isArray(value) && value.length <= 160 && value.every(v => typeof v === 'string'), 'string array required'); }
function wire(value: unknown): WireResult {
  object(value, ['status', 'readings', 'unresolved', 'discourse']);
  check(['candidate', 'ambiguous', 'unsupported'].includes(value.status as string), 'invalid status');
  strings(value.unresolved); strings(value.discourse);
  check(Array.isArray(value.readings) && value.readings.length <= 8, 'reading limit');
  for (const reading of value.readings) {
    object(reading, ['nodes', 'operations']);
    check(Array.isArray(reading.nodes) && reading.nodes.length <= 64 && Array.isArray(reading.operations) && reading.operations.length > 0 && reading.operations.length <= 16, 'reading bounds');
    for (const node of reading.nodes) {
      object(node, ['id', 'type', 'children', 'kind', 'value', 'exact', 'refs', 'comparison', 'basis']);
      check(typeof node.id === 'string' && /^[a-z][a-z0-9_]{0,39}$/u.test(node.id), 'invalid node ID');
      check(['atom', 'all', 'any', 'not'].includes(node.type as string) && KINDS.includes(node.kind as typeof KINDS[number]) && VALUES.includes(node.value as typeof VALUES[number]), 'invalid node enum');
      check(['', 'lt', 'lte', 'gt', 'gte', 'approx'].includes(node.comparison as string) && ['', 'per_person', 'per_ticket', 'group_total'].includes(node.basis as string), 'invalid comparison/basis');
      strings(node.children); strings(node.exact); strings(node.refs);
    }
    for (const op of reading.operations) {
      object(op, ['op', 'target', 'root', 'strength', 'value', 'refs']);
      check(['add', 'replace', 'remove', 'keep', 'reset', 'order'].includes(op.op as string), 'invalid operation');
      check(typeof op.target === 'string' && typeof op.root === 'string' && ['', 'hard', 'preferred'].includes(op.strength as string) && ['', 'none', 'soonest', 'cheapest', 'nearest'].includes(op.value as string), 'invalid operation fields');
      strings(op.refs);
    }
  }
  return value as unknown as WireResult;
}
const discourse = new Set(['please', 'find', 'me', 'an', 'a', 'the', 'event', 'events', 'something', 'want', 'i', 'would', 'like', 'can', 'you', 'show', 'looking', 'recommend', 'suggest', 'us', 'lütfen', 'bana', 'bize', 'bir', 'etkinlik', 'etkinliği', 'etkinlikler', 'öner', 'önerir', 'misin', 'arayabilir', 'bul', 'arıyorum', 'istiyorum', 'isterim', 'olsun', 'istiyoruz', 'mi', 'mı']);
const punctuation = (text: string) => /^[.,;!?():"'’-]$/u.test(text);
export function compile(input: ParserInput, prepared: PreparedInput, unknownWire: unknown): ParserResult {
  const started = performance.now();
  const evidence: Evidence[] = []; const ownership: Ownership[] = [];
  const diagnostics = (alternatives = 0) => ({ tokenCount: prepared.tokens.length, chartItems: 0, materialAlternatives: alternatives, elapsedMs: performance.now() - started });
  const fail = (reason: string): ParserResult => ({ status: 'unsupported', reason, unresolvedSpans: [{ start: 0, end: input.utterance.length, text: input.utterance, role: 'unresolved' }], evidence: [], ownership: [], diagnostics: diagnostics() });
  try {
    check(JSON.stringify(prepareInput(input)) === JSON.stringify(prepared), 'prepared input is stale or altered');
    const result = wire(unknownWire);
    const tokens = new Map(prepared.tokens.map(t => [t.id, t]));
    const exacts = new Map(prepared.values.map(v => [v.id, v]));
    function refs(ids: string[], role: string, covered?: Set<string>, nodeId?: string) {
      check(ids.length > 0, `missing ${role} provenance`);
      for (const id of ids) {
        const token = tokens.get(id); check(token, 'unknown source token'); covered?.add(id);
        const entry = { start: token.start, end: token.end, text: token.text, role, ...(nodeId ? { nodeId } : {}) };
        evidence.push(entry); ownership.push({ ...entry, kind: role === 'discourse' ? 'discourse' : 'semantic' });
      }
    }
    const text = (ids: string[]) => ids.map(id => { const token = tokens.get(id); check(token, 'unknown source token'); return token.text; }).join(' ');
    for (const id of result.discourse) { const token = tokens.get(id); check(token && (punctuation(token.text) || discourse.has(input.language === 'en' ? token.text.toLowerCase() : lower(token.text))), 'material token marked discourse'); }
    if (result.discourse.length) refs(result.discourse, 'discourse');
    if (result.unresolved.length) refs(result.unresolved, 'unresolved');
    if (result.status === 'unsupported') {
      check(result.readings.length === 0 && result.unresolved.length > 0, 'unsupported cardinality');
      return { status: 'unsupported', reason: 'unresolved material', unresolvedSpans: evidence.filter(e => e.role === 'unresolved'), evidence, ownership, diagnostics: diagnostics() };
    }
    check(result.unresolved.length === 0, 'candidate has unresolved material');
    check(result.status === 'candidate' ? result.readings.length === 1 : result.readings.length >= 2, 'reading cardinality');
    const interpretations: Interpretation[] = [];
    for (const reading of result.readings) {
      const missing = reading.nodes.filter(n => n.type === 'atom' && n.kind === 'budget' && n.basis === '');
      const choices: Record<string, BudgetBasis>[] = [{}];
      for (const node of missing) {
        const local = explicitBases(reading.nodes.filter(n => n.kind === 'budget').length === 1 ? input.utterance : text(node.refs));
        const replacement = reading.operations.find(o => o.op === 'replace' && o.root === node.id);
        const prior = replacement && input.previousState?.plan.hard.type === 'all' ? [...input.previousState.plan.hard.children, ...input.previousState.plan.preferences].find(c => c.id === replacement.target) : undefined;
        const inherited = prior?.type === 'atom' && prior.atom.kind === 'budget' ? prior.atom.basis : undefined;
        const bases: BudgetBasis[] = local.length === 1 ? local : inherited ? [inherited] : ['per_person', 'per_ticket', 'group_total'];
        const old = choices.splice(0); for (const choice of old) for (const basis of bases) choices.push({ ...choice, [node.id]: basis });
        check(choices.length + interpretations.length <= 8, 'ambiguity bound');
      }
      for (const choice of choices) interpretations.push(compileReading(reading, choice));
    }
    const unique = new Map(interpretations.map(i => [canonicalInterpretation(i), i]));
    check(unique.size === interpretations.length, 'duplicate alternatives');
    if (interpretations.length > 1) return { status: 'ambiguous', alternatives: interpretations, reason: 'material interpretations require clarification', evidence, ownership, diagnostics: diagnostics(interpretations.length) };
    check(result.status === 'candidate', 'ambiguity collapsed');
    return { status: 'accepted', ...interpretations[0], evidence, ownership, diagnostics: diagnostics(1) };

    function compileReading(reading: WireReading, choice: Record<string, BudgetBasis>): Interpretation {
      const nodes = new Map(reading.nodes.map(n => [n.id, n])); check(nodes.size === reading.nodes.length, 'duplicate node ID');
      const covered = new Set(result.discourse); const visited = new Set<string>(); const active = new Set<string>();
      const exactCovered = new Set<string>(); const deltaTargets = new Map<string, string>();
      const exact = (node: WireNode, count: number | number[]): ExactValue[] => {
        check((Array.isArray(count) ? count : [count]).includes(node.exact.length), 'exact-value arity');
        return node.exact.map(id => {
          const value = exacts.get(id); check(value, 'unknown exact value');
          check(value.refs.every(ref => node.refs.includes(ref)), 'exact value outside atom evidence');
          value.refs.forEach(ref => exactCovered.add(ref)); return value;
        });
      };
      const visit = (id: string, depth = 0): Condition => {
        const node = nodes.get(id); check(node && depth <= 12, 'missing node/depth bound');
        check(!active.has(id), 'cyclic nodes'); check(!visited.has(id), 'shared node is not a tree');
        active.add(id); visited.add(id); refs(node.refs, 'condition', covered, id);
        let condition: Condition;
        if (node.type !== 'atom') {
          check(node.kind === '' && node.value === '' && node.exact.length === 0 && node.comparison === '' && node.basis === '', 'connective has atom fields');
          check(node.type === 'not' ? node.children.length === 1 : node.children.length >= 2, 'connective arity');
          const children = node.children.map(child => visit(child, depth + 1));
          condition = node.type === 'not' ? { type: 'not', child: children[0] } : { type: node.type, children };
        } else {
          check(node.children.length === 0 && node.kind !== '', 'atom shape');
          if (node.kind !== 'budget') check(node.basis === '', 'basis on nonbudget');
          if (!['budget', 'time'].includes(node.kind)) check(node.comparison === '', 'comparison on wrong atom');
          let atom: Atom;
          switch (node.kind) {
            case 'budget': {
              const value = exact(node, 1)[0]; check(value.kind === 'number' && value.number !== undefined && node.value === '' && node.comparison !== '', 'budget value');
              check(!/\b(?:usd|eur|dollars?|euros?)\b|[$€]/iu.test(input.utterance), 'unsupported currency');
              const bases = explicitBases(reading.nodes.filter(n => n.kind === 'budget').length === 1 ? input.utterance : text(node.refs)); check(bases.length <= 1, 'contradictory explicit bases');
              const basis = node.basis || choice[node.id]; check(basis, 'missing basis');
              check(bases.length === 0 || bases[0] === basis, 'explicit basis contradiction');
              if (node.basis && bases.length === 0) {
                const replacement = reading.operations.find(o => o.op === 'replace' && o.root === node.id);
                const prior = replacement && input.previousState?.plan.hard.type === 'all' ? [...input.previousState.plan.hard.children, ...input.previousState.plan.preferences].find(c => c.id === replacement.target) : undefined;
                check(prior?.type === 'atom' && prior.atom.kind === 'budget' && prior.atom.basis === basis, 'invented budget basis');
              }
              atom = { kind: 'budget', amount: value.number, currency: 'TRY', comparison: node.comparison, basis }; break;
            }
            case 'party': {
              const value = exact(node, 1)[0]; check(['number', 'party_delta'].includes(value.kind) && value.number !== undefined && node.value === '', 'party value');
              if (value.kind === 'party_delta') { check(value.target, 'delta target missing'); deltaTargets.set(node.id, value.target); }
              atom = { kind: 'party', count: value.number }; break;
            }
            case 'date': {
              const values = exact(node, [1, 2]); check(values.every(v => v.kind === 'date') && node.value === '', 'date value');
              check(values.every(v => v.from! >= prepared.referenceDate), 'past date cannot be a future search condition');
              atom = { kind: 'date', from: values[0].from!, to: values.at(-1)!.to! }; break;
            }
            case 'time': {
              const values = exact(node, [1, 2]); check(values.every(v => v.kind === 'time') && node.value === '' && node.comparison !== '', 'time value');
              if (values.length === 2) { check(node.comparison === 'approx', 'time range comparison'); atom = { kind: 'time', from: values[0].from!, to: values[1].to! }; }
              else if (['gt', 'gte'].includes(node.comparison)) atom = { kind: 'time', from: values[0].from!, ...(node.comparison === 'gt' ? { fromExclusive: true } : {}) };
              else if (['lt', 'lte'].includes(node.comparison)) atom = { kind: 'time', to: values[0].to!, ...(node.comparison === 'lt' ? { toExclusive: true } : {}) };
              else atom = { kind: 'time', from: values[0].from!, to: values[0].to! }; break;
            }
            case 'location': {
              check(node.exact.length === 0 && ['district', 'neighborhood'].includes(node.value), 'location shape');
              const source = node.refs.map(id => tokens.get(id)!); check(source.every((t, i) => i === 0 || t.start >= source[i - 1].end), 'location source order');
              const location = resolveLocation(input.utterance.slice(source[0].start, source.at(-1)!.end));
              check(location && location.precision === node.value, 'unknown location/precision');
              atom = { kind: 'location', ...location }; break;
            }
            case 'topic': check(node.exact.length === 0 && TOPICS.includes(node.value as typeof TOPICS[number]), 'unknown topic'); atom = { kind: 'topic', value: node.value }; break;
            default:
              check(node.exact.length === 0 && node.value !== '', 'semantic atom shape');
              atom = { kind: node.kind, value: node.value } as Atom;
          }
          condition = { type: 'atom', atom };
        }
        active.delete(id); return condition;
      };
      const operations: Operation[] = [];
      for (const op of reading.operations) {
        refs(op.refs, 'operation', covered); const source = lower(text(op.refs));
        if (op.op === 'add' || op.op === 'replace') {
          check(op.root !== '' && op.value === '' && (op.op === 'replace' || op.strength !== ''), 'condition operation shape');
          check(op.op === 'replace' ? op.target !== '' : op.target === '', 'target shape');
          if (op.op === 'replace') check(/instead|rather|make|change|replace|but|actually|now|olsun|değil|değiş|yerine|aslında|artık|çıkar|indir|azalt|artır|less|fewer|more|eksik|fazla/u.test(source), 'replacement lacks change cue');
          const condition = visit(op.root); const deltaTarget = deltaTargets.get(op.root);
          if (deltaTarget) check(op.op === 'replace' && op.target === deltaTarget, 'party arithmetic must replace its prior target');
          operations.push(op.op === 'add' ? { op: 'add', strength: op.strength as 'hard' | 'preferred', condition } : { op: 'replace', targetId: op.target, condition, ...(op.strength ? { strength: op.strength } : {}) });
        } else {
          check(op.root === '' && op.strength === '', 'noncondition operation fields');
          if (op.op === 'reset') { check(op.target === '' && op.value === '' && /reset|start\s+over|forget\s+(?:all|everything)|sıfırla|baştan|yeni\s+arama|her\s*şeyi\s+unut/u.test(source), 'reset lacks explicit cue'); operations.push({ op: 'reset' }); }
          else if (op.op === 'order') {
            check(op.target === '' && op.value !== '', 'order shape');
            const temporalNear = /en\s+yakın\s+(?:tarih|zaman|gün)|(?:nearest|closest)\s+(?:date|time)/u;
            const cues = { none: /remove|clear|ignore|no\s+sort|sıralama.*(?:yok|kaldır|unut)/u, soonest: /soonest|earliest|en\s+erken|tarih.*sırala|en\s+yakın\s+(?:tarih|zaman|gün)|(?:nearest|closest)\s+(?:date|time)/u, cheapest: /cheapest|cheaper|en\s+ucuz|fiyat.*sırala/u, nearest: /nearest|closest|en\s+yakın/u };
            check(cues[op.value].test(source), 'ordering lacks explicit cue');
            check(op.value !== 'nearest' || !temporalNear.test(source), 'temporal proximity is not geographic ordering');
            operations.push({ op: 'order', value: op.value });
          }
          else { check(op.target !== '' && op.value === '' && /remove|drop|ignore|forget|keep|still|unchanged|kaldır|unut|önemsiz|kalsın|aynı|hala|hâlâ|sınır.*yok/u.test(source), 'edit lacks explicit cue'); operations.push({ op: op.op, targetId: op.target }); }
        }
      }
      check(visited.size === nodes.size, 'unreachable node');
      for (const token of prepared.tokens) {
        check(covered.has(token.id) || punctuation(token.text), 'uncovered source material');
        if (/\p{N}/u.test(token.text)) check(exactCovered.has(token.id), 'numeric source not bound to exact value');
      }
      for (const [id, target] of deltaTargets) check(reading.operations.some(o => o.op === 'replace' && o.root === id && o.target === target), 'nested arithmetic cannot bypass replacement');
      const resultingPlan = applyOperations(input.previousState, operations);
      return { operations, resultingPlan };
    }
  } catch (error) { return fail(error instanceof Error ? error.message : 'invalid model output'); }
}
