// Compact human-readable rendering of plan-contract conditions/operations.
export const atom = (a) => {
  switch (a.kind) {
    case 'budget': return `budget ${a.comparison} ${a.amount} ${a.basis}`;
    case 'date': return a.from === a.to ? `date ${a.from}` : `date ${a.from}..${a.to}`;
    case 'time': return `time ${a.from ?? ''}${a.fromExclusive ? '(x)' : ''}..${a.to ?? ''}${a.toExclusive ? '(x)' : ''}`;
    case 'location': return `loc ${a.name}/${a.precision}`;
    case 'party': return `party ${a.count}`;
    default: return `${a.kind} ${a.value}`;
  }
};
export const cond = (c) => c.type === 'atom' ? atom(c.atom) + (c.id ? `#${c.id}` : '')
  : c.type === 'not' ? `NOT(${cond(c.child)})` : `${c.type.toUpperCase()}(${c.children.map(cond).join(', ')})`;
export const op = (o) => o.op === 'add' ? `+${o.strength === 'hard' ? 'H' : 'P'} ${cond(o.condition)}`
  : o.op === 'replace' ? `~${o.targetId}${o.strength ? '/' + o.strength : ''} ${cond(o.condition)}`
  : o.op === 'order' ? `order=${o.value}` : o.op === 'reset' ? 'RESET' : `${o.op} ${o.targetId}`;
export const plan = (p) => p ? `[H: ${p.hard.children.map(cond).join('; ')} | P: ${p.preferences.map(cond).join('; ')} | order=${p.order}]` : '∅';
