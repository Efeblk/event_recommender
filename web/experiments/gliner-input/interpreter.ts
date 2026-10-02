import { buildInputCandidates, type Span } from '../../lib/input-candidates.ts';
import {
  emptyIntentState,
  intentQuery,
  validateIntentState,
  type IntentState,
} from '../../lib/input-state.ts';
import { CATEGORIES, type Category, type Filters } from '../../lib/types.ts';

export const EXPERIMENT_MODEL = 'jev-1.13.0' as const;
export const GLINER_PROPOSAL_THRESHOLD = 0.3;
export const JEV_PROBABILITY_THRESHOLD = 0.55;
export const JEV_CONFIDENCE_THRESHOLD = 0.1;
const MAX_QUESTIONS = 63;
const MAX_REQUEST_BYTES = 100_000;
const MAX_MESSAGE_LENGTH = 1_200;
const MAX_CLAUSES = 7;

export type ProposalMessage = 'current' | 'pending';
export interface ProposalAnchor {
  message: ProposalMessage;
  start: number;
  end: number;
  text: string;
}

export type GlinerSpanType =
  | 'budget_expression'
  | 'budget_basis'
  | 'budget_limit'
  | 'date_expression'
  | 'time_expression'
  | 'party_expression'
  | 'district'
  | 'category'
  | 'semantic_preference'
  | 'requirement_modifier'
  | 'correction_expression';

export interface RawGlinerSpan extends ProposalAnchor {
  type: string;
  /** Runner-normalized raw GLiNER score; this is not a Jev probability. */
  score: number;
}

export interface RawGlinerRelation extends ProposalAnchor {
  type: string;
  score: number;
  head?: ProposalAnchor;
  tail?: ProposalAnchor;
}

export interface GlinerProposals {
  /** Python emits Unicode-code-point offsets. UTF-16 is accepted for fixtures. */
  coordinateSpace?: 'python-codepoint' | 'utf16';
  spans?: RawGlinerSpan[];
  relations?: RawGlinerRelation[];
}

export interface ExperimentInput {
  message: string;
  previous: IntentState;
  now: Date;
  unresolvedRequest?: string;
  gliner?: GlinerProposals | null;
}

type ScalarKind = 'amount' | 'party' | 'date' | 'time' | 'district';
type CandidateValue = number | string | Record<string, unknown>;
interface ExactCandidate {
  id: string;
  kind: ScalarKind;
  anchor: ProposalAnchor;
  value: CandidateValue;
  operation?: { kind: 'delta'; delta: number };
}

interface Clause {
  id: string;
  anchor: ProposalAnchor;
  /** Candidate source spans only. They acquire no meaning until Jev selects one. */
  programSpans: ProposalAnchor[];
}

interface ValidatedGlinerSpan extends ProposalAnchor {
  type: GlinerSpanType;
  rawScore: number;
  rawStart: number;
  rawEnd: number;
  rawCoordinateSpace: 'python-codepoint' | 'utf16';
}

interface ValidatedGlinerRelation extends ProposalAnchor {
  type: string;
  rawScore: number;
  head?: ProposalAnchor;
  tail?: ProposalAnchor;
}

export interface ExperimentContext {
  version: 1;
  message: string;
  unresolvedRequest: string | null;
  previous: IntentState;
  now: string;
  candidates: ExactCandidate[];
  clauses: Clause[];
  gliner: {
    spans: ValidatedGlinerSpan[];
    relations: ValidatedGlinerRelation[];
    rejected: number;
  };
  questionOptions: Record<string, string[]>;
}

interface ChoiceQuestion {
  type: 'choice';
  instructions: string | Record<string, unknown>;
  criteria: Record<string, string | Record<string, unknown> | null>;
}

export interface ExperimentRequest {
  model: typeof EXPERIMENT_MODEL;
  state: Record<string, unknown>;
  questions: Record<string, ChoiceQuestion>;
}

export interface BuildExperimentResult {
  request: ExperimentRequest;
  context: ExperimentContext;
}

export type ExperimentIssue =
  | null
  | 'budget_ambiguous'
  | 'date_ambiguous'
  | 'arrival_time_ambiguous'
  | 'constraint_ambiguous'
  | 'unsupported_location'
  | 'unsupported_constraint'
  | 'interpreter_unavailable';

export interface ExperimentResult {
  state: IntentState;
  issue: ExperimentIssue;
  query: string;
  action: 'search' | 'alternatives' | 'reset';
  origin: 'jev';
  /** The original pending root survives every refusal and clears on success. */
  unresolvedRequest: string | null;
  diagnostics: {
    acceptedQuestions: string[];
    rejectedQuestions: string[];
    coverage: Record<string, string>;
    sourceSpans: ProposalAnchor[];
    unappliedPreferences: Array<{
      text: string;
      reason: 'unsupported_optional';
    }>;
    glinerProposalCount: number;
  };
}

const GLINER_TYPES = new Set<GlinerSpanType>([
  'budget_expression',
  'budget_basis',
  'budget_limit',
  'date_expression',
  'time_expression',
  'party_expression',
  'district',
  'category',
  'semantic_preference',
  'requirement_modifier',
  'correction_expression',
]);

const LEGACY_CATEGORY_IDS: Partial<Record<Category, string>> = {
  Konser: 'concert',
  Tiyatro: 'theatre',
  'Stand-up': 'standup',
};
const CATEGORY_IDS = new Map(
  CATEGORIES.map((category) => [
    category,
    `category_${
      LEGACY_CATEGORY_IDS[category] ??
      category
        .toLocaleLowerCase('tr-TR')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replaceAll('\u0131', 'i')
        .replace(/[^a-z0-9]+/g, '_')
    }`,
  ]),
);

const choice = (
  instructions: ChoiceQuestion['instructions'],
  options: readonly string[],
  descriptions: Record<string, string | Record<string, unknown> | null> = {},
): ChoiceQuestion => ({
  type: 'choice',
  instructions,
  criteria: Object.fromEntries(
    options.map((option) => [
      option,
      descriptions[option] ?? option.replaceAll('_', ' '),
    ]),
  ),
});

const requestBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

function sourceFor(
  marker: ProposalMessage,
  message: string,
  pending: string | null,
) {
  return marker === 'current' ? message : pending;
}

/** Convert a Python code-point boundary to a JavaScript UTF-16 boundary. */
export function pythonCodePointToUtf16(text: string, offset: number) {
  if (!Number.isInteger(offset) || offset < 0) return null;
  const points = Array.from(text);
  if (offset > points.length) return null;
  return points.slice(0, offset).join('').length;
}

function validateAnchor(
  raw: ProposalAnchor,
  coordinateSpace: 'python-codepoint' | 'utf16',
  message: string,
  pending: string | null,
): ProposalAnchor | null {
  if (
    !raw ||
    (raw.message !== 'current' && raw.message !== 'pending') ||
    typeof raw.text !== 'string' ||
    !raw.text ||
    !Number.isInteger(raw.start) ||
    !Number.isInteger(raw.end) ||
    raw.start < 0 ||
    raw.end <= raw.start
  )
    return null;
  const source = sourceFor(raw.message, message, pending);
  if (source == null) return null;
  const start =
    coordinateSpace === 'python-codepoint'
      ? pythonCodePointToUtf16(source, raw.start)
      : raw.start;
  const end =
    coordinateSpace === 'python-codepoint'
      ? pythonCodePointToUtf16(source, raw.end)
      : raw.end;
  if (
    start == null ||
    end == null ||
    end > source.length ||
    source.slice(start, end) !== raw.text
  )
    return null;
  return { message: raw.message, start, end, text: raw.text };
}

function validateGliner(
  input: GlinerProposals | null | undefined,
  message: string,
  pending: string | null,
) {
  const coordinateSpace = input?.coordinateSpace ?? 'python-codepoint';
  const spans = new Map<string, ValidatedGlinerSpan>();
  const relations: ValidatedGlinerRelation[] = [];
  let rejected = 0;
  for (const raw of input?.spans ?? []) {
    const anchor = validateAnchor(raw, coordinateSpace, message, pending);
    if (
      !anchor ||
      !GLINER_TYPES.has(raw.type as GlinerSpanType) ||
      !Number.isFinite(raw.score) ||
      raw.score < GLINER_PROPOSAL_THRESHOLD ||
      raw.score > 1
    ) {
      rejected++;
      continue;
    }
    const item: ValidatedGlinerSpan = {
      ...anchor,
      type: raw.type as GlinerSpanType,
      rawScore: raw.score,
      rawStart: raw.start,
      rawEnd: raw.end,
      rawCoordinateSpace: coordinateSpace,
    };
    // Same source occurrence may legitimately have several types. Only an
    // identical anchor+type is a duplicate; retain its strongest raw proposal.
    const key = `${item.message}:${item.start}:${item.end}:${item.type}`;
    const existing = spans.get(key);
    if (!existing || item.rawScore > existing.rawScore) spans.set(key, item);
  }
  for (const raw of input?.relations ?? []) {
    const anchor = validateAnchor(raw, coordinateSpace, message, pending);
    const head = raw.head
      ? validateAnchor(raw.head, coordinateSpace, message, pending)
      : undefined;
    const tail = raw.tail
      ? validateAnchor(raw.tail, coordinateSpace, message, pending)
      : undefined;
    if (
      !anchor ||
      typeof raw.type !== 'string' ||
      !raw.type ||
      !Number.isFinite(raw.score) ||
      raw.score < GLINER_PROPOSAL_THRESHOLD ||
      raw.score > 1 ||
      (raw.head && !head) ||
      (raw.tail && !tail)
    ) {
      rejected++;
      continue;
    }
    relations.push({
      ...anchor,
      type: raw.type,
      rawScore: raw.score,
      ...(head ? { head } : {}),
      ...(tail ? { tail } : {}),
    });
  }
  return { spans: [...spans.values()], relations, rejected };
}

function locateSpan(
  marker: ProposalMessage,
  source: string,
  item: Span<unknown>,
  claimed: Set<string>,
): ProposalAnchor | null {
  const explicit = item.sourceSpans?.find(
    ({ start, end }) =>
      source.slice(start, end) === item.text && !claimed.has(`${start}:${end}`),
  );
  if (explicit) {
    claimed.add(`${explicit.start}:${explicit.end}`);
    return { message: marker, ...explicit, text: item.text };
  }
  let start = -1;
  while ((start = source.indexOf(item.text, start + 1)) >= 0) {
    const key = `${start}:${start + item.text.length}`;
    if (!claimed.has(key)) {
      claimed.add(key);
      return {
        message: marker,
        start,
        end: start + item.text.length,
        text: item.text,
      };
    }
  }
  return null;
}

function exactCandidates(
  message: string,
  pending: string | null,
  now: Date,
  previous: IntentState,
) {
  const result: ExactCandidate[] = [];
  const counters: Record<ScalarKind, number> = {
    amount: 0,
    party: 0,
    date: 0,
    time: 0,
    district: 0,
  };
  const prefixes: Record<ScalarKind, string> = {
    amount: 'a',
    party: 'p',
    date: 'd',
    time: 't',
    district: 'l',
  };
  for (const [marker, source] of [
    ['pending', pending],
    ['current', message],
  ] as const) {
    if (!source) continue;
    const pool = buildInputCandidates(source, now, previous);
    const groups: Array<[ScalarKind, Span<unknown>[]]> = [
      ['amount', pool.amounts],
      ['party', pool.parties],
      ['date', pool.dates],
      ['time', pool.times],
      ['district', pool.districts],
    ];
    for (const [kind, items] of groups) {
      const claimed = new Set<string>();
      for (const item of items) {
        const anchor = locateSpan(marker, source, item, claimed);
        if (!anchor) continue;
        result.push({
          id: `${prefixes[kind]}${counters[kind]++}`,
          kind,
          anchor,
          value: item.value as CandidateValue,
          ...(item.operation ? { operation: item.operation } : {}),
        });
      }
    }
  }
  return result;
}

function trimAnchor(
  source: string,
  marker: ProposalMessage,
  start: number,
  end: number,
) {
  while (start < end && /[\s,;:!?()[\]{}]/u.test(source[start])) start++;
  while (end > start && /[\s,;:!?()[\]{}.]/u.test(source[end - 1])) end--;
  return start < end
    ? { message: marker, start, end, text: source.slice(start, end) }
    : null;
}

function splitClauses(
  source: string,
  marker: ProposalMessage,
): ProposalAnchor[] {
  const ranges: ProposalAnchor[] = [];
  let start = 0;
  let quote: string | null = null;
  const closing: Record<string, string> = { '“': '”', '‘': '’' };
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === '“' || character === '‘') {
      quote = closing[character] ?? character;
      continue;
    }
    const numeric =
      /\d/u.test(source[index - 1] ?? '') &&
      /\d/u.test(source[index + 1] ?? '');
    if (/[;!?\n]/u.test(character) || (/[,.]/u.test(character) && !numeric)) {
      const anchor = trimAnchor(source, marker, start, index);
      if (anchor) ranges.push(anchor);
      start = index + 1;
    }
  }
  const last = trimAnchor(source, marker, start, source.length);
  if (last) ranges.push(last);
  if (ranges.length <= MAX_CLAUSES) return ranges;
  const retained = ranges.slice(0, MAX_CLAUSES - 1);
  const restStart = ranges[MAX_CLAUSES - 1].start;
  const merged = trimAnchor(source, marker, restStart, source.length);
  if (merged) retained.push(merged);
  return retained;
}

function overlaps(a: ProposalAnchor, b: ProposalAnchor) {
  return a.message === b.message && a.start < b.end && b.start < a.end;
}

function makeProgramSpan(clause: ProposalAnchor, candidates: ExactCandidate[]) {
  const source = clause.text;
  const holes = candidates
    .filter((candidate) => overlaps(clause, candidate.anchor))
    .map((candidate) => ({
      start: Math.max(0, candidate.anchor.start - clause.start),
      end: Math.min(source.length, candidate.anchor.end - clause.start),
    }))
    .sort((a, b) => a.start - b.start);
  const runs: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const hole of holes) {
    if (hole.start > cursor) runs.push({ start: cursor, end: hole.start });
    cursor = Math.max(cursor, hole.end);
  }
  if (cursor < source.length) runs.push({ start: cursor, end: source.length });
  const anchors = runs.flatMap((run) => {
    let text = source.slice(run.start, run.end);
    let relativeStart = run.start;
    const leading =
      /^(?:\s|[,;:])*(?:(?:please|lütfen|lutfen|mümkünse|mumkunse|tercihen|preferably|ideally|mutlaka|kesinlikle)\b(?:\s|[,;:])*)+/iu.exec(
        text,
      )?.[0].length ?? 0;
    relativeStart += leading;
    text = text.slice(leading);
    const trailing =
      /(?:\s|[,;:])*(?:(?:olsun|istiyorum|isterim|arıyorum|ariyorum|please)\b(?:\s|[,;:])*)+$/iu.exec(
        text,
      )?.[0].length ?? 0;
    const relativeEnd = run.end - trailing;
    const anchor = trimAnchor(
      source,
      clause.message,
      relativeStart,
      relativeEnd,
    );
    return anchor && /\p{L}/u.test(anchor.text)
      ? [
          {
            ...anchor,
            start: anchor.start + clause.start,
            end: anchor.end + clause.start,
          },
        ]
      : [];
  });
  return anchors;
}

function buildClauses(
  message: string,
  pending: string | null,
  candidates: ExactCandidate[],
  gliner: ValidatedGlinerSpan[],
) {
  const anchors = [
    ...(pending ? splitClauses(pending, 'pending') : []),
    ...splitClauses(message, 'current'),
  ];
  // Preserve every source character in a coverage unit. When punctuation
  // creates too many units, merge adjacent units from the same message.
  while (anchors.length > MAX_CLAUSES) {
    let merged = false;
    for (let index = anchors.length - 2; index >= 0; index--) {
      const first = anchors[index],
        last = anchors[index + 1];
      if (first.message !== last.message) continue;
      const source = sourceFor(first.message, message, pending)!;
      anchors.splice(index, 2, {
        message: first.message,
        start: first.start,
        end: last.end,
        text: source.slice(first.start, last.end),
      });
      merged = true;
      break;
    }
    if (!merged) throw new Error('Clause coverage budget exceeded.');
  }
  return anchors.map((anchor, index): Clause => {
    const proposals = gliner
      .filter(
        (item) =>
          item.type === 'semantic_preference' &&
          item.message === anchor.message &&
          item.start >= anchor.start &&
          item.end <= anchor.end,
      )
      .map(({ message: marker, start, end, text }) => ({
        message: marker,
        start,
        end,
        text,
      }));
    const generated = makeProgramSpan(anchor, candidates);
    const unique = new Map<string, ProposalAnchor>();
    for (const item of [...proposals, ...generated, anchor])
      unique.set(`${item.message}:${item.start}:${item.end}`, item);
    return {
      id: `c${index}`,
      anchor,
      programSpans: [...unique.values()].slice(0, 8),
    };
  });
}

function stateCandidates(candidates: ExactCandidate[]) {
  return Object.fromEntries(
    (['amount', 'party', 'date', 'time', 'district'] as const).map((kind) => [
      `${kind}s`,
      candidates
        .filter((item) => item.kind === kind)
        .map((item) => ({
          id: item.id,
          anchor: item.anchor,
          value: item.value,
          ...(item.operation ? { operation: item.operation } : {}),
        })),
    ]),
  );
}

export function buildExperimentRequest(
  input: ExperimentInput,
): BuildExperimentResult {
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.valueOf()))
    throw new Error('Invalid experiment time.');
  if (
    typeof input.message !== 'string' ||
    !input.message.trim() ||
    input.message.length > MAX_MESSAGE_LENGTH
  )
    throw new Error('Current message must contain 1-1,200 characters.');
  const pending = input.unresolvedRequest?.trim() || null;
  if (pending && pending.length > MAX_MESSAGE_LENGTH)
    throw new Error('Pending message must contain at most 1,200 characters.');
  const previous = validateIntentState(input.previous);
  const gliner = validateGliner(input.gliner, input.message, pending);
  const candidates = exactCandidates(
    input.message,
    pending,
    input.now,
    previous,
  );
  const clauses = buildClauses(
    input.message,
    pending,
    candidates,
    gliner.spans,
  );
  if (!clauses.length) throw new Error('No complete source clause.');

  const byKind = (kind: ScalarKind) =>
    candidates.filter((item) => item.kind === kind);
  const scalarOptions = (kind: ScalarKind) => [
    'keep',
    'remove',
    ...byKind(kind).map((item) => `set:${item.id}`),
    'unresolved',
  ];
  const scalarDescriptions = (kind: ScalarKind) =>
    Object.fromEntries(
      byKind(kind).map((item) => [
        `set:${item.id}`,
        `Set from exact normalized candidate \`candidates.${kind}s\` with id ${item.id}. The source anchor is authoritative.`,
      ]),
    );
  const questions: Record<string, ChoiceQuestion> = {
    action: choice(
      'Classify the current turn. A correction or clarification completes the pending request. Reset requires an explicit reset command.',
      ['search', 'alternatives', 'reset', 'unresolved'],
    ),
    logic: choice(
      'Classify Boolean structure across independently represented fields. Category alternatives are representable; an OR joining different fields is not.',
      ['ordinary_and', 'category_or', 'mixed_field_or', 'unresolved'],
    ),
    budget: choice(
      'Apply the latest price ceiling. Select only an exact amount candidate; a selected normalized value is authoritative.',
      scalarOptions('amount'),
      scalarDescriptions('amount'),
    ),
    budget_basis: choice(
      'Classify the selected nonzero budget basis without guessing. Explicit current wording wins; inherited applies only when an established prior basis is unchanged.',
      ['per_person', 'group_total', 'inherited', 'none', 'unresolved'],
    ),
    budget_boundary: choice(
      'Classify whether a selected ceiling includes the exact amount.',
      ['inclusive', 'exclusive', 'none', 'unresolved'],
    ),
    party: choice(
      'Apply party size. For a delta candidate, code applies its delta to actual prior state.',
      scalarOptions('party'),
      scalarDescriptions('party'),
    ),
    date: choice(
      'Apply an exact normalized date candidate.',
      scalarOptions('date'),
      scalarDescriptions('date'),
    ),
    time: choice(
      'Apply an exact normalized time candidate.',
      scalarOptions('time'),
      scalarDescriptions('time'),
    ),
    district: choice(
      'Apply an exact Istanbul district candidate. A required location outside Istanbul or unsupported Istanbul geography must use unsupported_location.',
      [...scalarOptions('district'), 'unsupported_location'],
      scalarDescriptions('district'),
    ),
    quiet: choice(
      'Apply only an explicit quiet/noise condition. General calm mood does not establish quiet.',
      ['keep', 'remove', 'require', 'prefer', 'exclude', 'unresolved'],
    ),
    mood: choice(
      'Apply the requested general mood independently from an explicit quiet/noise evidence condition.',
      [
        'keep',
        'remove',
        'set:calm',
        'set:energetic',
        'set:uplifting',
        'unresolved',
      ],
    ),
    companion: choice('Apply companion context.', [
      'keep',
      'remove',
      'set:partner',
      'set:friends',
      'set:family',
      'unresolved',
    ]),
    order: choice('Apply chronological event ordering.', [
      'keep',
      'remove',
      'soonest',
      'unresolved',
    ]),
  };
  for (const category of CATEGORIES) {
    const id = CATEGORY_IDS.get(category)!;
    questions[id] = choice(
      `Apply catalog category ${category} independently. Optional means a preference, never a hard include.`,
      ['keep', 'include', 'exclude', 'remove', 'optional', 'unresolved'],
    );
  }
  for (const clause of clauses) {
    const path = `clauses.${clause.id}`;
    questions[`coverage_${clause.id}`] = choice(
      {
        question: `What accounts for every meaningful word in \`${path}.anchor.text\`? A clause is a coverage unit, never automatically a topic.`,
        typed_condition:
          'All meaning belongs to scalar/category/quiet/companion/order operations selected elsewhere.',
        program_preference:
          'The clause contains an event-program subject or source-backed predicate that must be retained.',
        discourse:
          'Only discourse, politeness, action, or a modifier already owned by another selected operation.',
        explicitly_superseded:
          'The clause is explicitly corrected or replaced by a later clause.',
        unresolved:
          'Some meaningful words remain unowned or the function is unclear.',
      },
      [
        'typed_condition',
        'program_preference',
        'discourse',
        'explicitly_superseded',
        'unresolved',
      ],
    );
    questions[`program_${clause.id}`] = choice(
      {
        question: `If this is a program preference, select its exact source-backed predicate from \`${path}.programSpans\`. Preserve within-predicate OR. Never select budget/date/party/location words, maximum/under/total modifiers, politeness, or correction discourse.`,
        candidates: clause.programSpans.map((span, index) => ({
          id: `span:${index}`,
          text: span.text,
        })),
      },
      [
        'none',
        ...clause.programSpans.map((_, index) => `span:${index}`),
        'unresolved',
      ],
    );
    questions[`modality_${clause.id}`] = choice(
      `Classify modality of the clause's represented condition. Optional wording scopes only its own predicate.`,
      ['mandatory', 'optional', 'none', 'unresolved'],
    );
    questions[`polarity_${clause.id}`] = choice(
      'Classify polarity of the clause condition.',
      ['include', 'exclude', 'remove', 'none', 'unresolved'],
    );
    questions[`capability_${clause.id}`] = choice(
      'Classify whether the condition is representable by the experiment. Istanbul exact districts and the stated experiment fields are supported. Optional unsupported wishes remain explicit preferences; mandatory unsupported conditions block.',
      [
        'supported',
        'unsupported_location',
        'unsupported_constraint',
        'none',
        'unresolved',
      ],
    );
  }
  if (Object.keys(questions).length > MAX_QUESTIONS)
    throw new Error('Experiment question budget exceeded.');
  const state = {
    messages: { current: input.message, pending },
    previous,
    now: input.now.toISOString(),
    candidates: stateCandidates(candidates),
    clauses: Object.fromEntries(
      clauses.map((clause) => [
        clause.id,
        {
          anchor: clause.anchor,
          programSpans: clause.programSpans,
        },
      ]),
    ),
    gliner: { spans: gliner.spans, relations: gliner.relations },
    supported: {
      city: 'Istanbul',
      categories: CATEGORIES,
      fields: [
        'budget',
        'budget_basis',
        'date',
        'time',
        'party',
        'district',
        'quiet',
        'companion',
        'order',
        'program preference',
      ],
    },
  };
  const request: ExperimentRequest = {
    model: EXPERIMENT_MODEL,
    state,
    questions,
  };
  if (requestBytes(request) > MAX_REQUEST_BYTES)
    throw new Error('Experiment request exceeds 100 KB.');
  const questionOptions = Object.fromEntries(
    Object.entries(questions).map(([id, question]) => [
      id,
      Object.keys(question.criteria),
    ]),
  );
  return {
    request,
    context: {
      version: 1,
      message: input.message,
      unresolvedRequest: pending,
      previous,
      now: input.now.toISOString(),
      candidates,
      clauses,
      gliner,
      questionOptions,
    },
  };
}

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function parseAnswer(
  value: unknown,
  options: readonly string[],
  id: string,
): ChoiceAnswer {
  const answer = record(value, `Answer ${id}`);
  const probabilities = record(answer.probabilities, `Probabilities ${id}`);
  if (
    answer.type !== 'choice' ||
    typeof answer.choice !== 'string' ||
    !options.includes(answer.choice) ||
    typeof answer.confidence !== 'number' ||
    !Number.isFinite(answer.confidence) ||
    answer.confidence < 0 ||
    answer.confidence > 1 ||
    Object.keys(probabilities).length !== options.length ||
    options.some(
      (option) =>
        typeof probabilities[option] !== 'number' ||
        !Number.isFinite(probabilities[option]) ||
        (probabilities[option] as number) < 0 ||
        (probabilities[option] as number) > 1,
    )
  )
    throw new Error(`Invalid Choice answer: ${id}.`);
  const sum = options.reduce(
    (total, option) => total + (probabilities[option] as number),
    0,
  );
  const selected = probabilities[answer.choice] as number;
  const max = Math.max(
    ...options.map((option) => probabilities[option] as number),
  );
  if (Math.abs(sum - 1) > 0.015 || selected + 1e-9 < max)
    throw new Error(`Invalid Choice distribution: ${id}.`);
  return {
    type: 'choice',
    choice: answer.choice,
    confidence: answer.confidence,
    probabilities: probabilities as Record<string, number>,
  };
}

function applyRequirement(
  state: IntentState,
  value: 'quiet',
  operation: string,
) {
  const without = state.requirements.filter(
    (item) =>
      !(item.kind === 'activity' && item.value.split('|').includes(value)),
  );
  if (operation === 'require')
    without.push({ kind: 'activity', value, policy: 'require_support' });
  if (operation === 'exclude')
    without.push({
      kind: 'activity',
      value,
      policy: 'exclude_positive_evidence',
    });
  state.requirements = without;
}

function refuse(
  context: ExperimentContext,
  issue: Exclude<ExperimentIssue, null>,
  action: ExperimentResult['action'],
  diagnostics: ExperimentResult['diagnostics'],
): ExperimentResult {
  return {
    state: context.previous,
    issue,
    query: intentQuery(context.previous),
    action,
    origin: 'jev',
    unresolvedRequest: context.unresolvedRequest ?? context.message,
    diagnostics,
  };
}

function scalarChoice(
  answer: ChoiceAnswer,
  kind: ScalarKind,
  context: ExperimentContext,
) {
  if (!answer.choice.startsWith('set:')) return null;
  const id = answer.choice.slice(4);
  return (
    context.candidates.find((item) => item.kind === kind && item.id === id) ??
    null
  );
}

function categoryForQuestion(id: string) {
  return [...CATEGORY_IDS].find(([, question]) => question === id)?.[0] ?? null;
}

export function compileExperimentResponse(
  response: unknown,
  context: ExperimentContext,
): ExperimentResult {
  if (!context || context.version !== 1)
    throw new Error('Invalid experiment context.');
  const envelope = record(response, 'Jev response');
  if (envelope.model !== EXPERIMENT_MODEL)
    throw new Error('Unexpected Jev model.');
  const rawAnswers = record(envelope.answers, 'Jev answers');
  if (
    Object.keys(rawAnswers).length !==
      Object.keys(context.questionOptions).length ||
    Object.keys(rawAnswers).some((id) => !context.questionOptions[id])
  )
    throw new Error('Jev answer set does not match the request.');
  const answers = new Map<string, ChoiceAnswer>();
  for (const [id, options] of Object.entries(context.questionOptions))
    answers.set(id, parseAnswer(rawAnswers[id], options, id));
  const acceptedQuestions: string[] = [];
  const rejectedQuestions: string[] = [];
  const reliable = (id: string) => {
    const answer = answers.get(id)!;
    const ok =
      answer.probabilities[answer.choice] >= JEV_PROBABILITY_THRESHOLD &&
      answer.confidence >= JEV_CONFIDENCE_THRESHOLD;
    (ok ? acceptedQuestions : rejectedQuestions).push(id);
    return ok;
  };
  const coverage: Record<string, string> = {};
  const sourceSpans: ProposalAnchor[] = [];
  const unappliedPreferences: Array<{
    text: string;
    reason: 'unsupported_optional';
  }> = [];
  const diagnostics = {
    acceptedQuestions,
    rejectedQuestions,
    coverage,
    sourceSpans,
    unappliedPreferences,
    glinerProposalCount: context.gliner.spans.length,
  };

  const folded = (text: string) =>
    text
      .toLocaleLowerCase('tr-TR')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replaceAll('\u0131', 'i');
  const exactProgramTarget = (text: string) => {
    const key = folded(text.trim());
    return (
      [
        ...(context.previous.primaryTopics ?? []).map((value) => ({
          kind: 'topic' as const,
          value,
        })),
        ...context.previous.preferences.interests.map((value) => ({
          kind: 'interest' as const,
          value,
        })),
      ].find((item) => folded(item.value) === key) ?? null
    );
  };
  const typedClauseOwned = (clause: Clause, capability: string) => {
    if (
      capability === 'unsupported_location' ||
      capability === 'unsupported_constraint'
    )
      return true;
    const fieldByKind: Record<ScalarKind, string> = {
      amount: 'budget',
      party: 'party',
      date: 'date',
      time: 'time',
      district: 'district',
    };
    const exact = context.candidates.filter((candidate) =>
      overlaps(clause.anchor, candidate.anchor),
    );
    const groups = new Map<ScalarKind, ExactCandidate[]>();
    for (const candidate of exact) {
      groups.set(candidate.kind, [
        ...(groups.get(candidate.kind) ?? []),
        candidate,
      ]);
    }
    if (
      [...groups].some(([kind, group]) => {
        const field = fieldByKind[kind];
        return !group.some(
          (candidate) => answers.get(field)!.choice === `set:${candidate.id}`,
        );
      })
    )
      return false;
    if (groups.size) return true;
    const clauseText = folded(clause.anchor.text);
    const categoryOwned = [...CATEGORY_IDS].some(
      ([category, id]) =>
        answers.get(id)!.choice !== 'keep' &&
        clauseText.includes(folded(category)),
    );
    const boundedOwner = ['quiet', 'mood', 'companion', 'order'].some(
      (id) => !['keep', 'unresolved'].includes(answers.get(id)!.choice),
    );
    const keptBudgetOwner =
      answers.get('budget')!.choice === 'keep' &&
      ['group_total', 'per_person', 'inherited'].includes(
        answers.get('budget_basis')!.choice,
      ) &&
      reliable('budget_basis');
    return categoryOwned || boundedOwner || keptBudgetOwner;
  };

  const actionAnswer = answers.get('action')!;
  const action =
    actionAnswer.choice === 'alternatives' || actionAnswer.choice === 'reset'
      ? actionAnswer.choice
      : 'search';
  if (!reliable('action') || actionAnswer.choice === 'unresolved')
    return refuse(context, 'constraint_ambiguous', action, diagnostics);
  const logic = answers.get('logic')!;
  if (
    !reliable('logic') ||
    logic.choice === 'mixed_field_or' ||
    logic.choice === 'unresolved'
  )
    return refuse(context, 'constraint_ambiguous', action, diagnostics);

  let blockingIssue: ExperimentIssue = null;
  for (const clause of context.clauses) {
    const coverageId = `coverage_${clause.id}`;
    if (!reliable(coverageId)) {
      blockingIssue ??= 'constraint_ambiguous';
      continue;
    }
    const coverageAnswer = answers.get(coverageId)!.choice;
    coverage[clause.id] = coverageAnswer;
    if (coverageAnswer === 'unresolved') {
      blockingIssue ??= 'constraint_ambiguous';
      continue;
    }
    if (coverageAnswer === 'typed_condition') {
      const capabilityId = `capability_${clause.id}`;
      if (!reliable(capabilityId)) {
        blockingIssue ??= 'constraint_ambiguous';
        continue;
      }
      const capability = answers.get(capabilityId)!.choice;
      if (capability === 'unresolved' || capability === 'none') {
        blockingIssue ??= 'constraint_ambiguous';
        continue;
      }
      if (!typedClauseOwned(clause, capability)) {
        blockingIssue ??= 'constraint_ambiguous';
        continue;
      }
      if (capability === 'supported') continue;
      const modalityId = `modality_${clause.id}`;
      const polarityId = `polarity_${clause.id}`;
      if (!reliable(modalityId) || !reliable(polarityId)) {
        blockingIssue ??= 'constraint_ambiguous';
        continue;
      }
      const modality = answers.get(modalityId)!.choice;
      const polarity = answers.get(polarityId)!.choice;
      if (
        modality === 'unresolved' ||
        modality === 'none' ||
        polarity === 'unresolved' ||
        polarity === 'none'
      ) {
        blockingIssue ??= 'constraint_ambiguous';
        continue;
      }
      sourceSpans.push(clause.anchor);
      if (polarity === 'exclude') blockingIssue = 'unsupported_constraint';
      else if (
        modality === 'mandatory' &&
        capability === 'unsupported_location'
      )
        blockingIssue = 'unsupported_location';
      else if (modality === 'mandatory')
        blockingIssue ??= 'unsupported_constraint';
      else if (modality === 'optional')
        unappliedPreferences.push({
          text: clause.anchor.text,
          reason: 'unsupported_optional',
        });
      continue;
    }
    // Independent speculative questions cannot see the coverage answer. Their
    // confidence is deliberately ignored unless this branch consumes them.
    if (coverageAnswer !== 'program_preference') continue;
    const branchIds = ['program', 'modality', 'polarity', 'capability'].map(
      (name) => `${name}_${clause.id}`,
    );
    if (branchIds.some((id) => !reliable(id))) {
      blockingIssue ??= 'constraint_ambiguous';
      continue;
    }
    const [program, modality, polarity, capability] = branchIds.map(
      (id) => answers.get(id)!.choice,
    );
    if ([program, modality, polarity, capability].includes('unresolved')) {
      blockingIssue ??= 'constraint_ambiguous';
      continue;
    }
    if ([modality, polarity, capability].includes('none')) {
      blockingIssue ??= 'constraint_ambiguous';
      continue;
    }
    const selectedSpan = program.startsWith('span:')
      ? clause.programSpans[Number(program.slice(5))]
      : null;
    if (!selectedSpan) {
      blockingIssue ??= 'constraint_ambiguous';
      continue;
    }
    if (polarity === 'remove' && !exactProgramTarget(selectedSpan.text)) {
      blockingIssue ??= 'constraint_ambiguous';
      continue;
    }
    if (selectedSpan) sourceSpans.push(selectedSpan);
    if (polarity === 'exclude') {
      blockingIssue = 'unsupported_constraint';
      continue;
    }
    if (capability === 'unsupported_location' && modality === 'mandatory')
      blockingIssue = 'unsupported_location';
    else if (
      capability === 'unsupported_constraint' &&
      modality === 'mandatory'
    )
      blockingIssue ??= 'unsupported_constraint';
    else if (
      (capability === 'unsupported_location' ||
        capability === 'unsupported_constraint') &&
      modality === 'optional' &&
      selectedSpan
    )
      unappliedPreferences.push({
        text: selectedSpan.text,
        reason: 'unsupported_optional',
      });
  }
  const districtAnswer = answers.get('district')!;
  if (!reliable('district') || districtAnswer.choice === 'unresolved')
    blockingIssue ??= 'constraint_ambiguous';
  if (districtAnswer.choice === 'unsupported_location')
    blockingIssue = 'unsupported_location';
  if (blockingIssue) return refuse(context, blockingIssue, action, diagnostics);

  let state =
    action === 'reset' ? emptyIntentState() : structuredClone(context.previous);
  const filters: Filters = { ...state.filters };
  const scalarIds: Array<
    [ScalarKind, 'budget' | 'party' | 'date' | 'time' | 'district']
  > = [
    ['amount', 'budget'],
    ['party', 'party'],
    ['date', 'date'],
    ['time', 'time'],
    ['district', 'district'],
  ];
  for (const [, id] of scalarIds) {
    const answer = answers.get(id)!;
    if (!reliable(id) || answer.choice === 'unresolved')
      return refuse(
        context,
        id === 'budget'
          ? 'budget_ambiguous'
          : id === 'date'
            ? 'date_ambiguous'
            : 'constraint_ambiguous',
        action,
        diagnostics,
      );
  }

  const partyAnswer = answers.get('party')!;
  const partyCandidate = scalarChoice(partyAnswer, 'party', context);
  let selectedParty: number | undefined;
  if (partyCandidate) {
    selectedParty =
      partyCandidate.operation?.kind === 'delta'
        ? context.previous.filters.partySize == null
          ? undefined
          : context.previous.filters.partySize + partyCandidate.operation.delta
        : (partyCandidate.value as number);
    if (
      !Number.isInteger(selectedParty) ||
      selectedParty! < 1 ||
      selectedParty! > 100
    )
      return refuse(context, 'constraint_ambiguous', action, diagnostics);
    filters.partySize = selectedParty;
    sourceSpans.push(partyCandidate.anchor);
  } else if (partyAnswer.choice === 'remove') {
    delete filters.partySize;
    delete filters.totalBudget;
  }

  const budgetAnswer = answers.get('budget')!;
  const budgetCandidate = scalarChoice(budgetAnswer, 'amount', context);
  const basis = answers.get('budget_basis')!;
  const boundary = answers.get('budget_boundary')!;
  if (budgetCandidate) {
    if (
      !reliable('budget_basis') ||
      !reliable('budget_boundary') ||
      basis.choice === 'unresolved' ||
      boundary.choice === 'unresolved' ||
      (budgetCandidate.value !== 0 &&
        (basis.choice === 'none' || boundary.choice === 'none'))
    )
      return refuse(context, 'budget_ambiguous', action, diagnostics);
    let resolvedBasis = basis.choice;
    if (resolvedBasis === 'inherited') {
      resolvedBasis =
        context.previous.filters.totalBudget != null
          ? 'group_total'
          : context.previous.filters.maxPrice != null
            ? 'per_person'
            : 'none';
    }
    const amount = budgetCandidate.value as number;
    if (amount === 0) {
      filters.maxPrice = 0;
      delete filters.totalBudget;
    } else if (resolvedBasis === 'group_total') {
      const size = selectedParty ?? filters.partySize;
      if (!size)
        return refuse(context, 'budget_ambiguous', action, diagnostics);
      filters.totalBudget = amount;
      filters.partySize = size;
      filters.maxPrice = amount / size;
    } else if (resolvedBasis === 'per_person') {
      filters.maxPrice = amount;
      delete filters.totalBudget;
    } else return refuse(context, 'budget_ambiguous', action, diagnostics);
    filters.maxPriceExclusive = boundary.choice === 'exclusive';
    sourceSpans.push(budgetCandidate.anchor);
  } else if (budgetAnswer.choice === 'remove') {
    filters.maxPrice = null;
    delete filters.maxPriceExclusive;
    delete filters.totalBudget;
  } else if (selectedParty && filters.totalBudget != null) {
    // "Total stays the same" is represented by budget keep; a party delta
    // still recomputes the effective per-person ceiling from the actual total.
    filters.maxPrice = filters.totalBudget / selectedParty;
  }

  const dateAnswer = answers.get('date')!;
  const dateCandidate = scalarChoice(dateAnswer, 'date', context);
  if (dateCandidate) {
    const value = dateCandidate.value as { dateFrom: string; dateTo: string };
    filters.dateFrom = value.dateFrom;
    filters.dateTo = value.dateTo;
    sourceSpans.push(dateCandidate.anchor);
  } else if (dateAnswer.choice === 'remove') {
    filters.dateFrom = null;
    filters.dateTo = null;
  }
  const timeAnswer = answers.get('time')!;
  const timeCandidate = scalarChoice(timeAnswer, 'time', context);
  if (timeCandidate) {
    const value = timeCandidate.value as {
      startTimeFrom?: string;
      startTimeTo?: string;
      startTimeFromExclusive?: boolean;
      startTimeToExclusive?: boolean;
    };
    delete filters.startTimeFrom;
    delete filters.startTimeTo;
    delete filters.startTimeFromExclusive;
    delete filters.startTimeToExclusive;
    Object.assign(filters, value);
    sourceSpans.push(timeCandidate.anchor);
  } else if (timeAnswer.choice === 'remove') {
    delete filters.startTimeFrom;
    delete filters.startTimeTo;
    delete filters.startTimeFromExclusive;
    delete filters.startTimeToExclusive;
  }
  const districtCandidate = scalarChoice(districtAnswer, 'district', context);
  if (districtCandidate) {
    filters.district = districtCandidate.value as string;
    sourceSpans.push(districtCandidate.anchor);
  } else if (districtAnswer.choice === 'remove') delete filters.district;

  let included =
    filters.categories ?? (filters.category ? [filters.category] : []);
  let excluded = filters.excludedCategories ?? [];
  const includedNow: Category[] = [];
  for (const [id, answer] of answers) {
    const category = categoryForQuestion(id);
    if (!category) continue;
    if (!reliable(id) || answer.choice === 'unresolved')
      return refuse(context, 'constraint_ambiguous', action, diagnostics);
    if (answer.choice === 'include') includedNow.push(category);
    if (answer.choice === 'exclude') {
      included = included.filter((item) => item !== category);
      excluded = [...new Set([...excluded, category])];
    }
    if (answer.choice === 'remove') {
      included = included.filter((item) => item !== category);
      excluded = excluded.filter((item) => item !== category);
    }
    if (answer.choice === 'optional')
      state.preferences.interests = [
        ...new Set([...state.preferences.interests, category]),
      ];
  }
  if (includedNow.length > 1 && logic.choice !== 'category_or')
    return refuse(context, 'constraint_ambiguous', action, diagnostics);
  if (includedNow.length) {
    included = includedNow;
    excluded = excluded.filter((item) => !includedNow.includes(item));
  }
  filters.category = included.length === 1 ? included[0] : null;
  if (included.length > 1) filters.categories = included;
  else delete filters.categories;
  if (excluded.length) filters.excludedCategories = excluded;
  else delete filters.excludedCategories;

  const quiet = answers.get('quiet')!;
  const mood = answers.get('mood')!;
  const companion = answers.get('companion')!;
  const order = answers.get('order')!;
  for (const id of ['quiet', 'mood', 'companion', 'order']) {
    if (!reliable(id) || answers.get(id)!.choice === 'unresolved')
      return refuse(context, 'constraint_ambiguous', action, diagnostics);
  }
  if (quiet.choice === 'remove') applyRequirement(state, 'quiet', 'remove');
  else if (quiet.choice === 'require' || quiet.choice === 'exclude')
    applyRequirement(state, 'quiet', quiet.choice);
  else if (quiet.choice === 'prefer') {
    applyRequirement(state, 'quiet', 'remove');
    state.preferences.interests = [
      ...new Set([...state.preferences.interests, 'quiet']),
    ];
  }
  if (mood.choice === 'remove') state.preferences.mood = null;
  else if (mood.choice.startsWith('set:'))
    state.preferences.mood = mood.choice.slice(
      4,
    ) as IntentState['preferences']['mood'];
  if (companion.choice === 'remove') state.preferences.companion = null;
  else if (companion.choice.startsWith('set:'))
    state.preferences.companion = companion.choice.slice(
      4,
    ) as IntentState['preferences']['companion'];
  if (order.choice === 'remove') delete state.preferences.order;
  else if (order.choice === 'soonest') state.preferences.order = 'soonest';

  for (const clause of context.clauses) {
    if (coverage[clause.id] !== 'program_preference') continue;
    const program = answers.get(`program_${clause.id}`)!.choice;
    const span = clause.programSpans[Number(program.slice(5))];
    const modality = answers.get(`modality_${clause.id}`)!.choice;
    const polarity = answers.get(`polarity_${clause.id}`)!.choice;
    const capability = answers.get(`capability_${clause.id}`)!.choice;
    if (!span) continue;
    if (polarity === 'remove') {
      const target = exactProgramTarget(span.text);
      if (!target)
        return refuse(context, 'constraint_ambiguous', action, diagnostics);
      if (target.kind === 'topic') {
        state.primaryTopics = (state.primaryTopics ?? []).filter(
          (value) => value !== target.value,
        );
        if (!state.primaryTopics.length) delete state.primaryTopics;
      } else
        state.preferences.interests = state.preferences.interests.filter(
          (value) => value !== target.value,
        );
      continue;
    }
    if (capability !== 'supported') continue;
    if (modality === 'mandatory') {
      const topics = [...new Set([...(state.primaryTopics ?? []), span.text])];
      if (topics.length > 8 || span.text.length > 160)
        return refuse(context, 'constraint_ambiguous', action, diagnostics);
      state.primaryTopics = topics;
    } else if (modality === 'optional') {
      const interests = [
        ...new Set([...state.preferences.interests, span.text]),
      ];
      if (interests.length > 12 || span.text.length > 160)
        return refuse(context, 'constraint_ambiguous', action, diagnostics);
      state.preferences.interests = interests;
    }
  }
  state.filters = filters;
  try {
    state = validateIntentState(state);
  } catch {
    return refuse(context, 'constraint_ambiguous', action, diagnostics);
  }
  return {
    state,
    issue: null,
    query: intentQuery(state),
    action,
    origin: 'jev',
    unresolvedRequest: null,
    diagnostics,
  };
}
