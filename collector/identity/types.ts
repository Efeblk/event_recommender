import type { AttendanceTiming } from "../../contracts/timing.ts";

export interface IdentityListing {
  listingId: string;
  provider: string;
  providerEventId?: string;
  providerSessionIds: string[];
  url: string;
  title: string;
  description: string;
  category: string;
  startsAt: string;
  attendanceTiming?: AttendanceTiming | null;
  venue: {
    name: string;
    providerVenueId?: string;
    address?: string;
    district?: string;
    geo?: { lat: number; lon: number };
  };
  city?: string;
}

export interface ResolvedVenue {
  id: string;
  canonicalName: string;
  listingIds: string[];
  evidence: string[];
}

export type IdentityDecisionOutcome =
  | "auto_merge"
  | "manual_merge"
  | "jev_merge"
  | "never_merge"
  | "unresolved";

export interface IdentityDecision {
  listingIds: [string, string];
  inputHash: string;
  ruleVersion: string;
  outcome: IdentityDecisionOutcome;
  rule: string;
  evidence: string[];
  modelVersion?: string;
  calibrationVersion?: string;
  evidenceHash?: string;
}

export interface ResolvedSession {
  id: string;
  listingIds: string[];
  startsAt: string;
  city: string;
  venueId: string;
}

export interface IdentityResolution {
  venues: ResolvedVenue[];
  listingVenueIds: Record<string, string>;
  sessions: ResolvedSession[];
  decisions: IdentityDecision[];
}
