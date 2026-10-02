export const KINDS = ['', 'budget', 'party', 'companion', 'date', 'time', 'location', 'category', 'topic', 'experience', 'content'] as const;
export const TOPICS = ['photography', 'ceramics', 'jazz', 'gardening', 'history', 'classical'] as const;
export const VALUES = ['', 'partner', 'friends', 'family', 'children', 'district', 'neighborhood', 'concert', 'theatre', 'standup', 'workshop', 'exhibition', 'festival', 'sport', 'cinema', 'talk', 'dance', 'show', 'course', 'tour', 'museum', 'quiet', 'seated', 'outdoors', 'wheelchair_accessible', 'family_friendly', 'uncrowded', 'romantic', 'beginner_friendly', 'profanity', 'sexual_content', ...TOPICS] as const;
export interface WireNode { id: string; type: 'atom' | 'all' | 'any' | 'not'; children: string[]; kind: typeof KINDS[number]; value: typeof VALUES[number]; exact: string[]; refs: string[]; comparison: '' | 'lt' | 'lte' | 'gt' | 'gte' | 'approx'; basis: '' | 'per_person' | 'per_ticket' | 'group_total' }
export interface WireOperation { op: 'add' | 'replace' | 'remove' | 'keep' | 'reset' | 'order'; target: string; root: string; strength: '' | 'hard' | 'preferred'; value: '' | 'none' | 'soonest' | 'cheapest' | 'nearest'; refs: string[] }
export interface WireReading { nodes: WireNode[]; operations: WireOperation[] }
export interface WireResult { status: 'candidate' | 'ambiguous' | 'unsupported'; readings: WireReading[]; unresolved: string[]; discourse: string[] }
const string = { type: 'string' };
const strings = { type: 'array', items: string };
const enumeration = (values: readonly string[]) => ({ type: 'string', enum: values });
const object = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), propertyOrdering: Object.keys(properties) });
const node = object({ id: string, type: enumeration(['atom', 'all', 'any', 'not']), children: strings, kind: enumeration(KINDS), value: enumeration(VALUES), exact: strings, refs: strings, comparison: enumeration(['', 'lt', 'lte', 'gt', 'gte', 'approx']), basis: enumeration(['', 'per_person', 'per_ticket', 'group_total']) });
const operation = object({ op: enumeration(['add', 'replace', 'remove', 'keep', 'reset', 'order']), target: string, root: string, strength: enumeration(['', 'hard', 'preferred']), value: enumeration(['', 'none', 'soonest', 'cheapest', 'nearest']), refs: strings });
export const RESPONSE_SCHEMA = object({ status: enumeration(['candidate', 'ambiguous', 'unsupported']), readings: { type: 'array', items: object({ nodes: { type: 'array', items: node }, operations: { type: 'array', items: operation } }) }, unresolved: strings, discourse: strings });
