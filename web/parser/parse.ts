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
import { ask, type ChoiceAnswer, type JevResponse, type NoulAnswer, type Question } from './jev.ts';

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
  }
}

const SUPPORTED = 'The search can check only: Istanbul districts and neighbourhoods; calendar dates (today or later); start-time bounds; ticket price limits in Turkish lira (per person, per ticket, or group total); number of attendees; companions (partner, friends, family, children); event types (concert, theatre, stand-up, workshop, exhibition, festival, sport, cinema, talk, dance, show, course, tour, museum); topics or genres; quiet, seated, outdoors, wheelchair access, family-friendly, uncrowded, romantic, beginner-friendly; absence of profanity or sexual content; and sorting by soonest, cheapest or nearest.';

const choice = (instructions: unknown, criteria: Record<string, string>): Question => ({ type: 'choice', instructions, criteria });

export function buildRequest(input: ParserInput) {
  const { mentions } = extract(input.utterance, input.referenceDate);
  const segs = segments(input.utterance);
  const prev = input.previousState?.plan ?? null;
  const existing = prev ? [...prev.hard.children.map((c) => ({ c, strength: 'required' })), ...prev.preferences.map((c) => ({ c, strength: 'preferred' }))] : [];
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
    questions[`strength_${m.id}`] = choice(
      { question: `Is the user's condition about \`${path}.text\` mandatory or only an optional wish? Judge the hedging that applies to this phrase itself.` },
      {
        mandatory: 'Mandatory (the default): stated plainly, as what to find, as must/required/"şart"/"olsun", or as the acceptable options ("X or Y is fine", "olabilir", "uygun").',
        optional: 'Explicitly hedged as only a wish for this phrase: preferably, ideally, if possible, would be nice, as a preference, "tercih", "tercihen", "mümkünse", "olsa güzel olur", "şart değil".',
      },
    );
    if (m.kind === 'amount') {
      questions[`cmp_${m.id}`] = choice(
        { question: `Which price comparison does the user apply to the amount \`${path}.text\`?` },
        {
          lte: 'At most / maximum / up to / does not exceed / budget is X / can spend X / "en fazla", "en çok", "maksimum", "-e kadar", "geçmesin", "üstüne çıkma", "harcayabiliriz".',
          lt: 'Strictly under / below / less than / cheaper than: "altında", "-den az", "-den ucuz", "under".',
          gte: 'At least / minimum / X or more: "en az", "minimum", "ve üzeri".',
          gt: 'Strictly more than / over / above: "-den fazla", "üstünde", "over".',
          approx: 'Approximately / around / about: "yaklaşık", "civarı", "gibi", "around".',
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
  // Coordination between neighbouring same-kind mentions.
  for (let i = 0; i + 1 < mentions.length; i++) {
    const a = mentions[i];
    const j = mentions.findIndex((m, k) => k > i && m.kind === a.kind);
    if (j < 0 || !['category', 'location', 'topic', 'companion', 'date', 'experience'].includes(a.kind)) continue;
    questions[`link_${a.id}_${mentions[j].id}`] = choice(
      { question: `If the user wants both \`mentions[${i}].text\` and \`mentions[${j}].text\`, are they alternatives or separate conditions?` },
      {
        or: 'Either one is enough: listed options ("veya", "ya da", "or", "either"), including types or places joined by "and"/"ve" when one event could not be both at once.',
        and: 'Both must hold for the same event at the same time (for example a topic and a theme together), or one of them is not actually wanted.',
      },
    );
  }
  // Scope of a modifier next to a coordinated pair ("quiet concerts and theatre", "theatre or a workshop in Taksim").
  for (let i = 0; i + 1 < mentions.length; i++) {
    const a = mentions[i], b = mentions[i + 1];
    if (a.kind !== b.kind || !['category', 'topic'].includes(a.kind)) continue;
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
        },
      );
    });
    questions.vague = {
      type: 'noul',
      instructions: 'Does the message point to an existing condition only through a vague reference (that, it, the other one, they, "o", "şu", "diğer", "onlar", "bahsettiğim") without a value that identifies which one?',
    };
    questions.vague_target = choice(
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
      instructions: { supportedConditions: SUPPORTED, question: `Does \`segments[${i}]\` make the search depend on something outside \`supportedConditions\` (for example a guarantee, ratings, awards, travel time, weather, admission rules, seat availability, final fees, subjective quality, or a place relative to a landmark)? Ordinary supported conditions, politeness and commands are not.` },
    };
  });
  return { state, questions, mentions, segments: segs, existing, scopes };
}

type Built = ReturnType<typeof buildRequest>;

export async function parse(input: ParserInput, options: { offline?: boolean } = {}): Promise<ParseResult> {
  const built = buildRequest(input);
  const response = await ask(built.state, built.questions, options);
  return compose(input, built, response);
}

export function compose(input: ParserInput, built: Built, response: JevResponse): ParseResult {
  const { mentions, segments: segs, existing, scopes } = built;
  const a = response.answers;
  const pick = (id: string) => (a[id] as ChoiceAnswer | undefined)?.choice;
  const dist = (id: string) => (a[id] as ChoiceAnswer | undefined)?.probabilities ?? {};
  const noul = (id: string) => (a[id] as NoulAnswer | undefined)?.noul ?? 0;
  const debug: Debug = { mentions, answers: Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.type === 'choice' ? Object.entries(v.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 2).filter(([, p], i) => i === 0 || p >= 0.1).map(([o, p]) => `${o}:${p.toFixed(2)}`).join('/') : (v as NoulAnswer).noul.toFixed(2)])), usage: response.usage };
  const role = (m: Mention) => {
    const polarity = pick(`polarity_${m.id}`) ?? 'not_condition';
    const optional = pick(`strength_${m.id}`) === 'optional';
    if (polarity === 'wanted') return optional ? 'prefer' : 'require';
    if (polarity === 'unwanted') return optional ? 'avoid' : 'exclude';
    return polarity === 'old_value' ? 'existing' : 'other';
  };
  const wanted = (m: Mention) => ['require', 'prefer', 'exclude', 'avoid'].includes(role(m));

  // --- Unsupported: deterministic checks first, then Jev's segment judgments.
  const unsupported = mentions.filter((m) => (m.kind === 'amount' && m.currency === 'OTHER' && wanted(m))
    || (m.kind === 'outside_location' && ['require', 'prefer'].includes(role(m)))
    || (m.kind === 'date' && m.past && ['require', 'prefer'].includes(role(m))));
  const unsupportedSegments = segs.filter((_, i) => noul(`unsupported_s${i}`) > 0.55);
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
  const reset = pick('action') === 'reset';
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
    if (same) consumed.add(m.id);
  }
  // A vague reference ("that day", "they") branches over the conditions it could mean.
  let vagueTargets: typeof edits = [];
  if (noul('vague') > 0.5) {
    vagueTargets = edits.filter((e) => noul(`could_refer_${e.id}`) > 0.5);
    if (!vagueTargets.length) vagueTargets = edits.filter((e) => e.id === pick('vague_target'));
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
      return [{ id: e.id, decision }];
    });
    if (options.length) vagueSlot = slots.push({ options }) - 1;
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
  const amountAtom = (m: Extract<Mention, { kind: 'amount' }>, basis: string, inheritFrom?: Atom): Atom => ({
    kind: 'budget', comparison: (pick(`cmp_${m.id}`) ?? 'lte') as 'lte', amount: m.amount, currency: 'TRY',
    basis: (basis === 'unstated' && inheritFrom?.kind === 'budget' ? inheritFrom.basis : basis) as 'per_person',
  });
  const budgetSlots = new Map<string, number>();
  const dateSlots = new Map<string, number>();
  const atomFor = (m: Mention, pickSlot: (slot: number) => unknown): Atom | null => {
    if (m.kind === 'amount') {
      const basis = pick(`basis_${m.id}`) ?? 'unstated';
      if (basis !== 'unstated') return amountAtom(m, basis);
      if (!budgetSlots.has(m.id)) budgetSlots.set(m.id, slots.push({ options: ['per_person', 'per_ticket', 'group_total'] }) - 1);
      return amountAtom(m, pickSlot(budgetSlots.get(m.id)!) as string);
    }
    if (m.kind === 'date' && m.alternatives) {
      if (!dateSlots.has(m.id)) dateSlots.set(m.id, slots.push({ options: m.alternatives }) - 1);
      const alt = pickSlot(dateSlots.get(m.id)!) as { from: string; to: string };
      return { kind: 'date', from: alt.from, to: alt.to };
    }
    return mentionAtom(m);
  };

  const build = (choose: (slot: number) => unknown): Operation[] => {
    const ops: Operation[] = [];
    const used = new Set(consumed);
    if (reset) ops.push({ op: 'reset' });
    // Edits of existing conditions, in their stored order.
    const vague = vagueSlot !== null ? choose(vagueSlot) as { id: string; decision: string; condition?: Condition } : null;
    for (const e of edits) {
      let decision = e.decision;
      if (vagueSlot !== null) decision = vague!.id === e.id ? vague!.decision : (vagueTargets.some((t) => t.id === e.id) ? 'unchanged' : decision);
      if ((decision === 'make_preferred' || decision === 'make_required') && !pointed(e)) decision = 'unchanged';
      if (decision === 'replace_with') ops.push({ op: 'replace', targetId: e.id, condition: vague!.condition! });
      else if (decision === 'keep') ops.push({ op: 'keep', targetId: e.id });
      else if (decision === 'remove') ops.push({ op: 'remove', targetId: e.id });
      else if (decision === 'make_preferred' || decision === 'make_required') {
        ops.push({ op: 'replace', targetId: e.id, condition: strip(e.condition), strength: decision === 'make_preferred' ? 'preferred' : 'hard' });
      } else if (decision === 'replace') {
        const kind = e.kind === 'budget' ? 'amount' : e.kind;
        const m = mentions.find((x) => x.kind === kind && !used.has(x.id) && ['require', 'prefer', 'existing'].includes(role(x)) && !atoms(e.condition).some((y) => { const z = mentionAtom(x); return z && sameValue(y, z); }));
        if (!m) { ops.push({ op: 'remove', targetId: e.id }); continue; }
        used.add(m.id);
        const old = firstAtom(e.condition);
        let atom: Atom | null;
        if (m.kind === 'amount') {
          const basis = pick(`basis_${m.id}`) ?? 'unstated';
          atom = amountAtom(m, basis, old);
          if (basis === 'unstated' && old.kind !== 'budget') atom = atomFor(m, choose);
          const cmp = dist(`cmp_${m.id}`);
          // A bare replacement amount keeps the old comparison unless the wording sets one.
          if (atom?.kind === 'budget' && old.kind === 'budget' && (cmp.lte ?? 0) < 0.5 && Math.max(...Object.values(cmp)) < 0.5) atom.comparison = old.comparison;
        } else atom = atomFor(m, choose);
        if (!atom) continue;
        const condition: Condition = e.condition.type === 'not' ? { type: 'not', child: { type: 'atom', atom } } : { type: 'atom', atom };
        ops.push({ op: 'replace', targetId: e.id, condition });
      }
    }
    // New conditions.
    const adds: Array<{ kind: string; strength: 'hard' | 'preferred'; condition: Condition; start: number }> = [];
    const fresh = mentions.filter((m) => !used.has(m.id) && wanted(m) && m.kind !== 'outside_location');
    const times = { hard: [] as Mention[], preferred: [] as Mention[] };
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
      if (m.kind === 'time') { times[strength].push(m); i++; continue; }
      const atom = atomFor(m, choose);
      i++;
      if (!atom) continue;
      if (m.kind === 'experience' && INVERSE_EXPERIENCE[m.value]?.test(fold(m.text))) {
        // Excluding crowds/noise/standing asserts the canonical experience.
        if (r === 'exclude' || r === 'avoid') adds.push({ kind: 'experience', strength, condition: { type: 'atom', atom }, start: m.start });
        continue;
      }
      if (r === 'exclude' || r === 'avoid') { adds.push({ kind: atom.kind, strength, condition: { type: 'not', child: { type: 'atom', atom } }, start: m.start }); continue; }
      // Coordinated alternatives of the same kind and role become one ANY node.
      const group: Atom[] = [atom];
      let cursor = m;
      for (;;) {
        const next = fresh.find((x, k) => k >= i && x.kind === cursor.kind);
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
    for (const strength of ['hard', 'preferred'] as const) {
      if (!times[strength].length) continue;
      const atom: Extract<Atom, { kind: 'time' }> = { kind: 'time' };
      for (const m of times[strength]) {
        if (m.kind !== 'time') continue;
        const c = pick(`clock_${m.id}`) ?? 'at';
        if (c === 'after' || c === 'from' || c === 'range_start' || c === 'at') { atom.from = m.clock; if (c === 'after') atom.fromExclusive = true; }
        if (c === 'before' || c === 'until' || c === 'range_end' || c === 'at') { atom.to = m.clock; if (c === 'before') atom.toExclusive = true; }
      }
      if (atom.from && atom.to && atom.from > atom.to) continue;
      adds.push({ kind: 'time', strength, condition: { type: 'atom', atom }, start: times[strength][0].start });
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
      const ops = build((slot) => slots[slot].options[chosen[slot] ?? 0]);
      const key = JSON.stringify(ops);
      if (seen.has(key)) return;
      seen.add(key);
      try { interpretations.push({ operations: ops, resultingPlan: applyOperations(input.previousState, ops) }); } catch { /* invalid branch */ }
      return;
    }
    for (let k = 0; k < slots[index].options.length; k++) combos(index + 1, [...chosen, k]);
  };
  // Slots are registered lazily while building, so first discover them with a dry run.
  build((slot) => slots[slot].options[0]);
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
