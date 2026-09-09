export type Category = 'Konser' | 'Tiyatro' | 'Stand-up';
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
  checkedAt: string;
}
export interface Filters {
  dateFrom: string | null;
  dateTo: string | null;
  maxPrice: number | null;
  category: Category | null;
}
export interface Message {
  role: 'user' | 'assistant';
  content: string;
}
export interface Recommendation {
  event: EventRecord;
  reason: string;
}
export interface SearchResult {
  message: string;
  recommendations: Recommendation[];
  filters: Filters;
  mode: 'filters' | 'ai' | 'semantic';
  notice: string | null;
  totalCandidates: number;
}
export const emptyFilters: Filters = {
  dateFrom: null,
  dateTo: null,
  maxPrice: null,
  category: null,
};
export const CATEGORIES: Category[] = ['Konser', 'Tiyatro', 'Stand-up'];
