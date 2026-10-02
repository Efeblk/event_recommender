import { resolveIdentity } from "./resolve.ts";
import type { IdentityResolution } from "./types.ts";
import type { AttendanceTiming } from "../../contracts/timing.ts";

export interface IdentityEventRecord {
  id: string;
  source?: string;
  sourceSessionIds?: string[];
  url: string;
  title: string;
  description: string;
  category: string;
  startsAt: string;
  attendanceTiming?: AttendanceTiming | null;
  venue: string;
  city: string;
  district: string;
  address: string;
  providerListing?: {
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
  };
}

/** Temporary Phase 2 adapter for the existing GCP materialization path. */
export function resolveEventRecordIdentity(
  events: readonly IdentityEventRecord[],
): IdentityResolution {
  return resolveIdentity(
    events.map((event) =>
      event.providerListing
        ? {
            ...event.providerListing,
            // Current EventRecord IDs are the 24-character compatibility projection
            // of listingId. Resolver outputs must remain addressable by the web map;
            // the complete provider identity evidence is retained in every other field.
            listingId: event.id,
          }
        : {
            listingId: event.id,
            provider: event.source ?? "legacy-unknown",
            providerSessionIds: event.sourceSessionIds ?? [],
            url: event.url,
            title: event.title,
            description: event.description,
            category: event.category,
            startsAt: event.startsAt,
            attendanceTiming: event.attendanceTiming,
            city: event.city,
            venue: { name: event.venue, district: event.district, address: event.address },
          },
    ),
  );
}
