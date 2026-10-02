import type { Condition, Interpretation, Operation, Plan } from './contract.ts';

/** Comparison ignores provenance/IDs; preserves scope, strength and transition targets. */
export function semanticCondition(condition: Condition): unknown {
  if (condition.type === 'atom') return { type: 'atom', atom: condition.atom };
  if (condition.type === 'not') return { type: 'not', child: semanticCondition(condition.child) };
  const children = condition.children.map(semanticCondition)
    .sort((left, right) => stable(left).localeCompare(stable(right)));
  return { type: condition.type, children };
}

export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, v]) => `${JSON.stringify(key)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function semanticPlan(plan: Plan): unknown {
  return {
    hard: semanticCondition(plan.hard),
    preferences: plan.preferences.map(semanticCondition).sort((a, b) => stable(a).localeCompare(stable(b))),
    order: plan.order,
  };
}

function semanticOperation(operation: Operation): unknown {
  if (operation.op === 'add') return { ...operation, condition: semanticCondition(operation.condition) };
  if (operation.op === 'replace') return { ...operation, condition: semanticCondition(operation.condition) };
  return operation;
}

export function canonicalInterpretation(interpretation: Interpretation): string {
  // Only consecutive additions commute. Never reorder edits, resets or ordering operations.
  const operations: unknown[] = [];
  let pending: unknown[] = [];
  const flush = () => {
    operations.push(...pending.sort((a, b) => stable(a).localeCompare(stable(b))));
    pending = [];
  };
  for (const operation of interpretation.operations) {
    if (operation.op === 'add') pending.push(semanticOperation(operation));
    else { flush(); operations.push(semanticOperation(operation)); }
  }
  flush();
  return stable({ operations, resultingPlan: semanticPlan(interpretation.resultingPlan) });
}
