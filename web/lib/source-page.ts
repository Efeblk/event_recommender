import type { SourcePage } from './storage-contract.ts';
import { isSourceQuarantineReason } from '../../contracts/source-evidence.ts';

/** Empty pages require an explicit timestamp so older imports cannot revive them. */
export function sourcePageTimes(page: SourcePage) {
  if (page.events.some((event) => event.url !== page.url))
    throw new Error('Invalid source page');
  if (!page.events.length) {
    const retired = page.retiredAt !== undefined;
    const quarantined = page.quarantinedAt !== undefined || page.quarantineReason !== undefined;
    if (!retired && !quarantined) throw new Error('Invalid source retirement');
    if (retired && quarantined) throw new Error('Invalid empty source page');
    if (quarantined && !isSourceQuarantineReason(page.quarantineReason))
      throw new Error('Invalid source quarantine');
    const value = retired ? page.retiredAt : page.quarantinedAt;
    const stamp = Date.parse(value ?? '');
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString() !== value)
      throw new Error(retired ? 'Invalid source retirement' : 'Invalid source quarantine');
    return { checked: value!, latest: value!, kind: retired ? 'retired' as const : 'quarantined' as const };
  }
  if (page.retiredAt !== undefined || page.quarantinedAt !== undefined || page.quarantineReason !== undefined)
    throw new Error('Nonempty inactive source');
  const stamps = page.events.map((event) => event.checkedAt).sort();
  return { checked: stamps[0], latest: stamps.at(-1)!, kind: 'active' as const };
}
