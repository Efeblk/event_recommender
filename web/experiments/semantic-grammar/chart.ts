/** Bounded Earley chart. Semantic values travel with derivations; no proximity rules. */
export interface Rule<V> { name: string; symbols: string[]; build: (values: V[]) => V | null }
export interface Edge<V> { end: number; value: V }
interface Item<V> { rule: number; dot: number; start: number; values: V[] }
export class ChartLimit extends Error { items: number; constructor(items: number) { super('chart_limit'); this.items = items; } }
export class AlternativeLimit extends Error { items: number; constructor(items: number) { super('alternative_limit'); this.items = items; } }

export function chart<V>(rules: Rule<V>[], length: number,
  scan: (terminal: string, position: number) => Edge<V>[],
  key: (value: V) => string, materialKey: (value: V) => string,
  maximum: number, maximumAlternatives: number): { values: V[]; items: number } {
  const columns = Array.from({ length: length + 1 }, () => ({ items: [] as Item<V>[], seen: new Set<string>() }));
  const names = new Map<string, number[]>();
  rules.forEach((rule, i) => names.set(rule.name, [...(names.get(rule.name) ?? []), i]));
  let count = 0;
  const insert = (column: number, item: Item<V>) => {
    const signature = `${item.rule}/${item.dot}/${item.start}/${item.values.map(key).join('\u0000')}`;
    if (columns[column].seen.has(signature)) return;
    if (count >= maximum) throw new ChartLimit(count);
    columns[column].seen.add(signature);
    columns[column].items.push(item);
    count++;
  };
  for (const rule of names.get('S') ?? []) insert(0, { rule, dot: 0, start: 0, values: [] });
  const results = new Map<string, V>();
  for (let end = 0; end <= length; end++) {
    for (let cursor = 0; cursor < columns[end].items.length; cursor++) {
      const item = columns[end].items[cursor];
      const rule = rules[item.rule];
      const symbol = rule.symbols[item.dot];
      if (symbol === undefined) {
        const value = rule.build(item.values);
        if (value === null) continue;
        if (rule.name === 'S' && item.start === 0 && end === length) {
          const signature = materialKey(value);
          if (!results.has(signature)) {
            if (results.size >= maximumAlternatives) throw new AlternativeLimit(count);
            results.set(signature, value);
          }
        }
        for (const parent of columns[item.start].items) {
          if (rules[parent.rule].symbols[parent.dot] === rule.name) {
            insert(end, { ...parent, dot: parent.dot + 1, values: [...parent.values, value] });
          }
        }
      } else if (symbol.startsWith('$')) {
        for (const edge of scan(symbol, end)) {
          if (edge.end <= end || edge.end > length) throw new Error('invalid lexical edge');
          insert(edge.end, { ...item, dot: item.dot + 1, values: [...item.values, edge.value] });
        }
      } else {
        for (const next of names.get(symbol) ?? []) insert(end, { rule: next, dot: 0, start: end, values: [] });
      }
    }
  }
  return { values: [...results.values()], items: count };
}
