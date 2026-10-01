/** Isolated semantic-parser contract; no application or provider imports. */
export type BudgetBasis = 'per_person' | 'per_ticket' | 'group_total';
export type Comparison = 'lt' | 'lte' | 'gt' | 'gte' | 'approx';
export type Category = 'concert' | 'theatre' | 'standup' | 'workshop' | 'exhibition'
  | 'festival' | 'sport' | 'cinema' | 'talk' | 'dance' | 'show' | 'course' | 'tour' | 'museum';
export type Order = 'none' | 'soonest' | 'cheapest' | 'nearest';
export type Atom =
  | { kind: 'budget'; comparison: Comparison; amount: number; currency: 'TRY'; basis: BudgetBasis }
  | { kind: 'party'; count: number }
  | { kind: 'companion'; value: 'partner' | 'friends' | 'family' | 'children' }
  | { kind: 'date'; from: string; to: string }
  | { kind: 'time'; from?: string; to?: string; fromExclusive?: boolean; toExclusive?: boolean }
  | { kind: 'location'; name: string; precision: 'district' | 'neighborhood' }
  | { kind: 'category'; value: Category }
  | { kind: 'topic'; value: string }
  | { kind: 'experience'; value: 'quiet' | 'seated' | 'outdoors' | 'wheelchair_accessible'
      | 'family_friendly' | 'uncrowded' | 'romantic' | 'beginner_friendly' }
  | { kind: 'content'; value: 'profanity' | 'sexual_content' };

export type Condition =
  | { type: 'atom'; atom: Atom; id?: string }
  | { type: 'all' | 'any'; children: Condition[]; id?: string }
  | { type: 'not'; child: Condition; id?: string };

export interface Plan {
  hard: Condition;
  preferences: Condition[];
  order: Order;
}
export interface Evidence {
  /** Half-open offsets in the ORIGINAL JavaScript string (UTF-16 code units). */
  start: number;
  end: number;
  text: string;
  role: string;
  nodeId?: string;
}
export interface Ownership extends Evidence {
  kind: 'semantic' | 'structural' | 'discourse';
}
export interface PreviousState {
  revision: number;
  plan: Plan;
  evidence: Evidence[];
}
export interface ParserInput {
  utterance: string;
  language: 'tr' | 'en';
  referenceDate: string;
  timezone: 'Europe/Istanbul';
  previousState: PreviousState | null;
}
export type Operation =
  | { op: 'add'; strength: 'hard' | 'preferred'; condition: Condition }
  | { op: 'replace'; targetId: string; condition: Condition; strength?: 'hard' | 'preferred' }
  | { op: 'remove' | 'keep'; targetId: string }
  | { op: 'reset' }
  | { op: 'order'; value: Order };
export interface Interpretation {
  operations: Operation[];
  resultingPlan: Plan;
}
export interface Diagnostics {
  tokenCount: number;
  chartItems: number;
  materialAlternatives: number;
  elapsedMs: number;
  guard?: 'input_length' | 'token_limit' | 'chart_limit' | 'alternative_limit';
}
export type ParserResult =
  | ({ status: 'accepted' } & Interpretation & {
      evidence: Evidence[]; ownership: Ownership[]; diagnostics: Diagnostics;
    })
  | { status: 'ambiguous'; alternatives: Interpretation[]; reason: string;
      evidence: Evidence[]; ownership: Ownership[]; diagnostics: Diagnostics }
  | { status: 'unsupported'; reason: string; unresolvedSpans: Evidence[];
      evidence: Evidence[]; ownership: Ownership[]; diagnostics: Diagnostics };

export interface BenchmarkCase extends ParserInput {
  id: string;
  family: string;
  slice: 'clear' | 'ambiguous' | 'unsupported';
  /** Seeded states are independent; true chains carry each actual returned plan. */
  chainId?: string;
  turn?: number;
  expected: {
    status: ParserResult['status'];
    interpretation?: Interpretation;
    alternatives?: Interpretation[];
    unresolvedQuotes?: string[];
    notes?: string;
  };
}
export const LIMITS = Object.freeze({ characters: 2048, tokens: 128, chartItems: 4096, alternatives: 8 });
export const emptyPlan = (): Plan => ({ hard: { type: 'all', children: [] }, preferences: [], order: 'none' });
