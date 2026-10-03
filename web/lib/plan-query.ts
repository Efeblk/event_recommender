import type { Atom, Condition, Plan } from '../parser/contract.ts';

const categories: Record<string, string> = {
  concert: 'konser',
  theatre: 'tiyatro',
  standup: 'stand-up',
  workshop: 'at\u00f6lye',
  exhibition: 'sergi',
  festival: 'festival',
  sport: 'spor',
  cinema: 'sinema',
  talk: 's\u00f6yle\u015fi',
  dance: 'dans',
  show: 'g\u00f6steri',
  course: 'e\u011fitim',
  tour: 'gezi',
  museum: 'm\u00fcze',
};
const experiences: Record<string, string> = {
  quiet: 'sakin',
  seated: 'oturmal\u0131',
  outdoors: 'a\u00e7\u0131k hava',
  wheelchair_accessible: 'engelsiz eri\u015fim',
  family_friendly: 'aileye uygun',
  uncrowded: 'kalabal\u0131k olmayan',
  romantic: 'romantik',
  beginner_friendly: 'ba\u015flang\u0131\u00e7 seviyesine uygun',
};

function atomText(atom: Atom): string {
  switch (atom.kind) {
    case 'budget': {
      const basis =
        atom.basis === 'group_total'
          ? 'grup toplam\u0131'
          : atom.basis === 'per_person'
            ? 'ki\u015fi ba\u015f\u0131'
            : 'bilet';
      const comparison = {
        lt: 'alt\u0131',
        lte: 'veya alt\u0131',
        gt: '\u00fcst\u00fc',
        gte: 'veya \u00fcst\u00fc',
        approx: 'civar\u0131',
      }[atom.comparison];
      return `${basis}: ${atom.amount} TRY ${comparison}`;
    }
    case 'party':
      return `${atom.count} ki\u015fi`;
    case 'age':
      return `${atom.years} ya\u015f i\u00e7in uygun`;
    case 'mood':
      return atom.value === 'calm' ? 'sakin bir deneyim' : 'samimi bir deneyim';
    case 'companion':
      return `e\u015flik: ${{ partner: 'partner', friends: 'arkada\u015flar', family: 'aile', children: '\u00e7ocuklar' }[atom.value]}`;
    case 'date':
      return `tarih ${atom.from}\u2013${atom.to}`;
    case 'time':
      return `saat ${atom.from ? `${atom.fromExclusive ? '>' : '\u2265'}${atom.from}` : ''}${atom.from && atom.to ? ', ' : ''}${atom.to ? `${atom.toExclusive ? '<' : '\u2264'}${atom.to}` : ''}`;
    case 'location':
      if (atom.precision === 'side') return atom.name;
      return `${atom.precision === 'district' ? 'il\u00e7e' : 'mahalle'}: ${atom.name}`;
    case 'category':
      return categories[atom.value];
    case 'topic':
      return atom.value;
    case 'experience':
      return experiences[atom.value];
    case 'content':
      return atom.value === 'profanity'
        ? 'k\u00fcf\u00fcrl\u00fc i\u00e7erik'
        : 'cinsel i\u00e7erik';
  }
}

function conditionText(condition: Condition): string {
  if (condition.type === 'atom') return atomText(condition.atom);
  if (condition.type === 'not')
    return `(DE\u011e\u0130L ${conditionText(condition.child)})`;
  return `(${condition.children.map(conditionText).join(condition.type === 'all' ? ' VE ' : ' VEYA ')})`;
}

function positiveConcepts(condition: Condition, positive = true): string[] {
  if (condition.type === 'not')
    return positiveConcepts(condition.child, !positive);
  if (condition.type !== 'atom')
    return condition.children.flatMap((child) =>
      positiveConcepts(child, positive),
    );
  if (!positive) return [];
  const atom = condition.atom;
  if (
    atom.kind === 'category' ||
    atom.kind === 'topic' ||
    atom.kind === 'experience' ||
    atom.kind === 'companion' || atom.kind === 'mood' || atom.kind === 'age'
  )
    return [atomText(atom)];
  return [];
}

/** Compact, positive-only embedding/lexical retrieval input. */
export function planRetrievalQuery(plan: Plan): string {
  const concepts = [
    ...positiveConcepts(plan.hard),
    ...plan.preferences.flatMap((item) => positiveConcepts(item)),
  ];
  return [...new Set(concepts)].join(' ').slice(0, 1200);
}

/** Complete constraint display; unlike retrieval text, this is never truncated. */
export function planSummary(plan: Plan): {
  required: string[];
  preferred: string[];
} {
  const required =
    plan.hard.type === 'all'
      ? plan.hard.children.map(conditionText)
      : [conditionText(plan.hard)];
  const preferred = plan.preferences.map(conditionText);
  if (plan.order === 'soonest')
    preferred.push('en yak\u0131n tarihli olanlar \u00f6nce');
  if (plan.order === 'cheapest') preferred.push('en ucuz olanlar \u00f6nce');
  return { required, preferred };
}
