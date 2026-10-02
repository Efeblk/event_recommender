/**
 * Span-first request parser: code proposes literal mentions and computes values;
 * one Jev request judges what each mention means; code composes plan operations.
 *
 * Only designated judgments can yield ambiguity (budget basis, relative-date
 * scope, vague edit references). Every other judgment takes the argmax, so one
 * uncertain answer never blocks an otherwise clear request.
 */
import type { Atom, Condition, Interpretation, Operation, Order, ParserInput, Plan } from './contract.ts';
import { emptyPlan } from './contract.ts';
import { applyOperations } from './state.ts';
import { extract, segments, type Mention } from './extract.ts';
import { fold } from './lexicon.ts';
export interface Proposal { label: 'topic' | 'condition'; text: string; start: number; end: number; score: number }
export type ChoiceQuestion = { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> };
export type NoulQuestion = { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
export type Question = ChoiceQuestion | NoulQuestion;
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
export type NoulAnswer = { type: 'noul'; noul: number };
export type Answer = ChoiceAnswer | NoulAnswer;
export interface JevResponse { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }

export type ParseResult =
  | ({ status: 'accepted' } & Interpretation & { debug: Debug })
  | { status: 'ambiguous'; alternatives: Interpretation[]; reason: string; debug: Debug }
  | { status: 'unsupported'; reason: string; unresolvedSpans: Array<{ start: number; end: number; text: string }>; debug: Debug };
export interface Debug { mentions: Mention[]; answers: Record<string, string>; usage?: JevResponse['usage'] }

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const KIND_ORDER = ['date', 'time', 'location', 'party', 'companion', 'topic', 'experience', 'content', 'category', 'budget'];

/** Terms that name the opposite of the canonical experience (excluding them asserts the experience). */
const INVERSE_EXPERIENCE: Record<string, RegExp> = {
  uncrowded: /^(?:kalabalik|crowd)/u,
  quiet: /^(?:gurultu(?!suz)|noise|noisy|loud)/u,
  seated: /^(?:ayakta|standing)/u,
};

function describeAtom(atom: Atom): string {
  switch (atom.kind) {
    case 'budget': return `price ${{ lt: 'under', lte: 'at most', gt: 'over', gte: 'at least', approx: 'around' }[atom.comparison]} ${atom.amount} TL ${atom.basis.replace('_', ' ')}`;
    case 'date': return atom.from === atom.to ? `date ${atom.from}` : `dates ${atom.from} to ${atom.to}`;
    case 'time': return `start time${atom.from ? ` ${atom.fromExclusive ? 'after' : 'from'} ${atom.from}` : ''}${atom.to ? ` ${atom.toExclusive ? 'before' : 'until'} ${atom.to}` : ''}`;
    case 'location': return `location ${atom.name}`;
    case 'party': return `${atom.count} people attending`;
    case 'companion': return `attending with ${atom.value}`;
    case 'category': return `event type ${atom.value}`;
    case 'topic': return `topic ${atom.value}`;
    case 'experience': return atom.value.replaceAll('_', ' ');
    case 'content': return `${atom.value.replace('_', ' ')} content`;
  }
}
function describe(condition: Condition): string {
  if (condition.type === 'atom') return describeAtom(condition.atom);
  if (condition.type === 'not') return `NOT ${describe(condition.child)}`;
  return condition.children.map(describe).join(condition.type === 'any' ? ' OR ' : ' AND ');
}
function firstAtom(condition: Condition): Atom {
  return condition.type === 'atom' ? condition.atom : condition.type === 'not' ? firstAtom(condition.child) : firstAtom(condition.children[0]);
}
const topLevel = (plan: Plan): Condition[] => (plan.hard.type === 'all' ? plan.hard.children : []);
const atoms = (c: Condition): Atom[] => c.type === 'atom' ? [c.atom] : c.type === 'not' ? atoms(c.child) : c.children.flatMap(atoms);

function mentionMeaning(m: Mention): string {
  switch (m.kind) {
    case 'amount': return `money amount ${m.amount} ${m.currency === 'TRY' ? 'TL' : '(non-TL currency)'}`;
    case 'date': return m.alternatives ? `date: ${m.alternatives.map((a) => a.from).join(' or ')}` : m.from === m.to ? `date ${m.from} (${WEEKDAY_NAMES[new Date(`${m.from}T12:00:00Z`).getUTCDay()]})` : `dates ${m.from} to ${m.to}`;
    case 'time': return `clock time ${m.clock}`;
    case 'party': return `${m.count} people`;
    case 'companion': return `companion: ${m.value}`;
    case 'location': return `Istanbul ${m.precision} ${m.name}`;
    case 'outside_location': return `place outside Istanbul: ${m.name}`;
    case 'category': return `event type: ${m.value}`;
    case 'topic': return `topic: ${m.value}`;
    case 'experience': {
      const inverse = INVERSE_EXPERIENCE[m.value]?.test(fold(m.text));
      return inverse ? `experience: ${m.value === 'uncrowded' ? 'crowdedness' : m.value === 'quiet' ? 'noise' : 'standing'}` : `experience: ${m.value.replaceAll('_', ' ')}`;
    }
    case 'content': return `content: ${m.value.replace('_', ' ')}`;
    case 'open_condition': return `condition: ${m.value}`;
  }
}

const SUPPORTED = 'The search can check only: Istanbul districts and neighbourhoods; calendar dates (today or later); start-time bounds; ticket price limits in Turkish lira (per person, per ticket, or group total); number of attendees; companions (partner, friends, family, children); event types (concert, theatre, stand-up, workshop, exhibition, festival, sport, cinema, talk, dance, show, course, tour, museum); topics or genres; quiet, seated, outdoors, wheelchair access, family-friendly, uncrowded, romantic, beginner-friendly; absence of profanity or sexual content; and sorting by soonest, cheapest or nearest.';

const choice = (instructions: unknown, criteria: Record<string, string>): Question => ({ type: 'choice', instructions, criteria });

/**
 * Hedge markers make a condition optional. They form a small closed class, so code finds them and
 * Jev only judges which phrases each one covers; without a hedge every condition is mandatory.
 */
const HEDGE = new RegExp([
  "olsa (?:iyi|guzel|harika|super|hos) (?:olur|olurdu)", 'olsa fena olmaz', 'olabilir', 'could be (?:nice|good|an option)', 'olursa (?:iyi|guzel) olur',
  '(?:sart|zorunlu|mecburi) degil', 'tercih(?:en|im|imiz|ederim|ederiz|imdir)?(?! degil)', 'mumkunse', 'imkan varsa', 'ideal(?:i|de|olarak)?',
  'preferabl[ey]', 'preferred', 'ideally', 'if possible', "would be (?:nice|great|good|lovely|a plus)", 'nice to have', 'a plus',
  "i(?:'d| would)? prefer", 'as a preference', 'not (?:required|essential|necessary|a must)', 'optional(?:ly)?',
  "(?:doesn't|does not|don't|do not) (?:have|need) to", 'if you can', 'bonus', 'would love',
].join('|'), 'gu');

export function hedgeMarkers(text: string) {
  return [...fold(text).matchAll(HEDGE)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, text: text.slice(m.index!, m.index! + m[0].length) }));
}

export function buildRequest(input: ParserInput, proposals: Proposal[] = []) {
  const { mentions, invalidSpans } = extract(input.utterance, input.referenceDate, proposals);
  const segs = segments(input.utterance);
  const prev = input.previousState?.plan ?? null;
  const existing = prev ? [...topLevel(prev).map((c) => ({ c, strength: 'required' })), ...prev.preferences.map((c) => ({ c, strength: 'preferred' }))] : [];
  const ref = new Date(`${input.referenceDate}T12:00:00Z`);
  const state = {
    message: input.utterance,
    today: `${input.referenceDate} (${WEEKDAY_NAMES[ref.getUTCDay()]}), Istanbul`,
    ...(prev ? {
      existingConditions: existing.map(({ c, strength }) => ({ ref: c.id, condition: `${strength}: ${describe(c)}` })),
      existingSortOrder: prev.order,
    } : {}),
    mentions: mentions.map((m) => ({ ref: m.id, text: m.text, detectedAs: mentionMeaning(m) })),
    segments: segs.map((s) => s.text),
  };
  const questions: Record<string, Question> = {};
  const scopes: Array<{ x: string; a: string; b: string; near: string }> = [];
  // Each hedge covers one contiguous run of phrases next to it inside its clause; Jev picks which run.
  const hedges = hedgeMarkers(input.utterance).map((h) => {
    const clause = (i: number) => input.utterance.slice(0, i).split(/[;.!?]/u).length;
    const inClause = mentions.filter((m) => clause(m.start) === clause(h.start));
    const before = inClause.filter((m) => m.end <= h.start), after = inClause.filter((m) => m.start >= h.end);
    const runs = [
      ...before.map((_, i) => before.slice(i)).reverse(),
      ...after.map((_, i) => after.slice(0, i + 1)),
    ].map((run) => run.map((m) => m.id));
    return { ...h, runs };
  });
  hedges.forEach((h, k) => {
    if (!h.runs.length) return;
    questions[`hedge_${k}`] = choice(
      { hedge: h.text, question: 'Which phrases does `hedge` make only an optional wish in `message`? A hedge covers just the phrases it is attached to: in "Saturday, jazz would be nice" only jazz; in "Cumartesi caz olsa güzel olur" only caz; in "I prefer a beginner-friendly ceramics course" all three.' },
      Object.fromEntries([
        ...h.runs.map((run, r) => [`run${r}`, `Covers exactly: ${run.map((id) => JSON.stringify(mentions.find((m) => m.id === id)!.text)).join(', ')}`]),
        ['none', 'The hedge is negated ("artık tercih değil, zorunlu") or covers only other words that are not listed here (e.g. "sakin bir ortam olsa güzel olur" covers "sakin bir ortam").'],
      ]),
    );
  });
  mentions.forEach((m, i) => {
    const path = `mentions[${i}]`;
    questions[`polarity_${m.id}`] = choice(
      { question: `\`message\` is a request for events to attend in Istanbul. How does it use the phrase \`${path}.text\` (${path}.detectedAs)? Short or fragmentary requests still state what the user wants.` },
      {
        wanted: 'Describes events the user is asking for or will accept: the date, time, place, price, type, topic, company or experience they want, including acceptable options ("X or Y works", "X olabilir", "X uygun") and a new value replacing an old one.',
        unwanted: 'Rules it out: not, no, without, except, exclude, avoid, "olmasın", "hariç", "dışında", "istemiyorum", "içermeyen", "-siz/-süz", "gelmeyecek".',
        ...(prev ? { old_value: 'Repeats the OLD value of a condition in `existingConditions` only to point at it (to remove, keep or replace it). A new value is not this.' } : {}),
        not_condition: 'Not about the events at all: a verb such as "show me", a word with a different meaning here (e.g. "tarih" meaning a date, "sıra" meaning order), or part of a sorting instruction.',
      },
    );
    if (m.kind === 'open_condition') {
      questions[`supported_${m.id}`] = {
        type: 'noul',
        instructions: { supportedConditions: SUPPORTED, question: `Can the search check \`${path}.text\` using only \`supportedConditions\`? Yes if it is just a price, budget basis, date, time, place, attendee, event type, topic or a listed experience; no for food, parking, seat positions, assistive devices, guarantees or anything else.` },
      };
    }
    if (m.kind === 'amount') {
      questions[`cmp_${m.id}`] = choice(
        { question: `Which price comparison does the user apply to the amount \`${path}.text\`?` },
        {
          lte: 'At most / maximum / up to / does not exceed / budget is X / can spend X / a plain amount (shorthand such as 2.5k is exact) / "en fazla", "en çok", "maksimum", "-e kadar", "geçmesin", "üstüne çıkma", "harcayabiliriz".',
          lt: 'Strictly under / below / less than / cheaper than: "altında", "-den az", "-den ucuz", "under".',
          gte: 'At least / minimum / X or more: "en az", "minimum", "ve üzeri".',
          gt: 'Strictly more than / over / above: "-den fazla", "üstünde", "over".',
          approx: 'Approximately / around / about: "yaklaşık", "civarı", "gibi", "around".',
          ...(prev ? { unchanged: 'A replacement value or budget basis with no new comparison: keep the comparison of the existing budget, e.g. change 500 TL per person to 500 TL total.' } : {}),
          range_low: 'The lower end of a price range: the first amount in "between X and Y", "X ile Y arası", "X-Y TL".',
          range_high: 'The upper end of a price range: the second amount in "between X and Y", "X ile Y arası".',
        },
      );
      questions[`basis_${m.id}`] = choice(
        { question: `What does the amount \`${path}.text\` apply to, according to the wording of \`message\`? Do not guess from the number of attendees.` },
        {
          per_person: 'Each person: "kişi başı", "per person", "each of us", "herkes için".',
          per_ticket: 'Each ticket: "bilet başına", "per ticket", "ticket price", "bilet fiyatı".',
          group_total: 'The whole group in total: "toplam", "total", "grup toplamı", "whole group", "hepimiz için".',
          unstated: 'The message does not say whether it is per person, per ticket, or total (for example a bare budget or "we can spend X").',
        },
      );
    }
    if (m.kind === 'party' && prev && [...topLevel(prev), ...prev.preferences].some((c) => atoms(c).some((x) => x.kind === 'party'))) {
      questions[`delta_${m.id}`] = choice(
        { question: `Is \`${path}.text\` the new total number of attendees, or a change to the existing number?` },
        {
          total: 'The new total number of attendees ("we will be three").',
          fewer: 'That many fewer people will attend ("one person cannot come", "bir kişi gelemiyor").',
          more: 'That many more people will attend ("two more friends are joining", "iki kişi daha").',
        },
      );
    }
    if (m.kind === 'time') {
      questions[`clock_${m.id}`] = choice(
        { question: `How does the user bound event start times with \`${path}.text\`?` },
        {
          after: 'Starting strictly after this time: "after", "-den sonra".',
          from: 'Starting at or after this time: "from", "at the earliest", "itibaren", "en erken".',
          before: 'Starting strictly before this time: "before", "-den önce".',
          until: 'Starting at or before this time: "until", "by", "at the latest", "en geç", "-e kadar".',
          range_start: 'The first end of a "between X and Y" range: "X ile Y arası", "between X and Y", "X-Y".',
          range_end: 'The second end of a "between X and Y" range.',
          at: 'Starting exactly at this time.',
        },
      );
    }
  });
  // Coordinate adjacent alternatives and neighbouring mentions of the same kind.
  for (let i = 0; i + 1 < mentions.length; i++) {
    const a = mentions[i];
    const neighbours = new Set([i + 1, mentions.findIndex((m, k) => k > i && m.kind === a.kind)]);
    for (const j of neighbours) {
      if (j < 0) continue;
      if (!['category', 'location', 'topic', 'companion', 'date', 'experience', 'time'].includes(a.kind) || !['category', 'location', 'topic', 'companion', 'date', 'experience', 'time'].includes(mentions[j].kind)) continue;
      // Different kinds only coordinate across an explicit alternative connector, not adjective attachment.
      const gap = fold(input.utterance.slice(a.end, mentions[j].start));
      if (a.kind !== mentions[j].kind && !/\b(?:or|veya|ya da)\b/u.test(gap)) continue;
      questions[`link_${a.id}_${mentions[j].id}`] = choice(
        { question: `If the user wants both \`mentions[${i}].text\` and \`mentions[${j}].text\`, are they alternatives or separate conditions?` },
        {
          or: 'Either one is enough: listed options ("veya", "ya da", "or", "either"), including types or places joined by "and"/"ve" when one event could not be both at once.',
          and: 'Both must hold for the same event at the same time (for example a topic and a theme together), or one of them is not actually wanted.',
          undecided: 'The user says they cannot decide between the two ("X mi Y mi emin değilim", "not sure whether X or Y", "karar veremedim").',
          ...(a.kind === 'date' ? { range: 'The two dates are the start and end of one period: "from X through Y", "X to Y", "X\'den Y\'ye kadar", "X ile Y arası".' } : {}),
        },
      );
    }
  }
  // Scope of a modifier next to a coordinated pair ("quiet concerts and theatre", "theatre or a workshop in Taksim").
  for (let i = 0; i + 1 < mentions.length; i++) {
    const a = mentions[i], b = mentions[i + 1];
    // Only coordinated event types: "a rock or jazz concert" attaches its head noun to both.
    if (a.kind !== b.kind || a.kind !== 'category') continue;
    const before = mentions[i - 1], after = mentions[i + 2];
    for (const [x, near] of [[before, a], [after, b]] as const) {
      if (!x || x.kind === a.kind || !['experience', 'location', 'time', 'topic', 'category'].includes(x.kind)) continue;
      const gap = x.start < near.start ? input.utterance.slice(x.end, near.start) : input.utterance.slice(near.end, x.start);
      if (gap.trim().split(/\s+/u).filter(Boolean).length > 2) continue;
      const xi = mentions.indexOf(x), ai = i, bi = i + 1;
      scopes.push({ x: x.id, a: a.id, b: b.id, near: near.id });
      questions[`scope_both_${x.id}`] = { type: 'noul', instructions: `Can \`mentions[${xi}].text\` reasonably be read as applying to both \`mentions[${ai}].text\` and \`mentions[${bi}].text\`?` };
      questions[`scope_near_${x.id}`] = { type: 'noul', instructions: `Can \`mentions[${xi}].text\` reasonably be read as applying only to \`mentions[${x === before ? ai : bi}].text\` and not to the other option?` };
    }
  }
  questions.order = choice(
    { question: 'How does the user want results sorted?' },
    {
      unchanged: 'The message does not mention sorting or ranking.',
      soonest: 'Soonest / earliest date first: "en yakın tarih", "en erken", "soonest", "earliest".',
      cheapest: 'Cheapest first: "en ucuz", "ucuzdan", "cheapest".',
      nearest: 'Closest location to the user first: "bana en yakın", "nearest", "closest" (not dates).',
      none: 'Explicitly no particular order: "sıralama fark etmez", "any order", "remove the sorting".',
    },
  );
  if (prev) {
    questions.action = choice(
      { question: 'Does the message discard every existing condition and start over?' },
      {
        continue: 'No: it adds to, keeps, or edits the existing search.',
        reset: 'Yes: forget everything / start over / reset / "hepsini unut", "sıfırla", "baştan başla".',
      },
    );
    existing.forEach(({ c }, i) => {
      questions[`edit_${c.id}`] = choice(
        { question: `What does \`message\` do to \`existingConditions[${i}]\`?` },
        {
          unchanged: 'Not addressed by the message.',
          keep: 'Explicitly kept: "keep", "kalsın", "koru", "aynı kalsın".',
          remove: 'Removed or cancelled without a replacement value.',
          replace: 'Its value is changed to a new value stated in the message (e.g. a new amount, date, place, count, or type of the same kind).',
          make_preferred: 'Kept, but changed from required to only preferred/optional.',
          make_required: 'Kept, but changed from preferred to required/mandatory.',
          ...(c.type === 'any' ? { remove_option: 'One of its alternatives is removed and the others stay ("tiyatro şartını kaldır" when it is "concert or theatre").' } : {}),
        },
      );
    });
    existing.forEach(({ c }) => {
      if (!atoms(c).some((x) => x.kind === 'budget')) return;
      questions[`basis_edit_${c.id}`] = choice(
        { question: `Does the message change the price basis of existing condition ${JSON.stringify(describe(c))}, including when it gives no new amount?` },
        {
          unchanged: 'It does not change the existing budget basis.',
          per_person: 'Change the same budget to a limit for each person.',
          per_ticket: 'Change the same budget to a limit for each ticket.',
          group_total: 'Change the same budget to a total limit for the whole group.',
        },
      );
    });
    questions.vague = {
      type: 'noul',
      instructions: 'Does the message point to an existing condition only through a vague reference (that, it, the other one, they, "o", "şu", "diğer", "onlar", "bahsettiğim") without a value that identifies which one?',
    };
    if (existing.length) questions.vague_target = choice(
      { question: 'If the message refers to an existing condition only vaguely (that one, it, the other, they, "o", "diğer", "onlar"), which entry of `existingConditions` could it mean? When several fit equally, they are equally likely.' },
      Object.fromEntries(existing.map(({ c }, i) => [c.id!, `existingConditions[${i}]`])),
    );
    existing.forEach(({ c }, i) => {
      questions[`could_refer_${c.id}`] = {
        type: 'noul',
        instructions: `Can the referring expression in \`message\` (such as "that day", "they", "the other district", "that preference", "it") denote \`existingConditions[${i}]\`? Judge only whether the kind of thing matches: "that day" can denote any date condition, "they" any people attending, "that preference" any preferred condition. Yes for every matching condition, even if several match.`,
      };
    });
    questions.vague_action = choice(
      { question: 'What does the message do to the condition it refers to vaguely?' },
      {
        remove: 'Removes it or says it no longer applies ("çıkar", "sil", "kaldır", "gelmeyecek", "remove", "delete", "will not come").',
        replace: 'Replaces its value with another one.',
        make_preferred: 'Makes it optional.',
        make_required: 'Makes it mandatory.',
        keep: 'Keeps it.',
      },
    );
  }
  segs.forEach((s, i) => {
    questions[`unsupported_s${i}`] = {
      type: 'noul',
      instructions: { supportedConditions: SUPPORTED, question: `Does \`segments[${i}]\` make the search depend on something outside \`supportedConditions\` (for example a guarantee, ratings, awards, travel time, weather, admission rules, seat availability, final fees, subjective quality, a place relative to a landmark, or filtering on what a venue explicitly says it does NOT offer)? Ordinary supported conditions, sorting instructions (including asking for no particular order), edits to earlier conditions, politeness and commands are not.` },
    };
  });
  return { state, questions, mentions, invalidSpans, segments: segs, existing, scopes, hedges };
}

export type BuiltRequest = ReturnType<typeof buildRequest>;

export function compose(input: ParserInput, built: BuiltRequest, response: JevResponse): ParseResult {
  const { mentions, segments: segs, existing, scopes, hedges } = built;
  const refuse = (reason: string): ParseResult => ({ status: 'unsupported', reason, unresolvedSpans: [{ start: 0, end: input.utterance.length, text: input.utterance }], debug: { mentions, answers: {} } });
  if (built.invalidSpans.length) return { status: 'unsupported', reason: 'invalid calendar date', unresolvedSpans: built.invalidSpans, debug: { mentions, answers: {} } };
  if (!validAnswers(built.questions, response)) return refuse('invalid or incomplete provider judgments');
  const a = response.answers;
  const pick = (id: string) => (a[id] as ChoiceAnswer | undefined)?.choice;
  const dist = (id: string) => (a[id] as ChoiceAnswer | undefined)?.probabilities ?? {};
  const noul = (id: string) => (a[id] as NoulAnswer | undefined)?.noul ?? 0;
  const debug: Debug = { mentions, answers: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.type === 'choice' ? Object.entries(v.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 2).filter(([, p], i) => i === 0 || p >= 0.1).map(([o, p]) => `${o}:${p.toFixed(2)}`).join('/') : (v as NoulAnswer).noul.toFixed(2)])), usage: response.usage };
  const role = (m: Mention) => {
    const polarity = pick(`polarity_${m.id}`) ?? 'not_condition';
    // Only the selected scope can weaken a condition; minority wider scopes do not.
    const optional = hedges.some((h, k) => {
      const option = pick(`hedge_${k}`) ?? 'none';
      return /^run\d+$/u.test(option) && h.runs[Number(option.slice(3))]?.includes(m.id);
    });
    if (polarity === 'wanted') return optional ? 'prefer' : 'require';
    if (polarity === 'unwanted') return optional ? 'avoid' : 'exclude';
    return polarity === 'old_value' ? 'existing' : 'other';
  };
  const wanted = (m: Mention) => ['require', 'prefer', 'exclude', 'avoid'].includes(role(m));

  // --- Unsupported: deterministic checks first, then Jev's segment judgments.
  const unsupported = mentions.filter((m) => (m.kind === 'amount' && m.currency === 'OTHER' && wanted(m))
    || (m.kind === 'outside_location' && ['require', 'prefer'].includes(role(m)))
    || (m.kind === 'date' && m.past && ['require', 'prefer'].includes(role(m)))
    // Open-vocabulary conditions matter only when mandatory and outside the supported vocabulary.
    || (m.kind === 'open_condition' && ['require', 'exclude'].includes(role(m)) && noul(`supported_${m.id}`) < 0.5));
  // No supported condition is expressed as a percentage (occupancy, ratings, discounts).
  const percent = /(?:yuzde\s*\d+|%\s*\d+|\d+\s*%|\d+\s*percent)/u;
  const unsupportedSegments = segs.filter((seg, i) => noul(`unsupported_s${i}`) > 0.55 || percent.test(fold(seg.text)));
  if (unsupported.length || unsupportedSegments.length) {
    return {
      status: 'unsupported',
      reason: unsupported.length ? `unsupported ${unsupported.map((m) => m.kind).join(', ')}` : 'condition outside supported vocabulary',
      unresolvedSpans: [...unsupported.map(({ start, end, text }) => ({ start, end, text })), ...unsupportedSegments],
      debug,
    };
  }

  // --- Slots that may legitimately branch into alternatives.
  type Slot = { options: unknown[] };
  const slots: Slot[] = [];
  const consumed = new Set<string>();
  // Discarding every condition is destructive; require a confident judgment.
  const reset = (dist('action').reset ?? 0) >= 0.8;
  const previous = reset ? null : input.previousState?.plan ?? null;

  // Existing-condition edits.
  type Edit = { id: string; kind: string; condition: Condition; preferred: boolean };
  const edits: Array<Edit & { decision: string }> = [];
  if (previous) for (const { c } of existing) {
    edits.push({ id: c.id!, kind: firstAtom(c).kind, condition: c, preferred: previous.preferences.includes(c), decision: pick(`edit_${c.id}`) ?? 'unchanged' });
  }
  // Mentions that restate an edited existing value are references, not new conditions.
  for (const m of mentions) {
    const atom = mentionAtom(m);
    if (!atom) continue;
    const same = edits.find((e) => e.decision !== 'unchanged' && atoms(e.condition).some((x) => sameValue(x, atom)));
    if (same && (role(m) === 'existing' || ['remove', 'remove_option', 'keep', 'make_preferred', 'make_required'].includes(same.decision))) consumed.add(m.id);
  }
  // A vague reference ("that day", "they") branches over the conditions it could mean.
  let vagueTargets: typeof edits = [];
  if (noul('vague') > 0.5) {
    const target = dist('vague_target');
    // Every referent about as plausible as the most plausible one is an alternative.
    const top = Math.max(...edits.map((e) => noul(`could_refer_${e.id}`)));
    vagueTargets = top >= 0.4 ? edits.filter((e) => noul(`could_refer_${e.id}`) >= Math.max(0.4, top - 0.15))
      : edits.filter((e) => (target[e.id] ?? 0) === Math.max(...Object.values(target)));
    // A vague reference never overrides an explicit keep of the same condition ("diğerleri aynı").
    vagueTargets = vagueTargets.filter((e) => e.decision !== 'keep');
  }
  let vagueSlot: number | null = null;
  if (vagueTargets.length) {
    const decision = pick('vague_action') ?? 'remove';
    const options = vagueTargets.flatMap((e) => {
      // "Replace it with the other one" over an OR group: the other option is one of its members.
      const newValue = mentions.some((m) => m.kind === (e.kind === 'budget' ? 'amount' : e.kind) && role(m) === 'require');
      if (decision === 'replace' && e.condition.type === 'any' && !newValue)
        return e.condition.children.map((child) => ({ id: e.id, decision: 'replace_with', condition: strip(child) }));
      // A replacement needs a value: drop branches that would have nothing to replace with.
      if (decision === 'replace' && !newValue) return [];
      // Strength changes that would not change anything cannot be what was meant.
      if ((decision === 'make_required' && !e.preferred) || (decision === 'make_preferred' && e.preferred)) return [];
      return [{ id: e.id, decision }];
    });
    if (options.length) vagueSlot = slots.push({ options }) - 1;
  }
  // A new value whose kind matches several existing conditions, none clearly targeted, branches over them.
  let replaceSlot: number | null = null;
  if (!vagueTargets.length) {
    const replaceP = (e: Edit) => dist(`edit_${e.id}`).replace ?? 0;
    for (const kind of new Set(edits.map((e) => e.kind))) {
      // Only when the message actually supplies a new value of that kind.
      const newValue = mentions.some((m) => m.kind === (kind === 'budget' ? 'amount' : kind) && role(m) === 'require'
        && !edits.some((e) => atoms(e.condition).some((x) => { const y = mentionAtom(m); return y && sameValue(x, y); })));
      const same = edits.filter((e) => e.kind === kind && replaceP(e) >= 0.2);
      if (!newValue || !same.length || Math.max(...same.map(replaceP)) < 0.4) continue;
      if (same.length === 1) { if (same[0].decision === 'unchanged') same[0].decision = 'replace'; continue; }
      if (Math.max(...same.map(replaceP)) < 0.8) { replaceSlot = slots.push({ options: same.map((e) => e.id) }) - 1; break; }
    }
  }
  // Changing a condition's strength requires the message to point at it.
  const pointed = (e: Edit) => vagueTargets.includes(e as never) || mentions.some((m) => {
    const atom = mentionAtom(m);
    return atom && atoms(e.condition).some((x) => sameValue(x, atom));
  });
  // Scope of a modifier next to a coordinated pair.
  const scopeMode = new Map<string, number | 'both' | 'nearest'>();
  for (const sc of scopes) {
    const both = noul(`scope_both_${sc.x}`) > 0.5, near = noul(`scope_near_${sc.x}`) > 0.5;
    if (both && near) scopeMode.set(sc.x, slots.push({ options: ['both', 'nearest'] }) - 1);
    else scopeMode.set(sc.x, near ? 'nearest' : 'both');
  }

  // New conditions from mentions.
  // Range ends are judged independently; the smaller amount of a range is its lower bound.
  const rangeAmounts = mentions.filter((m): m is Extract<Mention, { kind: 'amount' }> => m.kind === 'amount' && (pick(`cmp_${m.id}`) ?? '').startsWith('range_'));
  const comparisonOf = (m: Extract<Mention, { kind: 'amount' }>) => {
    const c = pick(`cmp_${m.id}`) ?? 'lte';
    if (c === 'unchanged') return 'lte';
    if (!c.startsWith('range_')) return c;
    if (rangeAmounts.length === 2) return m.amount === Math.min(...rangeAmounts.map((x) => x.amount)) ? 'gte' : 'lte';
    return c === 'range_low' ? 'gte' : 'lte';
  };
  const amountAtom = (m: Extract<Mention, { kind: 'amount' }>, basis: string, inheritFrom?: Atom): Atom => ({
    kind: 'budget', comparison: comparisonOf(m) as 'lte', amount: m.amount, currency: 'TRY',
    basis: (basis === 'unstated' && inheritFrom?.kind === 'budget' ? inheritFrom.basis : basis) as 'per_person',
  });
  const budgetSlots = new Map<string, number>();
  const undecidedSlots = new Map<string, number>();
  const dateSlots = new Map<string, number>();
  const atomFor = (m: Mention, pickSlot: (slot: number) => unknown): Atom | null => {
    if (m.kind === 'amount') {
      // Free admission has no per-person/total distinction.
      const basis = m.amount === 0 ? 'per_person' : pick(`basis_${m.id}`) ?? 'unstated';
      if (basis !== 'unstated') return amountAtom(m, basis);
      if (!budgetSlots.has(m.id)) budgetSlots.set(m.id, slots.push({ options: ['per_person', 'per_ticket', 'group_total'] }) - 1);
      return amountAtom(m, pickSlot(budgetSlots.get(m.id)!) as string);
    }
    if (m.kind === 'date' && m.alternatives) {
      if (!dateSlots.has(m.id)) dateSlots.set(m.id, slots.push({ options: m.alternatives }) - 1);
      const alt = pickSlot(dateSlots.get(m.id)!) as { from: string; to: string };
      return { kind: 'date', from: alt.from, to: alt.to };
    }
    if (m.kind === 'time') {
      const c = pick(`clock_${m.id}`)!;
      return { kind: 'time',
        ...(['after', 'from', 'range_start', 'at'].includes(c) ? { from: m.clock, ...(c === 'after' ? { fromExclusive: true } : {}) } : {}),
        ...(['before', 'until', 'range_end', 'at'].includes(c) ? { to: m.clock, ...(c === 'before' ? { toExclusive: true } : {}) } : {}),
      };
    }
    return mentionAtom(m);
  };

  const build = (choose: (slot: number) => unknown): Operation[] => {
    const ops: Operation[] = [];
    const used = new Set(consumed);
    const handled = new Set<string>();
    if (reset) ops.push({ op: 'reset' });
    // Edits of existing conditions, in their stored order.
    const vague = vagueSlot !== null ? choose(vagueSlot) as { id: string; decision: string; condition?: Condition } : null;
    // Relative attendee changes ("one person cannot come") rewrite the existing count.
    for (const m of mentions) {
      const delta = pick(`delta_${m.id}`);
      if (m.kind !== 'party' || !delta || delta === 'total') continue;
      const e = edits.find((x) => atoms(x.condition).some((a) => a.kind === 'party'));
      const old = e && atoms(e.condition).find((a) => a.kind === 'party');
      if (!e || old?.kind !== 'party') continue;
      const count = old.count + (delta === 'more' ? m.count : -m.count);
      used.add(m.id);
      if (count < 1) throw new Error('invalid attendee total');
      ops.push({ op: 'replace', targetId: e.id, condition: replaceAtom(e.condition, old, { kind: 'party', count }) });
      handled.add(e.id);
    }
    for (const e of edits) {
      if (handled.has(e.id)) continue;
      let decision = e.decision;
      if (replaceSlot !== null && (slots[replaceSlot].options as string[]).includes(e.id)) decision = choose(replaceSlot) === e.id ? 'replace' : 'unchanged';
      if (vagueSlot !== null) decision = vague!.id === e.id ? vague!.decision : (vagueTargets.some((t) => t.id === e.id) ? 'unchanged' : decision);
      if ((decision === 'make_preferred' || decision === 'make_required') && !pointed(e)) decision = 'unchanged';
      if (decision === 'replace_with') ops.push({ op: 'replace', targetId: e.id, condition: vague!.condition! });
      else if (decision === 'keep') ops.push({ op: 'keep', targetId: e.id });
      else if (decision === 'remove' || decision === 'remove_option') {
        // Removing one named option of an OR group keeps the remaining options ("Tiyatro şartını kaldır").
        const referred = (c: Condition) => c.type === 'atom' && mentions.some((m) => {
          const a = mentionAtom(m);
          return a && role(m) === 'existing' && sameValue(c.atom, a);
        });
        const removeNamed = (c: Condition): Condition | null => {
          if (referred(c)) return null;
          if (c.type === 'atom') return strip(c);
          if (c.type === 'not') {
            const child = removeNamed(c.child);
            return child ? { type: 'not', child } : null;
          }
          const children = c.children.map(removeNamed).filter((x): x is Condition => x !== null);
          return children.length === 0 ? null : children.length === 1 ? children[0] : { type: c.type, children };
        };
        const named = atoms(e.condition).some((x) => mentions.some((m) => {
          const a = mentionAtom(m); return role(m) === 'existing' && a && sameValue(x, a);
        }));
        const rest = named && e.condition.type !== 'atom' ? removeNamed(e.condition) : null;
        if (rest) ops.push({ op: 'replace', targetId: e.id, condition: rest });
        else ops.push({ op: 'remove', targetId: e.id });
      }
      else if (decision === 'make_preferred' || decision === 'make_required') {
        ops.push({ op: 'replace', targetId: e.id, condition: strip(e.condition), strength: decision === 'make_preferred' ? 'preferred' : 'hard' });
      } else if (decision === 'replace') {
        const candidateKinds = new Set<string>(atoms(e.condition).map((x) => x.kind === 'budget' ? 'amount' : x.kind));
        const m = mentions.find((x) => candidateKinds.has(x.kind) && !used.has(x.id) && ['require', 'prefer'].includes(role(x))); 
        // No new value: never drop an existing constraint without evidence.
        if (!m) {
          const basis = pick(`basis_edit_${e.id}`);
          const budgetAtoms = atoms(e.condition).filter((x) => x.kind === 'budget');
          if (basis && basis !== 'unchanged' && budgetAtoms.length === 1) {
            const old = budgetAtoms[0];
            if (old.kind === 'budget') ops.push({ op: 'replace', targetId: e.id, condition: replaceAtom(e.condition, old, { ...old, basis: basis as 'per_person' }) });
          }
          continue;
        }
        used.add(m.id);
        const oldKind = m.kind === 'amount' ? 'budget' : m.kind;
        const matching = atoms(e.condition).filter((x) => x.kind === oldKind);
        const wholeKind = atoms(e.condition).every((x) => x.kind === oldKind);
        if (matching.length !== 1 && !wholeKind) throw new Error('ambiguous compound replacement');
        const old = matching[0];
        let atom: Atom | null;
        if (m.kind === 'amount') {
          const basis = pick(`basis_${m.id}`) ?? 'unstated';
          atom = amountAtom(m, basis, old);
          if (basis === 'unstated' && old.kind !== 'budget') atom = atomFor(m, choose);
          const cmp = dist(`cmp_${m.id}`);
          // A bare replacement amount keeps the old comparison unless the wording sets one.
          if (atom?.kind === 'budget' && old.kind === 'budget' && (pick(`cmp_${m.id}`) === 'unchanged' || ((cmp.lte ?? 0) < 0.5 && Math.max(...Object.values(cmp)) < 0.5))) atom.comparison = old.comparison;
        } else atom = atomFor(m, choose);
        // A bare new clock keeps the bound the old time condition had ("change it to 9 PM").
        if (atom?.kind === 'time' && old.kind === 'time' && m.kind === 'time' && (pick(`clock_${m.id}`) ?? 'at') === 'at') {
          atom = { kind: 'time', ...(old.from ? { from: m.clock, ...(old.fromExclusive ? { fromExclusive: true } : {}) } : {}), ...(old.to && (!old.from || old.from === old.to) ? { to: m.clock, ...(old.toExclusive ? { toExclusive: true } : {}) } : {}) };
        }
        if (!atom) continue;
        const replacement = atom;
        const condition = wholeKind && e.condition.type !== 'not' ? { type: 'atom' as const, atom: replacement } : replaceAtom(e.condition, old, replacement);
        ops.push({ op: 'replace', targetId: e.id, condition });
      }
    }
    // New conditions.
    const adds: Array<{ kind: string; strength: 'hard' | 'preferred'; condition: Condition; start: number }> = [];
    const fresh = mentions.filter((m) => !used.has(m.id) && wanted(m) && m.kind !== 'outside_location');
    const freshIds = new Set(fresh.map((m) => m.id));
    const byId = new Map(mentions.map((m) => [m.id, m]));
    const activeScopes = scopes.filter((sc) => [sc.x, sc.a, sc.b].every((id) => freshIds.has(id))
      && role(byId.get(sc.x)!) === role(byId.get(sc.a)!) && role(byId.get(sc.a)!) === role(byId.get(sc.b)!)
      && ['require', 'prefer'].includes(role(byId.get(sc.a)!)) && pick(`link_${sc.a}_${sc.b}`) === 'or');
    const scopedIds = new Set(activeScopes.map((sc) => sc.x));
    let i = 0;
    while (i < fresh.length) {
      const m = fresh[i];
      const r = role(m);
      const strength = r === 'require' || r === 'exclude' ? 'hard' : 'preferred';
      if (scopedIds.has(m.id)) { i++; continue; }
      const atom = atomFor(m, choose);
      i++;
      if (!atom) continue;
      if (m.kind === 'experience' && INVERSE_EXPERIENCE[m.value]?.test(fold(m.text))) {
        // Excluding crowds/noise/standing asserts the canonical experience.
        adds.push({ kind: 'experience', strength, condition: r === 'exclude' || r === 'avoid' ? { type: 'atom', atom } : { type: 'not', child: { type: 'atom', atom } }, start: m.start });
        continue;
      }
      if (r === 'exclude' || r === 'avoid') {
        // Excluded options of the same kind form one NOT(ANY(...)) ("no concerts or theatre").
        const group: Condition[] = [{ type: 'atom', atom }];
        for (let k = i; k < fresh.length; k++) {
          const x = fresh[k];
          if (x.kind !== m.kind || role(x) !== r || scopedIds.has(x.id)) continue;
          const xAtom = atomFor(x, choose);
          if (xAtom) group.push({ type: 'atom', atom: xAtom });
          fresh.splice(k--, 1);
        }
        const child: Condition = group.length > 1 ? { type: 'any', children: group } : group[0];
        adds.push({ kind: atom.kind, strength, condition: { type: 'not', child }, start: m.start });
        continue;
      }
      // Coordinated alternatives of the same kind and role become one ANY node.
      // Two dates given as the ends of one period become a single range.
      if (atom.kind === 'date') {
        const next = fresh.find((x, k) => k >= i && x.kind === 'date');
        const nextAtom = next && role(next) === r && pick(`link_${m.id}_${next.id}`) === 'range' ? atomFor(next, choose) : null;
        if (nextAtom?.kind === 'date' && nextAtom.to >= atom.from) {
          fresh.splice(fresh.indexOf(next!), 1);
          adds.push({ kind: 'date', strength, condition: { type: 'atom', atom: { kind: 'date', from: atom.from, to: nextAtom.to } }, start: m.start });
          continue;
        }
      }
      // "Kadıköy mü Bakırköy mü emin değilim": an explicit indecision branches over the options.
      const undecided = fresh.find((x, k) => k >= i && x.kind === m.kind && pick(`link_${m.id}_${x.id}`) === 'undecided');
      if (undecided) {
        const otherAtom = atomFor(undecided, choose);
        fresh.splice(fresh.indexOf(undecided), 1);
        if (otherAtom) {
          if (!undecidedSlots.has(m.id)) undecidedSlots.set(m.id, slots.push({ options: [atom, otherAtom] }) - 1);
          const chosen: Condition = { type: 'atom', atom: choose(undecidedSlots.get(m.id)!) as Atom };
          // Indecision about a value that already has a condition replaces that condition.
          const current = edits.find((e) => e.kind === atom.kind && !ops.some((o) => 'targetId' in o && o.targetId === e.id));
          if (current) ops.push({ op: 'replace', targetId: current.id, condition: chosen });
          else adds.push({ kind: atom.kind, strength: 'hard', condition: chosen, start: m.start });
          continue;
        }
      }
      const group: Atom[] = [atom];
      let cursor: Mention = m;
      for (;;) {
        const next = fresh.find((x, k) => k >= i && pick(`link_${cursor.id}_${x.id}`) === 'or');
        if (!next || role(next) !== r || pick(`link_${cursor.id}_${next.id}`) !== 'or') break;
        const nextAtom = atomFor(next, choose);
        if (!nextAtom) break;
        group.push(nextAtom);
        fresh.splice(fresh.indexOf(next), 1);
        cursor = next;
      }
      let condition: Condition = group.length > 1 ? { type: 'any', children: group.map((x) => ({ type: 'atom', atom: x })) } : { type: 'atom', atom };
      const sc = activeScopes.find((x) => x.a === m.id);
      if (sc && condition.type === 'any') {
        const xm = byId.get(sc.x)!, xAtom = atomFor(xm, choose)!;
        const raw = scopeMode.get(sc.x);
        const mode = typeof raw === 'number' ? choose(raw) : raw;
        if (mode === 'nearest') {
          const nearAtom = atomFor(byId.get(sc.near)!, choose)!;
          condition = { type: 'any', children: condition.children.map((child) => child.type === 'atom' && sameValue(child.atom, nearAtom)
            ? { type: 'all', children: [child, { type: 'atom', atom: xAtom }] } : child) };
        } else if (strength === 'preferred') condition = { type: 'all', children: [{ type: 'atom', atom: xAtom }, condition] };
        else adds.push({ kind: xAtom.kind, strength, condition: { type: 'atom', atom: xAtom }, start: xm.start });
      }
      adds.push({ kind: atom.kind, strength, condition, start: m.start });
    }
    // Conjunctive positive clock bounds intersect. OR and excluded clocks stay separate trees.
    for (const strength of ['hard', 'preferred'] as const) {
      const clocks = adds.filter((x) => x.strength === strength && x.condition.type === 'atom' && x.condition.atom.kind === 'time');
      if (clocks.length < 2) continue;
      const merged: Extract<Atom, { kind: 'time' }> = { kind: 'time' };
      for (const x of clocks) {
        if (x.condition.type !== 'atom' || x.condition.atom.kind !== 'time') continue;
        const clock = x.condition.atom;
        if (clock.from && (!merged.from || clock.from >= merged.from)) {
          merged.fromExclusive = clock.from === merged.from ? Boolean(merged.fromExclusive || clock.fromExclusive) : Boolean(clock.fromExclusive);
          merged.from = clock.from;
        }
        if (clock.to && (!merged.to || clock.to <= merged.to)) {
          merged.toExclusive = clock.to === merged.to ? Boolean(merged.toExclusive || clock.toExclusive) : Boolean(clock.toExclusive);
          merged.to = clock.to;
        }
      }
      if (!merged.fromExclusive) delete merged.fromExclusive;
      if (!merged.toExclusive) delete merged.toExclusive;
      for (const x of clocks) adds.splice(adds.indexOf(x), 1);
      adds.push({ kind: 'time', strength, condition: { type: 'atom', atom: merged }, start: clocks[0].start });
    }
    // The same condition stated twice ("tiyatro oyunu") is one condition.
    const seenAdds = new Set<string>();
    for (let k = 0; k < adds.length; k++) {
      const key = `${adds[k].strength}:${JSON.stringify(strip(adds[k].condition))}`;
      if (seenAdds.has(key)) adds.splice(k--, 1); else seenAdds.add(key);
    }
    adds.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || x.start - y.start);
    const addOps: Operation[] = adds.map((x) => ({ op: 'add', strength: x.strength, condition: x.condition }));
    // Sorting.
    const order = pick('order') ?? 'unchanged';
    const current = previous?.order ?? 'none';
    let orderOp: Operation | null = null;
    if (order !== 'unchanged' && (order !== current || reset)) orderOp = { op: 'order', value: order as Order };
    const cue = fold(input.utterance).search(/(?:ucuz|cheap|yakin|near|clos|erken|soon|earli|sira|sort|order)/u);
    const firstAdd = adds.length ? Math.min(...adds.map((x) => x.start)) : Infinity;
    if (orderOp && input.previousState && !reset && cue >= 0 && cue < firstAdd) ops.push(orderOp, ...addOps);
    else ops.push(...addOps, ...(orderOp ? [orderOp] : []));
    return ops;
  };

  const interpretations: Interpretation[] = [];
  const seen = new Set<string>();
  const combos = (index: number, chosen: number[]) => {
    if (interpretations.length >= 8) return;
    if (index === slots.length || slots.length === 0) {
      let ops: Operation[];
      try { ops = build((slot) => slots[slot].options[chosen[slot] ?? 0]); } catch { return; }
      const key = JSON.stringify(ops);
      if (seen.has(key)) return;
      seen.add(key);
      try { interpretations.push({ operations: ops, resultingPlan: applyOperations(input.previousState, ops) }); } catch { /* invalid branch */ }
      return;
    }
    for (let k = 0; k < slots[index].options.length; k++) combos(index + 1, [...chosen, k]);
  };
  // Slots are registered lazily while building, so first discover them with a dry run.
  try { build((slot) => slots[slot].options[0]); } catch { return refuse('ambiguous or invalid correction'); }
  combos(0, []);
  if (!interpretations.length) return { status: 'unsupported', reason: 'no valid interpretation', unresolvedSpans: [{ start: 0, end: input.utterance.length, text: input.utterance }], debug };
  if (interpretations.length === 1) return { status: 'accepted', ...interpretations[0], debug };
  return { status: 'ambiguous', alternatives: interpretations, reason: 'designated ambiguity', debug };
}

function strip(c: Condition): Condition {
  if (c.type === 'atom') return { type: 'atom', atom: c.atom };
  if (c.type === 'not') return { type: 'not', child: strip(c.child) };
  return { type: c.type, children: c.children.map(strip) };
}

function mentionAtom(m: Mention): Atom | null {
  switch (m.kind) {
    case 'amount': return { kind: 'budget', comparison: 'lte', amount: m.amount, currency: 'TRY', basis: 'per_person' };
    case 'date': return { kind: 'date', from: m.from, to: m.to };
    case 'time': return { kind: 'time', from: m.clock };
    case 'party': return { kind: 'party', count: m.count };
    case 'companion': return { kind: 'companion', value: m.value };
    case 'location': return { kind: 'location', name: m.name, precision: m.precision };
    case 'category': return { kind: 'category', value: m.value };
    case 'topic': return { kind: 'topic', value: m.value };
    case 'experience': return { kind: 'experience', value: m.value as 'quiet' };
    case 'content': return { kind: 'content', value: m.value };
    default: return null;
  }
}

function sameValue(x: Atom, y: Atom): boolean {
  if (x.kind !== y.kind) return false;
  switch (x.kind) {
    case 'budget': return x.amount === (y as typeof x).amount;
    case 'date': return x.from === (y as typeof x).from;
    case 'time': return x.from === (y as typeof x).from || x.to === (y as typeof x).from;
    case 'party': return x.count === (y as typeof x).count;
    case 'location': return x.name === (y as typeof x).name;
    default: return (x as { value: string }).value === (y as { value: string }).value;
  }
}

export { emptyPlan, type Plan };

/** Fail closed before consuming partial/malformed judgments as defaults. */
function validAnswers(questions: Record<string, Question>, response: JevResponse): boolean {
  if (!response || !response.answers || typeof response.answers !== 'object') return false;
  const probability = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
  return Object.entries(questions).every(([id, question]) => {
    const answer = response.answers[id];
    if (!answer || answer.type !== question.type) return false;
    if (question.type === 'noul') return answer.type === 'noul' && probability(answer.noul);
    if (answer.type !== 'choice' || !Object.hasOwn(question.criteria, answer.choice) || !probability(answer.confidence)) return false;
    if (!answer.probabilities || typeof answer.probabilities !== 'object') return false;
    const entries = Object.entries(answer.probabilities);
    return entries.length === Object.keys(question.criteria).length && entries.every(([key, p]) => Object.hasOwn(question.criteria, key) && probability(p))
      && probability(answer.probabilities[answer.choice])
      && Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) <= 0.02
      && answer.probabilities[answer.choice] === Math.max(...Object.values(answer.probabilities));
  });
}

function replaceAtom(c: Condition, old: Atom, replacement: Atom): Condition {
  if (c.type === 'atom') return { type: 'atom', atom: c.atom === old ? replacement : c.atom };
  if (c.type === 'not') return { type: 'not', child: replaceAtom(c.child, old, replacement) };
  return { type: c.type, children: c.children.map((child) => replaceAtom(child, old, replacement)) };
}
