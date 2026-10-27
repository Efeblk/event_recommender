import type { Atom, Condition, Plan } from '../parser/contract.ts';
import { DISTRICTS, TOPIC_TERMS } from '../parser/lexicon.ts';
import {
  checkPredicateEvidence,
  type RequirementKind,
  type RequirementStatus,
} from './requirements.ts';
import { emptyFilters, type Category, type EventRecord } from './types.ts';
import { isEligible, normalize } from './search.ts';
import { eventLocation, sideNamed } from './istanbul-location.ts';
import { checkAgeEvidence } from './age-evidence.ts';
import { sourceTimeIsDoorsOnly } from '../../contracts/timing.ts';

const istanbulDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
});
const istanbulClock = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export type PlanEvidenceStatus = RequirementStatus;
export type PlanEvidence =
  | {
      type: 'atom';
      atom: Atom;
      status: PlanEvidenceStatus;
      evidence: string[];
      id?: string;
    }
  | {
      type: 'all' | 'any';
      status: PlanEvidenceStatus;
      children: PlanEvidence[];
      id?: string;
    }
  | {
      type: 'not';
      status: PlanEvidenceStatus;
      child: PlanEvidence;
      id?: string;
    };
export interface PlanEvaluation {
  status: PlanEvidenceStatus;
  evidence: PlanEvidence;
}

/** Catalog labels that satisfy a requested event type. Everyday words are
 * broader than provider labels: a "gösteri" can be a stand-up or dance show,
 * and a course or workshop is sold under either label. */
const categoryMap: Record<string, Category[]> = {
  concert: ['Konser'],
  theatre: ['Tiyatro'],
  standup: ['Stand-up'],
  workshop: ['Workshop', 'Eğitim'],
  // Immersive and museum-hosted exhibitions are sold as "Müze".
  exhibition: ['Sergi', 'Müze'],
  festival: ['Festival'],
  sport: ['Spor'],
  cinema: ['Sinema'],
  talk: ['Söyleşi'],
  dance: ['Dans'],
  show: ['Gösteri', 'Tiyatro', 'Stand-up', 'Dans'],
  course: ['Eğitim', 'Workshop'],
  tour: ['Gezi'],
  museum: ['Müze'],
};
const canonicalCategories = new Set(Object.values(categoryMap).flat());
const genreTopics = new Set([
  'jazz',
  'blues',
  'rock',
  'electronic',
  'rap',
  'classical',
  'comedy',
  'drama',
]);
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const topicPatterns = new Map<string, RegExp>();
const specialTopicTerms: Record<string, string[]> = {
  dancing: ['dans gecesi', 'dans partisi', 'dance night', 'dance party'],
};
/** Source text naming the topic; absence is unknown, never a contradiction. */
function topicPattern(value: string): RegExp {
  let pattern = topicPatterns.get(value);
  if (!pattern) {
    const surfaces = [...(TOPIC_TERMS[value] ?? []), ...(specialTopicTerms[value] ?? []), value]
      .map((term) => normalize(term).trim())
      .filter(Boolean);
    pattern = new RegExp(
      // Whole words only: "pop" must not match "popüler". The lexicon lists
      // the inflected forms it supports ("tarih", "tarihi").
      `(?<![\\p{L}\\p{N}])(?:${surfaces.map(escape).join('|')})(?![\\p{L}\\p{N}])`,
      'u',
    );
    topicPatterns.set(value, pattern);
  }
  return pattern;
}
const canonicalDistricts = new Map(
  DISTRICTS.map((district) => [normalize(district), district]),
);
const experiencePredicates: Record<
  string,
  { kind: RequirementKind; value: string }
> = {
  quiet: { kind: 'activity', value: 'quiet' },
  seated: { kind: 'activity', value: 'seated' },
  romantic: { kind: 'activity', value: 'romantic' },
  uncrowded: { kind: 'activity', value: 'uncrowded' },
  family_friendly: { kind: 'audience', value: 'family_friendly' },
  wheelchair_accessible: { kind: 'accessibility', value: 'step_free' },
};
const OPEN_AIR = /\b(?:acik ?hava(?:da)?|open[- ]air|amfi ?tiyatro|amfi|amphitheat(?:re|er))\b/u;
const result = (status: PlanEvidenceStatus, evidence: string[] = []) => ({
  status,
  evidence,
});
/** Collection-time labels (R4) need this probability to support a format. */
const LABEL_SUPPORT = 0.7;
const CHILD_SUITABLE = 0.65;
const CHILD_UNSUITABLE = 0.25;
const labelEvidence = (...texts: Array<string | undefined>) =>
  texts.filter((text): text is string => Boolean(text));

/** A child attends: children, family and child-age requests (R4 labels). */
function childAudience(event: EventRecord) {
  const labels = event.labels;
  if (!labels) {
    const check = checkPredicateEvidence(event, 'audience', 'family_friendly');
    return result(check.status === 'supported' ? 'supported' : 'unknown', check.evidence);
  }
  const evidence = labelEvidence(labels.evidence.audience, labels.evidence.age);
  if (labels.audience === 'adult_only' || (labels.minAge !== null && labels.minAge >= 13))
    return result('contradicted', evidence);
  if (labels.audience === 'children' || labels.audience === 'family')
    return result('supported', evidence);
  // A general event that states a child age rule ("6 yaş ve üzeri") admits children.
  if ((labels.minAge !== null && labels.minAge <= 10) || labels.childSuitable >= CHILD_SUITABLE)
    return result('supported', evidence.length ? evidence : [`child-suitable ${labels.childSuitable.toFixed(2)}`]);
  if (labels.childSuitable <= CHILD_UNSUITABLE)
    return result('contradicted', [`child-suitable ${labels.childSuitable.toFixed(2)}`]);
  return result('unknown', evidence);
}

function ageResult(event: EventRecord, years: number) {
  const labels = event.labels;
  if (labels && (labels.minAge !== null || labels.maxAge !== null))
    return result(
      (labels.minAge ?? 0) <= years && years <= (labels.maxAge ?? 120) ? 'supported' : 'contradicted',
      labelEvidence(labels.evidence.age),
    );
  if (labels?.audience === 'adult_only' && years < 18)
    return result('contradicted', labelEvidence(labels.evidence.audience));
  const stated = checkAgeEvidence(event, years);
  if (stated.status !== 'unknown' || stated.evidence.length || !labels) return stated;
  // No stated age rule: a child needs a child-suitable event; an adult needs
  // an event that is not made for children.
  if (years < 13) return childAudience(event);
  return labels.audience === 'general' || labels.audience === 'family' || labels.audience === 'adult_only'
    ? result('supported', labelEvidence(labels.evidence.audience))
    : result('unknown');
}

function atomResult(
  event: EventRecord,
  atom: Atom,
  now: Date,
  partyCount: number | null,
) {
  switch (atom.kind) {
    case 'category': {
      // The provider label and the collection-time label are both evidence.
      const labels = [event.category, event.labels?.category]
        .filter((label): label is Category => canonicalCategories.has(label as Category));
      return result(
        !labels.length
          ? 'unknown'
          : labels.some((label) => categoryMap[atom.value].includes(label))
            ? 'supported'
            : 'contradicted',
        [...new Set(labels.length ? labels : [event.category])],
      );
    }
    case 'date': {
      if (event.attendanceTiming?.kind === 'admission_window') {
        const from = istanbulDay.format(new Date(event.attendanceTiming.validFrom));
        const to = istanbulDay.format(new Date(event.attendanceTiming.validThrough));
        return result(
          to >= atom.from && from <= atom.to ? 'supported' : 'contradicted',
          [`${from}–${to}`],
        );
      }
      const day = istanbulDay.format(new Date(event.startsAt));
      return result(
        day >= atom.from && day <= atom.to ? 'supported' : 'contradicted',
        [day],
      );
    }
    case 'time': {
      if (
        sourceTimeIsDoorsOnly(event.description) ||
        (event.attendanceTiming && event.attendanceTiming.kind !== 'timed_session')
      )
        return result('unknown');
      const time = istanbulClock.format(new Date(event.startsAt));
      const ok =
        (!atom.from ||
          (atom.fromExclusive ? time > atom.from : time >= atom.from)) &&
        (!atom.to || (atom.toExclusive ? time < atom.to : time <= atom.to));
      return result(ok ? 'supported' : 'contradicted', [time]);
    }
    case 'budget': {
      if (
        atom.comparison === 'approx' ||
        event.price === null ||
        event.currency !== 'TRY' ||
        !Number.isFinite(event.price)
      )
        return result('unknown');
      if (atom.basis === 'group_total' && partyCount === null)
        return result('unknown');
      const price =
        atom.basis === 'group_total' ? event.price * partyCount! : event.price;
      const ok =
        atom.comparison === 'lt'
          ? price < atom.amount
          : atom.comparison === 'lte'
            ? price <= atom.amount
            : atom.comparison === 'gt'
              ? price > atom.amount
              : price >= atom.amount;
      return result(ok ? 'supported' : 'contradicted', [`${price} TRY`]);
    }
    case 'location': {
      const place = event.labels?.place;
      if (place === 'other_city' || place === 'online')
        return result('contradicted', labelEvidence(place, event.labels?.evidence.place));
      if (atom.precision === 'neighborhood') return result('unknown');
      if (atom.precision === 'side') {
        const wanted = sideNamed(normalize(atom.name));
        let actual = eventLocation(event);
        if (!actual.side && event.labels?.district)
          actual = eventLocation({ ...event, district: event.labels.district });
        if (!wanted || !actual.side) return result('unknown');
        return result(actual.side === wanted ? 'supported' : 'contradicted', [
          event.district || event.address || event.venue,
        ]);
      }
      if (isEligible(event, { ...emptyFilters, district: atom.name }, now))
        return result('supported', [
          event.district || event.address || event.venue,
        ]);
      const eventDistrict = canonicalDistricts.get(normalize(event.district));
      if (
        eventDistrict &&
        isEligible(event, { ...emptyFilters, district: eventDistrict }, now)
      )
        return result('contradicted', [eventDistrict]);
      // The provider gave no district: use the labeled district of the activity.
      const labeled = event.labels?.district;
      if (labeled)
        return result(
          normalize(labeled) === normalize(atom.name) ? 'supported' : 'contradicted',
          labelEvidence(labeled, event.labels?.evidence.place),
        );
      return result('unknown', event.district ? [event.district] : []);
    }
    case 'topic': {
      if (!genreTopics.has(atom.value)) {
        // "müzikal" is also an ordinary adjective in descriptions ("müzikal bir
        // yolculuk"); a musical names itself in its title or category.
        const text = normalize(
          [event.title, atom.value === 'musical' ? '' : event.description, event.sourceCategory]
            .filter(Boolean)
            .join('. '),
        );
        const pattern = topicPattern(atom.value);
        const dancingCue = atom.value !== 'dancing'
          || /(?<![\p{L}\p{N}])(?:dj|eglence|parti|party)(?![\p{L}\p{N}])/u.test(text);
        const evidence = (dancingCue ? text
          .split(/(?<=[.!?])\s+/u)
          .filter((part) => pattern.test(part))
          .slice(0, 3)
          .map((part) => part.slice(0, 240)) : []);
        return result(evidence.length ? 'supported' : 'unknown', evidence);
      }
      const check = checkPredicateEvidence(event, 'genre', atom.value);
      return result(check.status, check.evidence);
    }
    case 'experience': {
      if (atom.value === 'outdoors') {
        // Open-air venues name themselves ("… Açıkhava Tiyatrosu", "Amfi").
        const evidence = [event.venue, event.title, event.description]
          .filter(Boolean)
          .flatMap((text) => String(text).split(/(?<=[.!?])\s+/u))
          .filter((part) => OPEN_AIR.test(normalize(part)))
          .slice(0, 3)
          .map((part) => part.slice(0, 240));
        if (!evidence.length && (event.labels?.formats.outdoor ?? 0) >= LABEL_SUPPORT)
          return result('supported', labelEvidence(event.labels!.evidence.format, 'labeled outdoor'));
        return result(evidence.length ? 'supported' : 'unknown', evidence);
      }
      const predicate = experiencePredicates[atom.value];
      if (!predicate) return result('unknown');
      const check = checkPredicateEvidence(
        event,
        predicate.kind,
        predicate.value,
      );
      if (atom.value === 'seated' && check.status === 'unknown' && (event.labels?.formats.seated ?? 0) >= LABEL_SUPPORT)
        return result('supported', labelEvidence(event.labels!.evidence.format, 'labeled seated'));
      return result(check.status, check.evidence);
    }
    case 'content': {
      const check = checkPredicateEvidence(
        event,
        'content',
        atom.value === 'profanity' ? 'swearing' : 'sexual_content',
      );
      return result(check.status, check.evidence);
    }
    case 'party':
      return result('supported');
    case 'companion':
      // "With children" needs a child-suitable event; partner and friends are context.
      return atom.value === 'children' || atom.value === 'family'
        ? childAudience(event)
        : result('supported');
    case 'age':
      return ageResult(event, atom.years);
    case 'mood':
      return result('unknown');
  }
}

function evaluate(
  event: EventRecord,
  condition: Condition,
  now: Date,
  partyCount: number | null,
  negated = false,
): PlanEvidence {
  if (condition.type === 'atom') {
    const atom = atomResult(event, condition.atom, now, partyCount);
    const status = negated && condition.atom.kind === 'topic' && atom.status === 'unknown' && atom.evidence.length === 0
      ? 'contradicted'
      : atom.status;
    return {
      type: 'atom',
      atom: condition.atom,
      id: condition.id,
      ...atom,
      status,
    };
  }
  if (condition.type === 'not') {
    // Topic absence is meaningful anywhere under negative polarity. Each NOT
    // toggles that polarity, so double negation keeps positive-topic semantics.
    const child = evaluate(event, condition.child, now, partyCount, !negated);
    const status = child.status === 'unknown'
        ? 'unknown'
        : child.status === 'supported'
          ? 'contradicted'
          : 'supported';
    return { type: 'not', child, id: condition.id, status };
  }
  const children = condition.children.map((child) =>
    evaluate(event, child, now, partyCount, negated),
  );
  const status =
    condition.type === 'all'
      ? children.some((x) => x.status === 'contradicted')
        ? 'contradicted'
        : children.every((x) => x.status === 'supported')
          ? 'supported'
          : 'unknown'
      : children.some((x) => x.status === 'supported')
        ? 'supported'
        : children.every((x) => x.status === 'contradicted')
          ? 'contradicted'
          : 'unknown';
  return { type: condition.type, children, id: condition.id, status };
}

/** The single unconditional party count in the hard plan, or null. */
export function planPartyCount(plan: Plan): number | null {
  const partyCounts: number[] = [];
  const gatherParties = (condition: Condition, conjunctive: boolean) => {
    if (condition.type === 'atom') {
      if (conjunctive && condition.atom.kind === 'party')
        partyCounts.push(condition.atom.count);
      return;
    }
    if (condition.type === 'all')
      condition.children.forEach((child) => gatherParties(child, conjunctive));
  };
  gatherParties(plan.hard, true);
  return partyCounts.length === 1 ? partyCounts[0] : null;
}

export function evaluatePlan(
  event: EventRecord,
  plan: Plan,
  now = new Date(),
): PlanEvaluation {
  const evidence = evaluate(event, plan.hard, now, planPartyCount(plan));
  // v1 returns Istanbul events: a labeled activity elsewhere never matches.
  const place = event.labels?.place;
  if (place === 'other_city' || place === 'online')
    return { status: 'contradicted', evidence };
  return { status: evidence.status, evidence };
}

export function validateSearchPlan(plan: Plan): void {
  if (plan.order === 'nearest')
    throw new Error('nearest order requires user geolocation');
  let parties = 0;
  let groupBudgets = 0;
  const partyCounts = new Set<number>();
  const visit = (
    condition: Condition,
    hard: boolean,
    unconditional: boolean,
  ) => {
    if (condition.type === 'atom') {
      const atom = condition.atom;
      if (hard && atom.kind === 'mood')
        throw new Error('moods are ranking preferences, not verified venue properties');
      if (
        hard &&
        (atom.kind === 'party' || atom.kind === 'companion') &&
        !unconditional
      )
        throw new Error(`${atom.kind} cannot be conditional`);
      if (hard && atom.kind === 'party') {
        parties++;
        partyCounts.add(atom.count);
      }
      if (hard && atom.kind === 'budget' && atom.basis === 'group_total')
        groupBudgets++;
      if (hard && atom.kind === 'budget' && atom.comparison === 'approx')
        throw new Error('approximate hard budgets are unsupported');
      if (hard && atom.kind === 'location' && atom.precision === 'neighborhood')
        throw new Error('neighborhood evidence is unsupported');
      if (
        hard &&
        atom.kind === 'location' &&
        (atom.precision === 'side'
          ? !sideNamed(normalize(atom.name))
          : !canonicalDistricts.has(normalize(atom.name)))
      )
        throw new Error('noncanonical district is unsupported');
      if (
        hard &&
        atom.kind === 'experience' &&
        atom.value === 'beginner_friendly'
      )
        throw new Error('experience evidence is unsupported');
      return;
    }
    if (condition.type === 'not') return visit(condition.child, hard, false);
    condition.children.forEach((child) =>
      visit(child, hard, unconditional && condition.type === 'all'),
    );
  };
  visit(plan.hard, true, true);
  plan.preferences.forEach((preference) => visit(preference, false, true));
  if (partyCounts.size > 1)
    throw new Error('conflicting unconditional party counts');
  if (groupBudgets && parties !== 1)
    throw new Error(
      'group total requires exactly one unconditional party count',
    );
}
