import type { Filters } from './types.ts';

export function groupFilterCount(filters: Filters) {
  return Number(filters.partySize !== undefined) +
    Number(filters.totalBudget !== undefined);
}

export function groupFilterLabels(
  filters: Filters,
  formatMoney: (value: number) => string,
) {
  const labels: string[] = [];
  if (filters.partySize !== undefined)
    labels.push(`${filters.partySize} kişi`);
  if (filters.totalBudget !== undefined)
    labels.push(`Toplam bütçe ${formatMoney(filters.totalBudget)}`);
  return labels;
}
