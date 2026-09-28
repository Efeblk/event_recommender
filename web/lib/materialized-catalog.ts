import { eventSessionIdentityKey, mergeEventSessions } from './event-merge.ts';
import { isEligible } from './search.ts';
import { emptyFilters, type EventRecord, type Filters } from './types.ts';
import { createHash } from 'node:crypto';
import { voyageDocumentText } from './voyage.ts';
import { prepareLexicalDocumentTokens } from './hybrid.ts';

export interface SearchCatalog {
  schemaVersion: 1;
  materializedAt: string;
  sourceStatus: Pick<EventRecord, 'startsAt' | 'checkedAt' | 'availability'>[];
  groups: { versions: { from: number; events: EventRecord[] }[] }[];
}

/** Publication-time work only. Prepare every change in source eligibility so
 * requests never need to reconstruct identities or retain an expired offer. */
export function buildSearchCatalog(events: EventRecord[], at: Date): SearchCatalog {
  const families = new Map<string, EventRecord[]>();
  let projectionBytes = 0;
  for (const event of events) {
    const checked = Date.parse(event.checkedAt);
    const activation = Math.max(at.getTime(), checked - 300000);
    if (!Number.isFinite(activation) || !isEligible(event, emptyFilters, new Date(activation))) continue;
    const key = eventSessionIdentityKey(event);
    const family = families.get(key);
    if (family) family.push(event);
    else families.set(key, [event]);
  }
  const groups = [...families.values()].map((members) => {
    const boundaries = new Set([at.getTime()]);
    for (const member of members) {
      const checked = Date.parse(member.checkedAt);
      for (const boundary of [checked - 300000, checked + 72 * 3600000 + 1, Date.parse(member.startsAt) + 1])
        if (boundary > at.getTime()) boundaries.add(boundary);
    }
    const versions: SearchCatalog['groups'][number]['versions'] = [];
    let previous = '';
    for (const from of [...boundaries].sort((a, b) => a - b)) {
      const merged = mergeEventSessions(members.filter((event) => isEligible(event, emptyFilters, new Date(from)))).map((event) => {
        const documentText = voyageDocumentText(event);
        return { ...event, preparedSearch: {
          version: 1 as const,
          documentText,
          documentHash: createHash('sha256').update(documentText).digest('hex'),
          lexicalTokens: prepareLexicalDocumentTokens(event),
        } };
      });
      const serialized = JSON.stringify(merged);
      if (serialized !== previous) {
        projectionBytes += new TextEncoder().encode(serialized).byteLength + 64;
        if (projectionBytes > 128 * 1024 * 1024) throw new Error('Search catalog exceeds limit');
        versions.push({ from, events: merged });
      }
      previous = serialized;
    }
    return { versions };
  });
  return { schemaVersion: 1, materializedAt: at.toISOString(), groups,
    sourceStatus: events.map(({ startsAt, checkedAt, availability }) => ({ startsAt, checkedAt, availability })),
  };
}

/** Select precomputed sessions; hard filters remain request-specific. */
export function searchCatalogCandidates(catalog: SearchCatalog, filters: Filters, at: Date): EventRecord[] {
  const time = at.getTime();
  if (!Number.isFinite(time) || time < Date.parse(catalog.materializedAt)) throw new Error('Search catalog predates requested time');
  return catalog.groups.flatMap(({ versions }) => {
    let selected: EventRecord[] = [];
    for (const version of versions) {
      if (version.from > time) break;
      selected = version.events;
    }
    return selected.filter((event) => isEligible(event, filters, at));
  }).sort((a, b) => a.startsAt.localeCompare(b.startsAt) || (a.source ?? '').localeCompare(b.source ?? '') || a.url.localeCompare(b.url) || a.id.localeCompare(b.id));
}
