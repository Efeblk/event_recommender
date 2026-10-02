import {
  LOCATION_PROFILE,
  districtSide,
  placeOf,
  prepareEventLocation as prepareSharedEventLocation,
  resolveEventLocation as resolveSharedEventLocation,
  type EventLocation,
  type IstanbulSide,
} from '../../contracts/location.ts';
import type { EventRecord, PreparedLocation } from './types.ts';

export { districtSide, placeOf };
export type { EventLocation, IstanbulSide };

export function resolveEventLocation(event: EventRecord): EventLocation {
  return resolveSharedEventLocation(event);
}
export function prepareEventLocation(event: EventRecord): PreparedLocation {
  return prepareSharedEventLocation(event) as PreparedLocation;
}

const fallbackLocations = new WeakMap<EventRecord, EventLocation>();
export function eventLocation(event: EventRecord): EventLocation {
  const prepared = event.preparedSearch?.location;
  if (prepared?.profile === LOCATION_PROFILE) return prepared;
  let location = fallbackLocations.get(event);
  if (!location) {
    location = resolveEventLocation(event);
    fallbackLocations.set(event, location);
  }
  return location;
}
