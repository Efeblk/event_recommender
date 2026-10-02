import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExperimentRequest,
  compileExperimentResponse,
  EXPERIMENT_MODEL,
  GLINER_PROPOSAL_THRESHOLD,
  pythonCodePointToUtf16,
  type BuildExperimentResult,
  type ExperimentContext,
} from '../experiments/gliner-input/interpreter.ts';
import { emptyIntentState, type IntentState } from '../lib/input-state.ts';

const now = new Date('2026-10-01T09:00:00.000Z');

function answerFor(
  built: BuildExperimentResult,
  overrides: Record<string, string> = {},
  weak: string[] = [],
) {
  const answers = Object.fromEntries(
    Object.entries(built.request.questions).map(([id, question]) => {
      const options = Object.keys(question.criteria);
      let selected = overrides[id];
      if (!selected) {
        if (id === 'action') selected = 'search';
        else if (id === 'logic') selected = 'ordinary_and';
        else if (id === 'budget_basis' || id === 'budget_boundary')
          selected = 'none';
        else if (id.startsWith('coverage_')) selected = 'discourse';
        else if (id.startsWith('program_')) selected = 'none';
        else if (id.startsWith('capability_')) {
          const clauseId = id.slice('capability_'.length);
          selected =
            overrides[`coverage_${clauseId}`] === 'typed_condition'
              ? 'supported'
              : 'none';
        } else if (id.startsWith('modality_') || id.startsWith('polarity_'))
          selected = 'none';
        else selected = 'keep';
      }
      assert.ok(options.includes(selected), `${id} does not offer ${selected}`);
      const probability = weak.includes(id) ? 0.51 : 0.96;
      const rest = (1 - probability) / (options.length - 1);
      return [
        id,
        {
          type: 'choice',
          choice: selected,
          confidence: weak.includes(id) ? 0.01 : 0.9,
          probabilities: Object.fromEntries(
            options.map((option) => [
              option,
              option === selected ? probability : rest,
            ]),
          ),
        },
      ];
    }),
  );
  return {
    model: EXPERIMENT_MODEL,
    answers,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function setOption(context: ExperimentContext, kind: string, value?: unknown) {
  const item = context.candidates.find(
    (candidate) =>
      candidate.kind === kind &&
      (value === undefined || candidate.value === value),
  );
  assert.ok(item, `missing ${kind} candidate ${String(value)}`);
  return `set:${item.id}`;
}

function clauseContaining(context: ExperimentContext, text: string) {
  const clause = context.clauses.find((item) =>
    item.anchor.text.includes(text),
  );
  assert.ok(clause, `missing clause containing ${text}`);
  return clause;
}

function programOption(
  clause: ExperimentContext['clauses'][number],
  ...parts: string[]
) {
  const index = clause.programSpans.findIndex((span) =>
    parts.every((part) => span.text.includes(part)),
  );
  assert.notEqual(
    index,
    -1,
    `missing program span containing ${parts.join(', ')}`,
  );
  return `span:${index}`;
}

void test('builds one bounded Jev request from full current and pending messages without legacy interests', () => {
  const built = buildExperimentRequest({
    message: 'Kişi başı 900 TL; fotoğraf veya seramik olsun.',
    unresolvedRequest: 'Pazar Kadıköy.',
    previous: emptyIntentState(),
    now,
  });
  assert.equal(built.request.model, 'jev-1.13.0');
  const messages = built.request.state.messages as {
    current: string;
    pending: string | null;
  };
  assert.equal(
    messages.current,
    'Kişi başı 900 TL; fotoğraf veya seramik olsun.',
  );
  assert.equal(messages.pending, 'Pazar Kadıköy.');
  assert.equal(Object.keys(built.request.questions).length <= 63, true);
  assert.equal(
    new TextEncoder().encode(JSON.stringify(built.request)).length <= 100_000,
    true,
  );
  assert.equal(
    Object.hasOwn(built.request.state.candidates as object, 'interests'),
    false,
  );
  assert.ok(
    built.context.clauses.every(
      (clause) => built.request.questions[`coverage_${clause.id}`],
    ),
  );
});

void test('converts Python code-point offsets to UTF-16 and validates exact GLiNER anchors', () => {
  const message = '🎭 Caz 🎶 Caz';
  const firstStart = Array.from(message).indexOf('C');
  const secondStart = Array.from(message).lastIndexOf('C');
  const built = buildExperimentRequest({
    message,
    previous: emptyIntentState(),
    now,
    gliner: {
      spans: [
        {
          message: 'current',
          start: firstStart,
          end: firstStart + 3,
          text: 'Caz',
          type: 'semantic_preference',
          score: GLINER_PROPOSAL_THRESHOLD,
        },
        {
          message: 'current',
          start: firstStart,
          end: firstStart + 3,
          text: 'Caz',
          type: 'semantic_preference',
          score: 0.8,
        },
        {
          message: 'current',
          start: secondStart,
          end: secondStart + 3,
          text: 'Caz',
          type: 'semantic_preference',
          score: 0.7,
        },
        {
          message: 'current',
          start: firstStart,
          end: firstStart + 3,
          text: 'bad',
          type: 'semantic_preference',
          score: 0.9,
        },
        {
          message: 'current',
          start: firstStart,
          end: firstStart + 3,
          text: 'Caz',
          type: 'semantic_preference',
          score: 0.29,
        },
      ],
    },
  });
  assert.equal(
    pythonCodePointToUtf16(message, firstStart),
    message.indexOf('Caz'),
  );
  assert.equal(built.context.gliner.spans.length, 2);
  assert.equal(built.context.gliner.spans[0].rawScore, 0.8);
  assert.deepEqual(
    built.context.gliner.spans.map((span) => span.start),
    [3, 10],
  );
  assert.equal(built.context.gliner.rejected, 2);
});

void test('compiles exact total budget and a source-backed OR topic without leaking modifiers', () => {
  const built = buildExperimentRequest({
    message: '4 kişiyiz; toplam 3200 TL en fazla; fotoğraf veya seramik olsun.',
    previous: emptyIntentState(),
    now,
  });
  const topic = clauseContaining(built.context, 'fotoğraf');
  const response = answerFor(
    built,
    {
      party: setOption(built.context, 'party', 4),
      budget: setOption(built.context, 'amount', 3200),
      budget_basis: 'group_total',
      budget_boundary: 'inclusive',
      [`coverage_${clauseContaining(built.context, '4 kişiyiz').id}`]:
        'typed_condition',
      [`coverage_${clauseContaining(built.context, '3200').id}`]:
        'typed_condition',
      [`coverage_${topic.id}`]: 'program_preference',
      [`program_${topic.id}`]: programOption(topic, 'fotoğraf', 'seramik'),
      [`modality_${topic.id}`]: 'mandatory',
      [`polarity_${topic.id}`]: 'include',
      [`capability_${topic.id}`]: 'supported',
    },
    [
      `program_${clauseContaining(built.context, '3200').id}`,
      `modality_${clauseContaining(built.context, '3200').id}`,
    ],
  );
  const result = compileExperimentResponse(response, built.context);
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.partySize, 4);
  assert.equal(result.state.filters.totalBudget, 3200);
  assert.equal(result.state.filters.maxPrice, 800);
  assert.deepEqual(result.state.primaryTopics, ['fotoğraf veya seramik']);
  assert.doesNotMatch(result.state.primaryTopics![0], /toplam|en fazla|3200/u);
});

void test('applies party delta to actual prior state and recomputes a kept total budget', () => {
  const previous = emptyIntentState({
    dateFrom: null,
    dateTo: null,
    maxPrice: 800,
    category: null,
    partySize: 4,
    totalBudget: 3200,
  });
  const built = buildExperimentRequest({
    message: 'bir kişi gelmiyor. Toplam bütçe aynı.',
    previous,
    now,
  });
  const delta = built.context.candidates.find(
    (item) => item.kind === 'party' && item.operation?.delta === -1,
  );
  assert.ok(delta);
  const overrides: Record<string, string> = {
    party: `set:${delta.id}`,
    budget_basis: 'group_total',
  };
  for (const clause of built.context.clauses)
    overrides[`coverage_${clause.id}`] = 'typed_condition';
  const result = compileExperimentResponse(
    answerFor(built, overrides, ['budget_boundary']),
    built.context,
  );
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.partySize, 3);
  assert.equal(result.state.filters.totalBudget, 3200);
  assert.equal(result.state.filters.maxPrice, 3200 / 3);
});

void test('a per-person correction clears an inherited total budget', () => {
  const previous = emptyIntentState({
    dateFrom: null,
    dateTo: null,
    maxPrice: 800,
    category: null,
    partySize: 4,
    totalBudget: 3200,
  });
  const built = buildExperimentRequest({
    message: 'Pardon; kişi başı 1200 TL.',
    previous,
    now,
  });
  const budgetClause = clauseContaining(built.context, '1200');
  const result = compileExperimentResponse(
    answerFor(built, {
      budget: setOption(built.context, 'amount', 1200),
      budget_basis: 'per_person',
      budget_boundary: 'inclusive',
      [`coverage_${budgetClause.id}`]: 'typed_condition',
    }),
    built.context,
  );
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.maxPrice, 1200);
  assert.equal(result.state.filters.totalBudget, undefined);
  assert.equal(result.state.filters.partySize, 4);
});

void test('keeps an optional unsupported side as unapplied preference while applying mandatory Kadıköy', () => {
  const built = buildExperimentRequest({
    message: 'Mümkünse Anadolu yakası; Kadıköy zorunlu.',
    previous: emptyIntentState(),
    now,
  });
  const optional = clauseContaining(built.context, 'Anadolu');
  const district = clauseContaining(built.context, 'Kadıköy');
  const result = compileExperimentResponse(
    answerFor(built, {
      district: setOption(built.context, 'district', 'Kadıköy'),
      [`coverage_${optional.id}`]: 'typed_condition',
      [`modality_${optional.id}`]: 'optional',
      [`polarity_${optional.id}`]: 'include',
      [`capability_${optional.id}`]: 'unsupported_location',
      [`coverage_${district.id}`]: 'typed_condition',
    }),
    built.context,
  );
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.district, 'Kadıköy');
  assert.deepEqual(result.state.preferences.interests, []);
  assert.deepEqual(
    result.diagnostics.unappliedPreferences.map((item) => item.text),
    ['Mümkünse Anadolu yakası'],
  );
});

void test('mandatory Ankara returns the specific reason and preserves actual prior state atomically', () => {
  const previous = emptyIntentState({
    dateFrom: null,
    dateTo: null,
    maxPrice: 900,
    category: 'Konser',
  });
  previous.preferences.interests = ['caz'];
  const message = 'Ankara zorunlu';
  const built = buildExperimentRequest({
    message,
    previous,
    now,
    gliner: {
      spans: [
        {
          message: 'current',
          start: 0,
          end: 6,
          text: 'Ankara',
          type: 'district',
          score: 0.8,
        },
      ],
    },
  });
  const clause = built.context.clauses[0];
  const result = compileExperimentResponse(
    answerFor(built, {
      district: 'unsupported_location',
      [`coverage_${clause.id}`]: 'typed_condition',
      [`modality_${clause.id}`]: 'mandatory',
      [`polarity_${clause.id}`]: 'include',
      [`capability_${clause.id}`]: 'unsupported_location',
    }),
    built.context,
  );
  assert.equal(result.issue, 'unsupported_location');
  assert.strictEqual(result.state, built.context.previous);
  assert.deepEqual(result.state, previous);
  assert.equal(result.unresolvedRequest, message);
});

void test('missing extraction cannot become no-constraint because complete clause coverage is unresolved', () => {
  const built = buildExperimentRequest({
    message: 'Ücreti uygun olsun',
    previous: emptyIntentState(),
    now,
  });
  const clause = built.context.clauses[0];
  const result = compileExperimentResponse(
    answerFor(built, {
      [`coverage_${clause.id}`]: 'unresolved',
    }),
    built.context,
  );
  assert.equal(result.issue, 'constraint_ambiguous');
  assert.deepEqual(result.state, emptyIntentState());
});

void test('negative open program topics and mixed-field OR are refused atomically', () => {
  const previous = emptyIntentState({
    dateFrom: null,
    dateTo: null,
    maxPrice: 500,
    category: null,
  });
  const negative = buildExperimentRequest({
    message: 'Fotoğraf olmasın',
    previous,
    now,
  });
  const clause = negative.context.clauses[0];
  const negativeResult = compileExperimentResponse(
    answerFor(negative, {
      [`coverage_${clause.id}`]: 'program_preference',
      [`program_${clause.id}`]: programOption(clause, 'Fotoğraf'),
      [`modality_${clause.id}`]: 'mandatory',
      [`polarity_${clause.id}`]: 'exclude',
      [`capability_${clause.id}`]: 'supported',
    }),
    negative.context,
  );
  assert.equal(negativeResult.issue, 'unsupported_constraint');
  assert.deepEqual(negativeResult.state, previous);

  const mixed = buildExperimentRequest({
    message: 'Kadıköy veya konser',
    previous,
    now,
  });
  const mixedResult = compileExperimentResponse(
    answerFor(mixed, { logic: 'mixed_field_or' }),
    mixed.context,
  );
  assert.equal(mixedResult.issue, 'constraint_ambiguous');
  assert.deepEqual(mixedResult.state, previous);
});

void test('category OR is representable and pending root clears only after a resolved compile', () => {
  const pending = 'Pazar bir etkinlik';
  const built = buildExperimentRequest({
    message: 'Konser veya tiyatro olsun',
    unresolvedRequest: pending,
    previous: emptyIntentState(),
    now,
  });
  const topicClause = clauseContaining(built.context, 'Konser');
  const resolved = compileExperimentResponse(
    answerFor(built, {
      logic: 'category_or',
      category_concert: 'include',
      category_theatre: 'include',
      [`coverage_${topicClause.id}`]: 'typed_condition',
    }),
    built.context,
  );
  assert.equal(resolved.issue, null);
  assert.deepEqual(resolved.state.filters.categories, ['Konser', 'Tiyatro']);
  assert.equal(resolved.unresolvedRequest, null);

  const refused = compileExperimentResponse(
    answerFor(built, {
      logic: 'category_or',
      category_concert: 'include',
      category_theatre: 'include',
      [`coverage_${topicClause.id}`]: 'unresolved',
    }),
    built.context,
  );
  assert.equal(refused.unresolvedRequest, pending);
  assert.deepEqual(refused.state, built.context.previous);
});

void test('candidate values remain code-authoritative and malformed provider answers are rejected', () => {
  const built = buildExperimentRequest({
    message: 'gelecek cuma 900 TL',
    previous: emptyIntentState(),
    now,
  });
  assert.ok(built.context.candidates.some((item) => item.kind === 'date'));
  assert.ok(
    built.context.candidates.some(
      (item) => item.kind === 'amount' && item.value === 900,
    ),
  );
  const raw = answerFor(built) as {
    answers: Record<
      string,
      { choice: string; probabilities: Record<string, number> }
    >;
  };
  raw.answers.budget.choice = 'set:invented';
  assert.throws(
    () => compileExperimentResponse(raw, built.context),
    /Invalid Choice answer/,
  );
});

void test('typed coverage cannot silently discard a newly extracted scalar', () => {
  const previous = emptyIntentState({
    dateFrom: null,
    dateTo: null,
    maxPrice: 500,
    category: null,
  });
  const built = buildExperimentRequest({
    message: '900 TL olsun',
    previous,
    now,
  });
  const clause = built.context.clauses[0];
  const result = compileExperimentResponse(
    answerFor(built, {
      [`coverage_${clause.id}`]: 'typed_condition',
    }),
    built.context,
  );
  assert.equal(result.issue, 'constraint_ambiguous');
  assert.deepEqual(result.state, previous);
});

void test('one selected budget candidate owns alternate caps while code uses its exact normalized value', () => {
  const built = buildExperimentRequest({
    message: 'Tercihen 2000 TL ama en fazla 2500 TL',
    previous: emptyIntentState(),
    now,
  });
  const clause = built.context.clauses[0];
  const result = compileExperimentResponse(
    answerFor(built, {
      budget: setOption(built.context, 'amount', 2500),
      budget_basis: 'per_person',
      budget_boundary: 'inclusive',
      [`coverage_${clause.id}`]: 'typed_condition',
    }),
    built.context,
  );
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.maxPrice, 2500);
});

void test('supports an optional canonical category and general calm mood without inventing quiet', () => {
  const category = buildExperimentRequest({
    message: 'Sergi olabilir',
    previous: emptyIntentState(),
    now,
  });
  const categoryClause = category.context.clauses[0];
  const categoryResult = compileExperimentResponse(
    answerFor(category, {
      category_sergi: 'optional',
      [`coverage_${categoryClause.id}`]: 'typed_condition',
    }),
    category.context,
  );
  assert.equal(categoryResult.issue, null);
  assert.deepEqual(categoryResult.state.preferences.interests, ['Sergi']);

  const mood = buildExperimentRequest({
    message: 'Sakin bir etkinlik olsun',
    previous: emptyIntentState(),
    now,
  });
  const moodClause = mood.context.clauses[0];
  const moodResult = compileExperimentResponse(
    answerFor(mood, {
      mood: 'set:calm',
      [`coverage_${moodClause.id}`]: 'typed_condition',
    }),
    mood.context,
  );
  assert.equal(moodResult.issue, null);
  assert.equal(moodResult.state.preferences.mood, 'calm');
  assert.deepEqual(moodResult.state.requirements, []);
});

void test('low-confidence speculative branches are ignored when clause coverage does not consume them', () => {
  const built = buildExperimentRequest({
    message: 'Lütfen öner',
    previous: emptyIntentState(),
    now,
  });
  const clause = built.context.clauses[0];
  const result = compileExperimentResponse(
    answerFor(
      built,
      {
        [`coverage_${clause.id}`]: 'discourse',
      },
      [
        `program_${clause.id}`,
        `modality_${clause.id}`,
        `polarity_${clause.id}`,
        `capability_${clause.id}`,
        'budget_basis',
        'budget_boundary',
      ],
    ),
    built.context,
  );
  assert.equal(result.issue, null);
  assert.deepEqual(result.state, emptyIntentState());
});

void test('validates incoming prior state rather than trusting provider-controlled state', () => {
  const previous: IntentState = emptyIntentState({
    dateFrom: null,
    dateTo: null,
    maxPrice: 450,
    category: 'Sergi',
  });
  const built = buildExperimentRequest({
    message: 'Aynı kalsın',
    previous,
    now,
  });
  const response = answerFor(built) as unknown as { state?: unknown };
  response.state = { version: 1, filters: { maxPrice: 1 } };
  const result = compileExperimentResponse(response, built.context);
  assert.equal(result.issue, null);
  assert.deepEqual(result.state, previous);
});
