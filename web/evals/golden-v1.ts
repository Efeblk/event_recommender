import { createHash } from 'node:crypto';
import { evaluatePlan, validateSearchPlan } from '../lib/plan-evidence.ts';
import { validatePlanState } from '../lib/plan-state.ts';
import {
  emptyFilters,
  type EventRecord,
  type SearchResult,
} from '../lib/types.ts';
import { isEligible, normalize } from '../lib/search.ts';
import type { Condition, Plan } from '../parser/contract.ts';

export interface GoldenCase {
  id: string;
  language: 'tr' | 'en';
  message: string;
  reviewSummary: string;
  expected: Plan;
  relevanceNotes?: string;
}
export interface GoldenFixture {
  schemaVersion: 1;
  referenceTime: string;
  timezone: 'Europe/Istanbul';
  review: {
    status: 'pending' | 'approved';
    reviewer: string | null;
    reviewedAt: string | null;
  };
  catalog: {
    githubRunId: string;
    artifactId: string;
    artifactName: string;
    artifactPath: string;
    sha256: string;
    bytes: number;
    sourceRecords: number;
    defaultPath: string;
    runUrl: string;
    collectionFinishedAt: string;
    artifactExpiresAt: string;
    privateArchive: string;
  };
  cases: GoldenCase[];
}
export const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

export function validateGoldenFixture(value: unknown): GoldenFixture {
  const fixture = value as GoldenFixture;
  if (
    fixture?.schemaVersion !== 1 ||
    fixture.timezone !== 'Europe/Istanbul' ||
    !Number.isFinite(Date.parse(fixture.referenceTime)) ||
    !Array.isArray(fixture.cases) ||
    fixture.cases.length !== 40 ||
    !/^[a-f0-9]{64}$/.test(fixture.catalog?.sha256 ?? '') ||
    !Number.isSafeInteger(fixture.catalog.bytes) ||
    fixture.catalog.bytes < 1 ||
    !Number.isSafeInteger(fixture.catalog.sourceRecords) ||
    fixture.catalog.sourceRecords < 1
  )
    throw new Error('Invalid golden fixture.');
  if (!['pending', 'approved'].includes(fixture.review?.status))
    throw new Error('Invalid fixture review.');
  if (
    fixture.review.status === 'approved' &&
    (!fixture.review.reviewer?.trim() ||
      !Number.isFinite(Date.parse(fixture.review.reviewedAt ?? '')))
  )
    throw new Error('Missing user review evidence.');
  const ids = new Map<string, GoldenCase>();
  for (const item of fixture.cases) {
    if (
      !/^(tr|en)\d{2}$/.test(item.id) ||
      ids.has(item.id) ||
      !['tr', 'en'].includes(item.language) ||
      !item.id.startsWith(item.language) ||
      !item.message?.trim() ||
      item.message.length > 1200 ||
      !item.reviewSummary?.trim()
    )
      throw new Error('Invalid golden request.');
    if ('previousCaseId' in item)
      throw new Error('Golden requests must be independent.');
    validatePlanState({
      version: 2,
      revision: 0,
      plan: item.expected,
      requests: [],
    });
    validateSearchPlan(item.expected);
    ids.set(item.id, item);
  }
  if (
    fixture.cases.filter((c) => c.language === 'tr').length !== 25 ||
    fixture.cases.filter((c) => c.language === 'en').length !== 15
  )
    throw new Error(
      'Golden set requires 25 Turkish and 15 English requests.',
    );
  return fixture;
}

/** IDs, conjunction order and equivalent ticket ceilings do not change meaning. */
export function canonicalCondition(condition: Condition): string {
  if (condition.type === 'atom') {
    // Positive companion atoms describe attendees and never filter an event.
    if (condition.atom.kind === 'companion') return 'all()';
    // Production evidence compares both per-person and per-ticket ceilings
    // against one listed ticket price. Group totals remain distinct.
    const atom =
      condition.atom.kind === 'budget' && condition.atom.basis === 'per_person'
        ? { ...condition.atom, basis: 'per_ticket' }
        : condition.atom;
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(atom).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
  }
  if (condition.type === 'not') {
    if (condition.child.type === 'not')
      return canonicalCondition(condition.child.child);
    if (condition.child.type === 'all' || condition.child.type === 'any')
      return canonicalCondition({
        type: condition.child.type === 'all' ? 'any' : 'all',
        children: condition.child.children.map((child) => ({
          type: 'not',
          child,
        })),
      });
    return `not(${canonicalCondition(condition.child)})`;
  }
  const operands = (child: Condition): Condition[] => {
    if (child.type === condition.type) return child.children.flatMap(operands);
    if (child.type === 'not') {
      if (child.child.type === 'not') return operands(child.child.child);
      const opposite = condition.type === 'all' ? 'any' : 'all';
      if (child.child.type === opposite)
        return child.child.children.flatMap((item) =>
          operands({ type: 'not', child: item }),
        );
    }
    return [child];
  };
  const children = condition.children.flatMap(operands);
  const values = [...new Set(children.map(canonicalCondition))]
    .filter((value) => condition.type !== 'all' || value !== 'all()')
    .sort();
  return values.length === 1
    ? values[0]
    : `${condition.type}(${values.join(',')})`;
}

export function expectedMatches(
  catalog: EventRecord[],
  item: GoldenCase,
  now: Date,
): EventRecord[] {
  return catalog.filter(
    (event) =>
      isEligible(event, emptyFilters, now) &&
      evaluatePlan(event, item.expected, now).status === 'supported',
  );
}

/** Conservative duplicate candidates; the label review also checks semantic identity. */
export function duplicatePairs(events: EventRecord[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < events.length; i++)
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i],
        b = events[j];
      const aIds = new Set([
        a.id,
        ...(a.mergedIds ?? []),
        ...(a.offers ?? []).map((o) => o.id),
      ]);
      const overlap = [
        b.id,
        ...(b.mergedIds ?? []),
        ...(b.offers ?? []).map((o) => o.id),
      ].some((id) => aIds.has(id));
      const sameSession =
        a.startsAt === b.startsAt &&
        normalize(a.venue) === normalize(b.venue) &&
        (normalize(a.title) === normalize(b.title) ||
          (!!a.canonicalShowKey && a.canonicalShowKey === b.canonicalShowKey));
      if (overlap || sameSession) pairs.push([a.id, b.id]);
    }
  return pairs;
}

export function auditGoldenResult(
  item: GoldenCase,
  result: SearchResult,
  catalog: EventRecord[],
  now: Date,
) {
  const cards = result.recommendations.slice(0, 10).map((r) => r.event);
  const hardViolations = cards.flatMap((event) => {
    const check = evaluatePlan(event, item.expected, now);
    return check.status === 'supported'
      ? []
      : [{ recordId: event.id, ...check }];
  });
  const sourceById = new Map(catalog.map((event) => [event.id, event]));
  const ungrounded = cards
    .filter(
      (event) =>
        JSON.stringify(event) !== JSON.stringify(sourceById.get(event.id)),
    )
    .map((event) => event.id);
  const matches = expectedMatches(catalog, item, now);
  return {
    parserHardMatches: result.planState
      ? canonicalCondition(result.planState.plan.hard) ===
        canonicalCondition(item.expected.hard)
      : false,
    hardViolations,
    ungrounded,
    duplicatePairs: duplicatePairs(cards),
    expectedHardMatchIds: matches.map((event) => event.id),
    // A nonzero count requires review of program/mood evidence in the full set.
    emptyAudit:
      result.status === 'empty'
        ? {
            hardMatchCount: matches.length,
            relevanceReviewRequired: matches.length > 0,
          }
        : null,
  };
}

export interface GoldenRow {
  caseId: string;
  elapsedMs: number;
  cacheHits: number;
  paidCalls: number;
  errors: string[];
  result: SearchResult | null;
  top10: {
    rank: number;
    recordId: string;
    sourceRecordIds: string[];
    event: EventRecord;
  }[];
  audit: ReturnType<typeof auditGoldenResult> | null;
}
export interface GoldenLabels {
  schemaVersion: 1;
  catalogSha256: string;
  fixtureSha256: string | null;
  runSha256: string | null;
  resultSha256: string | null;
  userReview: {
    status: string;
    reviewedCaseIds: string[];
    reviewer: string | null;
    reviewedAt: string | null;
  };
  cases: {
    caseId: string;
    status: string;
    cards: {
      recordId: string;
      label: 'relevant' | 'partly_relevant' | 'not_relevant';
      notes: string;
    }[];
    emptyReview: {
      verdict: 'no_matching_event' | 'missed_matching_event';
      reviewer: string;
      notes: string;
      evidenceRecordIds: string[];
    } | null;
    notes: string | null;
    duplicateReview?: {
      verdict: 'distinct' | 'duplicates';
      reviewer: string;
      notes: string;
    };
  }[];
}

/** Pending labels never become zero-score labels or a passing quality claim. */
export function resultDigest(rows: GoldenRow[]): string {
  return sha256(
    JSON.stringify(
      rows.map((row) => ({
        caseId: row.caseId,
        result: row.result,
        top10: row.top10,
        audit: row.audit,
      })),
    ),
  );
}

export function qualitySummary(
  rows: GoldenRow[],
  labels: GoldenLabels,
  provenance: {
    fixtureSha256: string;
    catalogSha256: string;
    resultSha256: string;
  },
) {
  const ids = rows.map((r) => r.caseId);
  if (
    new Set(ids).size !== ids.length ||
    new Set(labels.cases.map((c) => c.caseId)).size !== labels.cases.length
  )
    throw new Error('Duplicate result or label case.');
  const bound =
    labels.fixtureSha256 === provenance.fixtureSha256 &&
    labels.catalogSha256 === provenance.catalogSha256 &&
    labels.resultSha256 === provenance.resultSha256;
  const byId = new Map(labels.cases.map((c) => [c.caseId, c]));
  const allowed = new Set(['relevant', 'partly_relevant', 'not_relevant']);
  const complete = rows.filter((row) => {
    const entry = byId.get(row.caseId);
    return (
      bound &&
      !!entry &&
      entry.status === 'labelled' &&
      !row.errors.length &&
      !!row.result &&
      ['results', 'empty'].includes(row.result.status) &&
      entry.cards.length === row.top10.length &&
      entry.cards.every(
        (c, i) =>
          c.recordId === row.top10[i].recordId &&
          allowed.has(c.label) &&
          typeof c.notes === 'string',
      ) &&
      (row.result.status !== 'empty' ||
        (!!entry.emptyReview?.reviewer.trim() &&
          !!entry.emptyReview.notes.trim()))
    );
  });
  const relevantTop3 = complete.filter((row) =>
    byId
      .get(row.caseId)!
      .cards.slice(0, 3)
      .some((c) => c.label === 'relevant'),
  ).length;
  const reviewed = [...new Set(labels.userReview.reviewedCaseIds)].filter(
    (id) => complete.some((r) => r.caseId === id),
  );
  const userReviewComplete =
    labels.userReview.status === 'reviewed' &&
    !!labels.userReview.reviewer?.trim() &&
    Number.isFinite(Date.parse(labels.userReview.reviewedAt ?? '')) &&
    reviewed.length >= 10;
  const allLabelled =
    rows.length === 40 && complete.length === 40 && labels.cases.length === 40;
  const hardViolations = rows.reduce(
    (n, r) => n + (r.audit?.hardViolations.length ?? 0),
    0,
  );
  const duplicates = rows.reduce(
    (n, r) => n + (r.audit?.duplicatePairs.length ?? 0),
    0,
  );
  const ungrounded = rows.reduce(
    (n, r) => n + (r.audit?.ungrounded.length ?? 0),
    0,
  );
  const emptyReviewsPass =
    allLabelled &&
    rows
      .filter((r) => r.result?.status === 'empty')
      .every((r) => {
        const review = byId.get(r.caseId)!.emptyReview!;
        return (
          review.verdict === 'no_matching_event' &&
          (r.audit!.expectedHardMatchIds.length === 0 ||
            r.audit!.expectedHardMatchIds.every((id) =>
              review.evidenceRecordIds.includes(id),
            ))
        );
      });
  const distinctReviewsPass =
    allLabelled &&
    rows.every((r) => {
      const review = byId.get(r.caseId)!.duplicateReview;
      return (
        r.top10.length < 2 ||
        (review?.verdict === 'distinct' &&
          !!review.reviewer.trim() &&
          !!review.notes.trim())
      );
    });
  return {
    provenanceMatches: bound,
    labelledRequests: complete.length,
    userReviewedRequests: reviewed.length,
    hardViolations,
    duplicateCandidates: duplicates,
    ungroundedCards: ungrounded,
    parserHardMismatches: rows
      .filter((r) => !r.audit?.parserHardMatches)
      .map((r) => r.caseId),
    relevantTop3Requests: relevantTop3,
    relevantTop3Fraction: allLabelled ? relevantTop3 / 40 : null,
    everyEmptyReviewed: emptyReviewsPass,
    everyListReviewedForDuplicates: distinctReviewsPass,
    frozenQualityPassed:
      allLabelled &&
      userReviewComplete &&
      hardViolations === 0 &&
      duplicates === 0 &&
      ungrounded === 0 &&
      rows.every((r) => r.audit?.parserHardMatches) &&
      relevantTop3 >= 34 &&
      emptyReviewsPass &&
      distinctReviewsPass,
    stagingLatencyPassed: null,
    phaseComplete: false,
  };
}
