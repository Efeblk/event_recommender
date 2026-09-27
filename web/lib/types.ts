import type { IntentState } from './input-state.ts';

export type Category = 'Konser' | 'Tiyatro' | 'Stand-up';
export interface EventOffer {
  id: string;
  source?: EventRecord['source'];
  url: string;
  price: number | null;
  currency: string;
  checkedAt: string;
  category: string;
  venue: string;
  availability: EventRecord['availability'];
}
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
  category: string;
  availability: 'available' | 'sold_out' | 'cancelled' | 'unknown';
  source?: 'biletinial' | 'bubilet' | 'biletix';
  sourceVersion?: string;
  extraction?: string;
  productionKey?: string;
  offers?: EventOffer[];
  mergedIds?: string[];
  canonicalProductionKey?: string;
  canonicalShowKey?: string;
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
export interface SearchResult {
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
}
export const emptyFilters: Filters = {
  dateFrom: null,
  dateTo: null,
  maxPrice: null,
  category: null,
};
export const CATEGORIES: Category[] = ['Konser', 'Tiyatro', 'Stand-up'];
