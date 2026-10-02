import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const aliases = new Map([
  ['photo', 'topic:photography'], ['photography', 'topic:photography'], ['fotoğraf', 'topic:photography'],
  ['workshop', 'format:workshop'], ['atölye', 'format:workshop'], ['learning', 'experience:learning'],
  ['öğrenme', 'experience:learning'], ['quiet', 'environment:quiet'], ['sessiz', 'environment:quiet'],
  ['calm', 'environment:calm'], ['sakin', 'environment:calm'], ['botany', 'topic:botany'], ['botanik', 'topic:botany'],
  ['2000s', 'topic:2000s'], ["2000'ler", 'topic:2000s'], ['politics', 'topic:politics'], ['siyaset', 'topic:politics'],
]);
const typedAliases = new Map([
  ['activity:quiet', 'environment:quiet'], ['environment:quiet', 'environment:quiet'],
  ['audience:children', 'audience:children'], ['topic:photography', 'topic:photography'],
  ['activity:workshop', 'format:workshop'], ['format:workshop', 'format:workshop'],
]);
const filterKeys = ['date', 'dateFrom', 'dateTo', 'maxPrice', 'maxPriceExclusive', 'partySize', 'totalBudget', 'category', 'categories', 'categoryAny', 'excludedCategories', 'city', 'district', 'startTimeFrom', 'startTimeTo', 'startTimeFromExclusive', 'startTimeToExclusive'];
const sortUnique = (values) => [...new Set(values)].sort((a, b) => a.localeCompare(b));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort((a, b) => a.localeCompare(b)).map((key) => [key, canonical(value[key])])) : value;

function semanticValues(values, disposition) {
  const output = [];
  for (const item of values ?? []) {
    const raw = typeof item === 'string' ? item : item?.value;
    if (!raw) continue;
    if (/^[a-z]+:[a-z0-9_]+(?::[a-z0-9_]+)*$/i.test(raw)) output.push(raw);
    else {
      const composite = typeof item === 'object' && item?.kind ? `${item.kind}:${raw}`.toLocaleLowerCase('tr-TR') : null;
      const mapped = (composite ? typedAliases.get(composite) : null) ?? aliases.get(raw.toLocaleLowerCase('tr-TR').trim());
      if (mapped) output.push(mapped);
      else disposition.value = 'human_review_needed';
    }
  }
  return sortUnique(output);
}

function projectFilters(state) {
  const source = state?.filters ?? state ?? {};
  const filters = Object.fromEntries(filterKeys.filter((key) => source[key] !== undefined && source[key] !== null).map((key) => [key, source[key]]));
  if (!filters.date && filters.dateFrom && filters.dateFrom === filters.dateTo) {
    filters.date = filters.dateFrom;
    delete filters.dateFrom;
    delete filters.dateTo;
  }
  const categoryAliases = { Workshop: 'Atölye', Concert: 'Konser', Theatre: 'Tiyatro', 'Stand-up': 'Stand-up' };
  if (filters.category) {
    filters.categories = [categoryAliases[filters.category] ?? filters.category];
    delete filters.category;
  }
  return filters;
}

export function projectObservedState(rawState = {}, action = 'search') {
  const disposition = { value: undefined };
  const requirements = rawState.requirements ?? rawState.typedRequirements ?? [];
  if (requirements.some((item) => typeof item !== 'string' && !['require_support', 'exclude_positive_evidence'].includes(item?.policy))) disposition.value = 'human_review_needed';
  const required = semanticValues(requirements.filter?.((item) => typeof item === 'string' || item.policy === 'require_support') ?? requirements, disposition);
  const excluded = semanticValues((requirements.filter?.((item) => item?.policy === 'exclude_positive_evidence') ?? []).concat(rawState.excluded ?? []), disposition);
  const preferences = rawState.preferences;
  const preferenceValues = Array.isArray(preferences) ? preferences : preferences && typeof preferences === 'object'
    ? [...(preferences.interests ?? []), ...(preferences.experiences ?? []), ...(preferences.mood ? [preferences.mood] : []), ...(preferences.companion ? [`companion:${preferences.companion}`] : []), ...(preferences.order ? [`order:${preferences.order}`] : [])]
    : rawState.optional ?? [];
  const primaryTopics = semanticValues(rawState.primaryTopics ?? [], disposition);
  const optional = semanticValues(preferenceValues, disposition);
  const state = { action, filters: projectFilters(rawState), required: sortUnique([...required, ...primaryTopics]), excluded, optional, logic: rawState.logic === 'OR' ? 'OR' : 'AND' };
  return { state, disposition: disposition.value };
}

export function normalizeCapture(capture) {
  if (!Array.isArray(capture?.records)) throw new Error('Capture must contain records[]');
  return {
    schemaVersion: 1,
    id: 'normalized-quality-capture-v1',
    provenance: { captureType: 'observed-runtime-projection', source: capture.provenance ?? null, oracleLabelsUsed: false },
    cases: capture.records.map((record) => ({
      id: record.id,
      turns: (record.turns ?? []).map((turn, index) => {
        const issue = turn.result?.issue;
        const action = typeof issue === 'string' && issue.startsWith('unsupported_') ? 'refuse'
          : typeof issue === 'string' && issue.endsWith('_ambiguous') ? 'clarify'
          : turn.result?.action ?? 'search';
        const projected = projectObservedState(turn.result?.state ?? {}, action);
        const prior = projectObservedState(turn.previous ?? {}, 'search').state;
        const atomicStateUnchanged = ['clarify', 'refuse'].includes(action)
          ? JSON.stringify(canonical(turn.result?.state ?? {})) === JSON.stringify(canonical(turn.previous ?? {})) : undefined;
        return {
          id: `t${index + 1}`, message: turn.message,
          priorState: { committed: prior }, unresolvedRequest: turn.unresolvedRequest ?? null,
          pendingState: turn.unresolvedRequest ? { unresolvedRequest: turn.unresolvedRequest } : null,
          state: projected.state, cards: [], disposition: projected.disposition,
          ...(atomicStateUnchanged === undefined ? {} : { atomicStateUnchanged, atomicProof: 'complete-raw-state-comparison' }),
          usage: { retrievalCalls: 0, ...(Number.isFinite(turn.elapsedMs) ? { latencyMs: turn.elapsedMs } : {}) },
        };
      }),
    })),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = process.argv[2];
    if (!input) throw new Error('Usage: node scripts/normalize-quality-capture.mjs INPUT [OUTPUT]');
    const normalized = normalizeCapture(JSON.parse(await readFile(resolve(input), 'utf8')));
    const body = `${JSON.stringify(normalized, null, 2)}\n`;
    if (process.argv[3]) await writeFile(resolve(process.argv[3]), body, { flag: 'wx' });
    else process.stdout.write(body);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
