import { emptyPlan, type Atom, type Condition, type Operation, type Plan, type PreviousState } from './contract.ts';

const categories = new Set(['concert', 'theatre', 'standup', 'workshop', 'exhibition', 'festival',
  'sport', 'cinema', 'talk', 'dance', 'show', 'course', 'tour', 'museum']);
const experiences = new Set(['quiet', 'seated', 'outdoors', 'wheelchair_accessible',
  'family_friendly', 'uncrowded', 'romantic', 'beginner_friendly']);
const orders = new Set(['none', 'soonest', 'cheapest', 'nearest']);
const comparisons = new Set(['lt', 'lte', 'gt', 'gte', 'approx']);
const bases = new Set(['per_person', 'per_ticket', 'group_total']);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function date(value: string) {
  assert(/^\d{4}-\d{2}-\d{2}$/u.test(value), 'invalid date syntax');
  const parsed = new Date(`${value}T12:00:00Z`);
  assert(Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value, 'invalid date value');
}

function clock(value: string) {
  assert(/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value), 'invalid clock');
}

function validateAtom(atom: Atom) {
  assert(atom && typeof atom === 'object', 'invalid atom');
  switch (atom.kind) {
    case 'budget':
      assert(comparisons.has(atom.comparison) && bases.has(atom.basis) && atom.currency === 'TRY', 'invalid budget semantics');
      assert(Number.isFinite(atom.amount) && atom.amount >= 0 && atom.amount <= 1e9, 'invalid budget amount');
      return;
    case 'party': assert(Number.isInteger(atom.count) && atom.count > 0 && atom.count <= 1000, 'invalid party count'); return;
    case 'companion': assert(['partner', 'friends', 'family', 'children'].includes(atom.value), 'invalid companion'); return;
    case 'date': date(atom.from); date(atom.to); assert(atom.from <= atom.to, 'reversed date bounds'); return;
    case 'time':
      assert(atom.from || atom.to, 'missing clock bound');
      if (atom.from) clock(atom.from);
      if (atom.to) clock(atom.to);
      assert(atom.fromExclusive === undefined || typeof atom.fromExclusive === 'boolean', 'invalid clock exclusivity');
      assert(atom.toExclusive === undefined || typeof atom.toExclusive === 'boolean', 'invalid clock exclusivity');
      assert(!atom.fromExclusive || atom.from, 'exclusive clock has no lower bound');
      assert(!atom.toExclusive || atom.to, 'exclusive clock has no upper bound');
      if (atom.from && atom.to) {
        assert(atom.from <= atom.to, 'unsupported overnight range');
        assert(atom.from !== atom.to || (!atom.fromExclusive && !atom.toExclusive), 'empty strict clock range');
      }
      return;
    case 'location':
      assert(typeof atom.name === 'string' && atom.name.trim().length > 0 && atom.name.length <= 64, 'invalid location');
      assert(['district', 'neighborhood'].includes(atom.precision), 'invalid location precision'); return;
    case 'category': assert(categories.has(atom.value), 'invalid category'); return;
    case 'topic': assert(typeof atom.value === 'string' && atom.value.trim().length > 0 && atom.value.length <= 160, 'invalid topic'); return;
    case 'experience': assert(experiences.has(atom.value), 'invalid experience'); return;
    case 'content': assert(['profanity', 'sexual_content'].includes(atom.value), 'invalid content'); return;
    default: throw new Error('unknown atom type');
  }
}

export function validatePlan(plan: Plan) {
  assert(plan && plan.hard?.type === 'all' && Array.isArray(plan.preferences) && orders.has(plan.order), 'invalid plan');
  const ids = new Set<string>();
  let nodes = 0;
  const visit = (condition: Condition, depth: number, allowEmpty = false) => {
    assert(++nodes <= 256 && depth <= 12, 'condition complexity limit');
    assert(condition && typeof condition === 'object', 'invalid condition');
    if (condition.id !== undefined) {
      assert(typeof condition.id === 'string' && /^[a-z][a-z0-9_]{0,39}$/u.test(condition.id), 'invalid condition ID');
      assert(!ids.has(condition.id), 'duplicate condition ID');
      ids.add(condition.id);
    }
    if (condition.type === 'atom') validateAtom(condition.atom);
    else if (condition.type === 'not') visit(condition.child, depth + 1);
    else {
      assert(['all', 'any'].includes(condition.type) && Array.isArray(condition.children), 'invalid connective');
      assert(allowEmpty || condition.children.length > 0, 'empty connective');
      for (const child of condition.children) visit(child, depth + 1);
    }
  };
  visit(plan.hard, 0, true);
  for (const preference of plan.preferences) visit(preference, 0);
}

function cloneWithoutIds(condition: Condition): Condition {
  if (condition.type === 'atom') return { type: 'atom', atom: structuredClone(condition.atom) };
  if (condition.type === 'not') return { type: 'not', child: cloneWithoutIds(condition.child) };
  return { type: condition.type, children: condition.children.map(cloneWithoutIds) };
}

/** Atomic, pure reducer: originals remain unchanged even if a later operation fails. */
export function applyOperations(previous: PreviousState | null, operations: Operation[]): Plan {
  if (previous) {
    assert(Number.isInteger(previous.revision) && previous.revision >= 0, 'invalid prior revision');
    validatePlan(previous.plan);
  }
  assert(Array.isArray(operations) && operations.length <= 64, 'operation limit');
  const plan = previous ? structuredClone(previous.plan) : emptyPlan();
  assert(plan.hard.type === 'all', 'invalid hard root');
  let hard = plan.hard.children;
  let preferred = plan.preferences;
  const identities = [...hard, ...preferred];
  let hardIndex = Math.max(-1, ...identities.map((c) => /^h\d+$/u.test(c.id ?? '') ? Number(c.id!.slice(1)) : -1)) + 1;
  let preferredIndex = Math.max(-1, ...identities.map((c) => /^p\d+$/u.test(c.id ?? '') ? Number(c.id!.slice(1)) : -1)) + 1;
  const lookup = (id: string) => {
    const h = hard.findIndex((c) => c.id === id);
    const p = preferred.findIndex((c) => c.id === id);
    assert(h >= 0 || p >= 0, 'unknown/non-top-level correction target');
    return { list: h >= 0 ? hard : preferred, index: h >= 0 ? h : p, preferred: p >= 0 };
  };
  for (const operation of operations) {
    if (operation.op === 'reset') {
      hard = []; preferred = []; plan.order = 'none';
    } else if (operation.op === 'order') {
      assert(orders.has(operation.value), 'invalid order operation'); plan.order = operation.value;
    } else if (operation.op === 'add') {
      assert(['hard', 'preferred'].includes(operation.strength), 'invalid condition strength');
      const condition = cloneWithoutIds(operation.condition);
      if (operation.strength === 'hard') hard.push({ ...condition, id: `h${hardIndex++}` });
      else preferred.push({ ...condition, id: `p${preferredIndex++}` });
    } else if (operation.op === 'remove' || operation.op === 'keep') {
      const target = lookup(operation.targetId);
      if (operation.op === 'remove') target.list.splice(target.index, 1);
    } else if (operation.op === 'replace') {
      const target = lookup(operation.targetId);
      assert(operation.strength === undefined || ['hard', 'preferred'].includes(operation.strength), 'invalid replacement strength');
      const condition = { ...cloneWithoutIds(operation.condition), id: operation.targetId };
      const asPreferred = operation.strength ? operation.strength === 'preferred' : target.preferred;
      if (asPreferred === target.preferred) target.list[target.index] = condition;
      else {
        target.list.splice(target.index, 1);
        (asPreferred ? preferred : hard).push(condition);
      }
    } else throw new Error('invalid operation');
  }
  plan.hard.children = hard;
  plan.preferences = preferred;
  validatePlan(plan);
  return plan;
}
