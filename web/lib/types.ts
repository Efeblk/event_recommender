import type { IntentState } from './input-state.ts';
import type {
  RequirementKind,
  RequirementPolicy,
} from './requirements.ts';

export type Category = 'Konser' | 'Tiyatro' | 'Stand-up' | 'Workshop' | 'Sergi'
  | 'Festival' | 'Spor' | 'Sinema' | 'Söyleşi' | 'Dans' | 'Gösteri'
  | 'Eğitim' | 'Gezi' | 'Müze' | 'Diğer';
export interface EventOffer {
  id: string;
  sourceSessionIds?: string[];
  source?: EventRecord['source'];
  url: string;
  price: number | null;
  currency: string;
  checkedAt: string;
  category: string;
  venue: string;
  availability: EventRecord['availability'];
}
export interface PreparedSearchV1 {
  version: 1;
  /** Exact Voyage document input produced for this immutable event record. */
  documentText: string;
  /** Lowercase hexadecimal SHA-256 digest of documentText. */
  documentHash: string;
  /** Normalized, stop-word-filtered document tokens used by lexical ranking. */
  lexicalTokens: string[];
}
export type AttendanceTiming =
  | {
      kind: 'timed_session';
      evidence: 'provider_sessions_and_source_text';
    }
  | {
      kind: 'admission_window';
      evidence: 'provider_flexible_window';
      /** Exact provider validity bounds; these are not daily opening hours. */
      validFrom: string;
      validThrough: string;
    }
  | {
      kind: 'unknown';
      evidence: 'insufficient_source_evidence';
    };
export interface EventRecord {
  id: string;
  title: string;
  description: string;
  startsAt: string;
  venue: string;
  city: string;
  district: string;
  address: string;
  price: number | null;
  currency: string;
  url: string;
  imageUrl: string;
  /** Provider-advertised base price, separate from the verified hard-budget total. */
  advertisedPrice?: { amount: number; currency: 'TRY'; kind: 'starting_at' | 'exact'; feesKnown: boolean };
  category: string;
  availability: 'available' | 'sold_out' | 'cancelled' | 'unknown';
  source?: 'biletinial' | 'bubilet' | 'biletix';
  sourceVersion?: string;
  extraction?: string;
  /** Source-backed attendance semantics. Absent on legacy/unclassified records. */
  attendanceTiming?: AttendanceTiming;
  /** The provider's original format label; unknown labels remain searchable. */
  sourceCategory?: string;
  sourceSessionIds?: string[];
  productionKey?: string;
  offers?: EventOffer[];
  mergedIds?: string[];
  canonicalProductionKey?: string;
  canonicalShowKey?: string;
  preparedSearch?: PreparedSearchV1;
  checkedAt: string;
}
export interface Filters {
  dateFrom: string | null;
  dateTo: string | null;
  maxPrice: number | null;
  /** True when the stated ceiling excludes an event priced exactly at maxPrice. */
  maxPriceExclusive?: boolean;
  /** Budget-basis metadata used to recompute a per-person ceiling on follow-up. */
  partySize?: number;
  totalBudget?: number;
  category: Category | null;
  excludedCategories?: Category[];
  /** Exact Istanbul district constraint, compared accent/case-insensitively. */
  district?: string;
  /** Local Europe/Istanbul wall-clock bounds in HH:mm form. */
  startTimeFrom?: string;
  startTimeTo?: string;
  /** Strict bounds for "after" / "before" (as opposed to "from" / "until"). */
  startTimeFromExclusive?: boolean;
  startTimeToExclusive?: boolean;
  /** An inclusive category choice (for example, stand-up OR theatre). */
  categories?: Category[];
}
export interface Message {
  role: 'user' | 'assistant';
  content: string;
}
export interface Recommendation {
  event: EventRecord;
}
/** Unresolved user text is separate from the atomically committed intent. */
export interface PendingInput {
  message: string;
  reason:
    | 'budget_ambiguous'
    | 'date_ambiguous'
    | 'constraint_ambiguous'
    | 'unsupported_location'
    | 'unsupported_constraint'
    | 'interpreter_unavailable';
}
export interface HardRequirementDiagnostics {
  kind: RequirementKind;
  /** Canonical derived value; never contains the user's raw query. */
  value: string;
  policy: RequirementPolicy;
  supported: number;
  unknown: number;
  contradicted: number;
}
export interface SearchDiagnostics {
  /** Canonical sessions returned by storage before recommendation admission checks. */
  catalogRetrieved: number;
  /** Eligible, non-excluded merged sessions evaluated for source evidence. */
  eligibleBeforeSourceEvidence: number;
  hardRequirements: HardRequirementDiagnostics[];
  /** Sessions for which every hard requirement has source support. */
  eligibleAfterSourceEvidence: number;
  /** Eligible merged sessions removed by explicit alternative exclusions. */
  alternativeExclusions: number;
  /** Distinct productions sent to the final ranker or fallback ranking. */
  distinctShortlist: number;
  vectorCoverage: {
    available: number;
    eligible: number;
  };
  /** Null when no Jev support probability was evaluated. */
  returnedAboveSupportThreshold: number | null;
}
export interface SearchResult {
  /** The immutable catalog generation used throughout this request, when supported. */
  publicationId?: string;
  recommendations: Recommendation[];
  filters: Filters;
  mode: 'filters' | 'jev';
  status: 'results' | 'empty' | 'needs_input' | 'unsupported_location';
  notice: string | null;
  totalCandidates: number;
  intentState?: IntentState;
  pendingInput?: PendingInput;
  excludedIds?: string[];
  clarification?: { label: string; message: string }[];
  resetRequired?: boolean;
  diagnostics?: SearchDiagnostics;
}
export const emptyFilters: Filters = {
  dateFrom: null,
  dateTo: null,
  maxPrice: null,
  category: null,
};
export const CATEGORIES: Category[] = ['Konser', 'Tiyatro', 'Stand-up', 'Workshop',
  'Sergi', 'Festival', 'Spor', 'Sinema', 'Söyleşi', 'Dans', 'Gösteri',
  'Eğitim', 'Gezi', 'Müze', 'Diğer'];
