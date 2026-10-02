import type { Provider, ProviderTicketTierV1 } from './listing.ts';
export const PUBLICATION_VERSION = 'published-catalog.v1' as const;
export interface PublishedOfferV1 {
  id: string; revisionId: string; listingId: string; listingRevisionId: string;
  provider: Provider; url: string; observedAt: string; availability: string;
  tiers: Array<ProviderTicketTierV1 & { feeMinor: null; priceKind: 'starting' }>;
}
export interface PublishedSessionV1 {
  id: string; revisionId: string; productionId: string; venueId: string;
  title: string; description: string; category: string; startsAt: string; city: string;
  venue: { name: string; district?: string; address?: string; geo?: {lat:number;lon:number} };
  attendanceTiming?: unknown; imageUrl?: string;
  offers: PublishedOfferV1[];
  document: { id: string; hash: string; text: string; lexicalTokens:string[]; location:unknown; embeddingProfile: string | null; vector: number[] | null };
}
export interface PublicationManifestV1 {
  contractVersion: typeof PUBLICATION_VERSION;
  scope: 'complete' | 'partial' | 'unknown';
  horizon: { start: string; end: string } | null;
  inventoryHash: string; pageCount: number; sessionCount: number; offerCount: number;
  lexicalOnlyCount: number;
  pages: Array<{url:string;provider:string;status:string;observedAt:string;rawObjectSha256:string|null}>;
  sessionPins: Array<{id:string;revisionId:string;documentId:string;offerRevisionIds:string[]}>;
}
export interface PublishedCatalogV1 {
  publicationId: string; contentHash: string; manifest: PublicationManifestV1; sessions: PublishedSessionV1[];
}
export interface SelectedPublishedOfferV1 {
  sessionId: string; offerId: string; offerRevisionId: string;
}
export interface RevalidatedPublishedOfferV1 extends SelectedPublishedOfferV1 {
  usable: boolean; reasons: string[];
}
