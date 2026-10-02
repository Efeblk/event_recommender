/* eslint-disable typescript/no-explicit-any, typescript/no-floating-promises */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { runBenchmark, scoreRun, validateDataset } from '../scripts/benchmark-response-quality.mjs';
import { normalizeCapture } from '../scripts/normalize-quality-capture.mjs';

const fixture = JSON.parse(await readFile(resolve('fixtures/response-quality-benchmark-v1.json'), 'utf8'));
const baseline = JSON.parse(await readFile(resolve('fixtures/response-quality-baseline-v1.json'), 'utf8'));
const mutate = (fn: (copy: any) => void) => { const copy = structuredClone(baseline); fn(copy); return scoreRun(fixture, copy); };
const turn = (run: any, caseId: string, turnId = 't1') => run.cases.find((item: any) => item.id === caseId).turns.find((item: any) => item.id === turnId);
const codes = (result: any) => new Set(result.failures.map((failure: any) => failure.code));

test('frozen pass control exercises every case and passes', () => {
  validateDataset(fixture);
  const result = scoreRun(fixture, baseline);
  assert.equal(result.pass, true, JSON.stringify(result.failures));
  assert.equal(result.cases.length, 16);
  assert.equal(result.usage.observations, 18);
  assert.equal('inputTokens' in result.usage, false, 'unreported token usage is not invented');
});

test('detects an omitted hard quiet requirement in an intermediate typed state', () => {
  const result = mutate((run) => { turn(run, 'dev_quiet_required').state.required = []; });
  assert.equal(result.pass, false);
  assert.ok(codes(result).has('exact_mismatch'));
});

test('detects a card with positive evidence for an excluded topic', () => {
  const result = mutate((run) => {
    turn(run, 'dev_quiet_required').cards = [{ recordId: 'concert-501', familyId: 'pop-2000', sourceReferences: ['src-concert'] }];
  });
  assert.ok(codes(result).has('positive_excluded_topic'));
});

test('detects a dropped OR arm rather than accepting substring-like partial state', () => {
  const result = mutate((run) => { turn(run, 'holdout_or_preserved').state.filters.categoryAny = ['Tiyatro']; });
  assert.ok(codes(result).has('exact_mismatch'));
});

test('detects false clarification on a complete request', () => {
  const result = mutate((run) => { turn(run, 'holdout_no_false_clarify').state.action = 'clarify'; });
  assert.ok(codes(result).has('false_clarification'));
});

test('detects semantic duplicates even when both cards have valid source proof', () => {
  const result = mutate((run) => {
    turn(run, 'holdout_duplicate_family').cards.push({ recordId: 'photo-102', familyId: 'photo-workshop', sourceReferences: ['src-photo-2'] });
  });
  assert.ok(codes(result).has('semantic_duplicate'));
});

test('separately detects missing fixed record recall and missing source references', () => {
  const missing = mutate((run) => { turn(run, 'dev_botany_proven').cards = []; });
  assert.ok(codes(missing).has('missing_recall_record'));
  assert.ok(codes(missing).has('missing_recall_family'));
  const source = mutate((run) => { turn(run, 'dev_botany_proven').cards[0].sourceReferences = []; });
  assert.ok(codes(source).has('missing_source_reference'));
  assert.ok(codes(source).has('missing_required_evidence'));
});

test('atomic clarification rejects cards, retrieval and committed-state mutation', () => {
  const result = mutate((run) => {
    const actual = turn(run, 'holdout_atomic_clarify');
    actual.cards = [{ recordId: 'theatre-301', familyId: 'moon-play', sourceReferences: ['src-theatre'] }];
    actual.usage.retrievalCalls = 1;
    actual.atomicStateUnchanged = false;
  });
  const observed = codes(result);
  assert.ok(observed.has('atomic_refusal_cards'));
  assert.ok(observed.has('atomic_refusal_retrieval'));
  assert.ok(observed.has('atomic_refusal_mutated_state'));
});

test('human-review-needed disposition never becomes an automatic pass', () => {
  const copy = structuredClone(baseline);
  const expected = fixture.cases.find((item: any) => item.id === 'dev_photo_tr').turns[0];
  expected.recall.allowHumanReview = true;
  turn(copy, 'dev_photo_tr').disposition = 'human_review_needed';
  assert.ok(codes(scoreRun(fixture, copy)).has('human_review_needed'));
  delete expected.recall.allowHumanReview;
});

test('card failures do not lower the typed interpretation metric', () => {
  const result = mutate((run) => { turn(run, 'dev_botany_proven').cards[0].sourceReferences = []; });
  assert.equal(result.quality.interpretation.passedTurns, result.quality.interpretation.totalTurns);
  assert.ok((result.quality.cardValidityPrecision.rate ?? 1) < 1);
});

test('an absent case has zero direct recall and explicit missing recall failures', () => {
  const result = mutate((run) => { run.cases = run.cases.filter((item: any) => item.id !== 'dev_botany_proven'); });
  assert.ok(codes(result).has('missing_case'));
  assert.ok(codes(result).has('missing_recall_record'));
  assert.equal(result.quality.fixedRecordRecall.found, result.quality.fixedRecordRecall.expected - 1);
});

test('manual and unknown dispositions fail without an oracle opt-in', () => {
  const manual = mutate((run) => { turn(run, 'dev_photo_tr').disposition = 'human_review_needed'; });
  assert.ok(codes(manual).has('human_review_needed'));
  const unknown = mutate((run) => { turn(run, 'dev_photo_tr').disposition = 'unknown'; });
  assert.ok(codes(unknown).has('unknown_disposition'));
});

test('duplicate case and turn identities fail instead of being overwritten', () => {
  const duplicateCase = mutate((run) => { run.cases.push(structuredClone(run.cases[0])); });
  assert.ok(codes(duplicateCase).has('duplicate_case'));
  const duplicateTurn = mutate((run) => { const item = run.cases.find((entry: any) => entry.id === 'dev_group_budget'); item.turns.push(structuredClone(item.turns[0])); });
  assert.ok(codes(duplicateTurn).has('duplicate_turn'));
});

test('card fact checks catch displayed price and group total violations without negative precision', () => {
  const price = mutate((run) => { turn(run, 'dev_botany_proven').cards[0].price = 250; });
  assert.ok(codes(price).has('price_fact_mismatch'));
  const budget = mutate((run) => {
    turn(run, 'dev_group_budget').cards = [{ recordId: 'theatre-301', familyId: 'moon-play', sourceReferences: ['src-theatre'] }];
  });
  assert.ok(codes(budget).has('hard_filter_failure'));
  assert.equal(budget.quality.cardValidityPrecision.validCards >= 0, true);
  assert.equal((budget.quality.cardValidityPrecision.rate ?? -1) >= 0, true);
});

test('live interpretation subset scores exactly eight turns without card or recall gates', async () => {
  const report = await runBenchmark({ fixture: resolve('fixtures/response-quality-benchmark-v1.json'), mode: 'offline', subset: 'live-interpretation', stage: 'interpretation' });
  assert.equal(report.result.quality.interpretation.totalTurns, 8);
  assert.equal(report.result.quality.fixedRecordRecall.expected, 0);
  assert.equal(report.result.pass, true, JSON.stringify(report.result.failures));
});

test('capture normalizer projects observed fields only and flags unknown semantic phrases', () => {
  const normalized = normalizeCapture({ records: [{ id: 'sample', turns: [{
    id: 't1', message: 'observed', previous: { date: '2026-10-03' }, unresolvedRequest: null, elapsedMs: 12,
    result: { action: 'search', state: { filters: { date: '2026-10-03', categories: ['Atölye'] }, typedRequirements: [{ policy: 'require_support', value: 'fotoğraf' }], primaryTopics: ['unreviewed phrase'] } },
  }] }] });
  const actual = normalized.cases[0].turns[0];
  assert.deepEqual(actual.priorState, { committed: { action: 'search', filters: { date: '2026-10-03' }, required: [], excluded: [], optional: [], logic: 'AND' } });
  assert.deepEqual(actual.state.required, ['topic:photography']);
  assert.equal(actual.disposition, 'human_review_needed');
  assert.equal(JSON.stringify(normalized).includes('expected'), false);
  assert.equal(actual.usage.latencyMs, 12);
});

test('capture normalizer preserves mandatory topics, typed policies, bounds, prior semantics and raw atomic proof', () => {
  const normalized = normalizeCapture({ records: [{ id: 'atomic', turns: [{
    message: 'observed', unresolvedRequest: 'prior input', previous: {
      filters: { maxPrice: 500, maxPriceExclusive: true },
      requirements: [{ kind: 'activity', value: 'quiet', policy: 'require_support' }],
      preferences: { experiences: ['learning'] },
    }, result: { action: 'search', issue: 'unsupported_constraint', state: {
      filters: { maxPrice: 500, maxPriceExclusive: false }, primaryTopics: ['photography'],
      requirements: [{ kind: 'audience', value: 'children', policy: 'exclude_positive_evidence' }],
      preferences: { experiences: ['learning'] },
    } },
  }] }] });
  const actual = normalized.cases[0].turns[0];
  assert.deepEqual(actual.state.required, ['topic:photography']);
  assert.deepEqual(actual.state.excluded, ['audience:children']);
  assert.equal(actual.state.filters.maxPriceExclusive, false);
  assert.deepEqual(actual.priorState.committed.required, ['environment:quiet']);
  assert.deepEqual(actual.priorState.committed.optional, ['experience:learning']);
  assert.deepEqual(actual.pendingState, { unresolvedRequest: 'prior input' });
  assert.equal(actual.atomicStateUnchanged, false);
});

test('atomic proof detects changes outside the finite semantic alias map', () => {
  const normalized = normalizeCapture({ records: [{ id: 'unknown', turns: [{
    message: 'observed', previous: { filters: {}, primaryTopics: ['unmapped prior topic'] },
    result: { issue: 'unsupported_constraint', state: { filters: {}, primaryTopics: ['different unmapped topic'] } },
  }] }] });
  const actual = normalized.cases[0].turns[0];
  assert.equal(actual.disposition, 'human_review_needed');
  assert.equal(actual.atomicStateUnchanged, false);
  assert.equal(actual.atomicProof, 'complete-raw-state-comparison');
});

test('normalization retains companion and order wishes and flags unknown policies', () => {
  const normalized = normalizeCapture({ records: [{ id: 'unknown-policy', turns: [{
    message: 'observed', previous: {}, result: { state: {
      filters: { startTimeFromExclusive: true },
      requirements: [{ kind: 'audience', value: 'children', policy: 'unrecognized' }],
      preferences: { companion: 'partner', order: 'soonest' },
    } },
  }] }] });
  const actual = normalized.cases[0].turns[0];
  assert.equal(actual.disposition, 'human_review_needed');
  assert.deepEqual(actual.state.optional, ['companion:partner', 'order:soonest']);
  assert.equal(actual.state.filters.startTimeFromExclusive, true);
});
