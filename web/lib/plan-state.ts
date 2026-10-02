import { emptyPlan, type Plan } from '../parser/contract.ts';
import { validatePlan } from '../parser/state.ts';

export interface PlanState {
  version: 2;
  revision: number;
  plan: Plan;
  /** The user's own words since the last reset, oldest first. They carry
   * performers, titles and nuance the typed plan cannot express; they are
   * relevance context only and never admit an event. */
  requests: string[];
}

export const MAX_PLAN_REQUESTS = 4;
export const MAX_PLAN_REQUEST_LENGTH = 1200;

const keys = (value: object) => Object.keys(value).sort().join(',');
const exact = (value: object, allowed: string[]) => {
  if (keys(value) !== [...allowed].sort().join(','))
    throw new Error('unexpected plan-state key');
};

function strictCondition(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid condition');
  const condition = value as Record<string, unknown>;
  const withId = condition.id === undefined ? [] : ['id'];
  if (condition.type === 'atom') {
    exact(condition, ['type', 'atom', ...withId]);
    strictAtom(condition.atom);
  } else if (condition.type === 'not') {
    exact(condition, ['type', 'child', ...withId]);
    strictCondition(condition.child);
  } else if (condition.type === 'all' || condition.type === 'any') {
    exact(condition, ['type', 'children', ...withId]);
    if (!Array.isArray(condition.children)) throw new Error('invalid children');
    condition.children.forEach(strictCondition);
  } else throw new Error('invalid condition type');
}

function strictAtom(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid atom');
  const atom = value as Record<string, unknown>;
  const shapes: Record<string, string[]> = {
    budget: ['kind', 'comparison', 'amount', 'currency', 'basis'],
    party: ['kind', 'count'],
    companion: ['kind', 'value'],
    date: ['kind', 'from', 'to'],
    location: ['kind', 'name', 'precision'],
    category: ['kind', 'value'],
    topic: ['kind', 'value'],
    experience: ['kind', 'value'],
    content: ['kind', 'value'],
  };
  if (atom.kind === 'time') {
    const allowed = new Set([
      'kind',
      'from',
      'to',
      'fromExclusive',
      'toExclusive',
    ]);
    if (Object.keys(atom).some((key) => !allowed.has(key)))
      throw new Error('unexpected time key');
    return;
  }
  const shape = shapes[String(atom.kind)];
  if (!shape) throw new Error('invalid atom kind');
  exact(atom, shape);
}

export function validatePlanState(value: unknown): PlanState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid plan state');
  const state = value as Record<string, unknown>;
  exact(state, ['version', 'revision', 'plan', 'requests']);
  if (
    state.version !== 2 ||
    !Number.isSafeInteger(state.revision) ||
    (state.revision as number) < 0
  )
    throw new Error('invalid plan-state envelope');
  if (
    !state.plan ||
    typeof state.plan !== 'object' ||
    Array.isArray(state.plan)
  )
    throw new Error('invalid plan');
  if (
    !Array.isArray(state.requests) ||
    state.requests.length > MAX_PLAN_REQUESTS ||
    state.requests.some(
      (request) =>
        typeof request !== 'string' ||
        !request.trim() ||
        request.length > MAX_PLAN_REQUEST_LENGTH,
    )
  )
    throw new Error('invalid plan requests');
  exact(state.plan as object, ['hard', 'preferences', 'order']);
  const plan = state.plan as unknown as Plan;
  validatePlan(plan);
  strictCondition(plan.hard);
  plan.preferences.forEach(strictCondition);
  return structuredClone(value) as PlanState;
}

export const emptyPlanState = (): PlanState => ({
  version: 2,
  revision: 0,
  plan: emptyPlan(),
  requests: [],
});
