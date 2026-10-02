import { createHash } from 'node:crypto';
import { validateRawRef } from './store.mjs';

/** A current-run handoff, never an upgrade of historical coverage. Full-cycle
 * publication requires a separate sealed inventory with matching fresh receipts. */
export function buildRawCollectionManifest({ startedAt, collectorRevision, inventory, receipts, fetches = [], horizon = null }) {
  if (!Number.isFinite(Date.parse(startedAt)) || !(receipts instanceof Map) || !Array.isArray(inventory))
    throw new Error('Invalid raw collection handoff');
  const entries = new Map();
  for (const entry of inventory) {
    if (!entry?.url || !['biletix', 'bubilet', 'biletinial'].includes(entry.provider))
      throw new Error('Invalid raw inventory entry');
    const previous = entries.get(entry.url);
    if (previous && previous.provider !== entry.provider) throw new Error('Conflicting raw inventory provider');
    entries.set(entry.url, entry);
  }
  const pages = [...entries.values()].sort((a, b) => a.url.localeCompare(b.url)).map(entry => {
    const receipt = receipts.get(entry.url);
    if (!receipt) return { provider: entry.provider, url: entry.url, status: 'unvisited', observedAt: startedAt };
    if (!['verified', 'failed', 'quarantined'].includes(receipt.status) || !Number.isFinite(Date.parse(receipt.observedAt)))
      throw new Error('Invalid raw page handoff');
    if (receipt.status === 'verified' && !receipt.rawObjectRef) throw new Error('Verified raw page is missing its body');
    if (receipt.rawObjectRef) validateRawRef(receipt.rawObjectRef);
    for (const observation of receipt.supplementaryRawObservations ?? []) {
      validateRawRef(observation.rawObjectRef);
      if (!observation.url || !Number.isFinite(Date.parse(observation.fetchedAt))) throw new Error('Invalid supplementary raw handoff');
    }
    return { provider: entry.provider, url: entry.url, ...receipt,
      ...(entry.category ? { fallbackCategory: entry.category } : {}) };
  });
  if (!Array.isArray(fetches) || fetches.length > 30000) throw new Error('Invalid raw fetch ledger');
  const body = { scope: 'partial', horizon, collectorRevision, inventory: pages.map(page => page.url), pages,
    fetches: [...fetches].sort((a, b) => a.fetchId.localeCompare(b.fetchId)) };
  const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return { id: `raw-run-${digest}`, ...body };
}
