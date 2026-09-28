import type { SourcePage } from './storage-contract.ts';

/** Empty pages require an explicit timestamp so older imports cannot revive them. */
export function sourcePageTimes(page: SourcePage) {
  if (page.events.some((event) => event.url !== page.url))
    throw new Error('Invalid source page');
  if (!page.events.length) {
    const stamp = Date.parse(page.retiredAt ?? '');
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString() !== page.retiredAt)
      throw new Error('Invalid source retirement');
    return { checked: page.retiredAt!, latest: page.retiredAt! };
  }
  if (page.retiredAt !== undefined) throw new Error('Nonempty retired source');
  const stamps = page.events.map((event) => event.checkedAt).sort();
  return { checked: stamps[0], latest: stamps.at(-1)! };
}
