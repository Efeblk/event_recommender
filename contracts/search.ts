import { categoryForEvent } from './category.ts';
import { normalize } from './district.ts';
import { prepareEventLocation, type PreparedLocation } from './location.ts';
import { sha256Hex } from './hash.ts';

export interface SearchDocumentFields {
  title: string;
  category: string;
  venue: string;
  description: string;
}
export interface ListingSearchMember {
  title: string;
  category: string;
  description: string;
  venue: { name: string; district?: string; address?: string };
}
export interface PreparedListingSearchRecord {
  version: 1;
  documentText: string;
  documentHash: string;
  lexicalTokens: string[];
  location: PreparedLocation;
}

const stop = new Set('bir biraz icin olsun bana gore olan var neler ne bu ve ile etkinlik istiyorum plan daha tl lira hafta sonu'.split(' '));
export function searchTokens(text: string): string[] {
  return normalize(text).split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !stop.has(word));
}
export function voyageDocumentText<T extends SearchDocumentFields>(event: T): string {
  return [`Title: ${event.title.trim()}`,`Category: ${event.category.trim()}`,`Venue: ${event.venue.trim()}`,`Description: ${event.description.trim()}`].join('\n').slice(0, 10000);
}
export function prepareLexicalDocumentTokens(event: SearchDocumentFields): string[] {
  return searchTokens([event.title,event.category,event.venue,event.description].join(' '));
}

/** Shared publication preparation for one resolved session's representative listing. */
export function prepareListingSearchRecord(session: {members: readonly ListingSearchMember[]}): PreparedListingSearchRecord {
  const first = session.members[0];
  if (!first) throw new Error('Search record requires at least one listing');
  const category = categoryForEvent(first.category, first.title, first.description);
  const fields = { title:first.title, category, venue:first.venue.name, description:first.description };
  const documentText = voyageDocumentText(fields);
  return {
    version:1,
    documentText,
    documentHash:sha256Hex(documentText),
    lexicalTokens:prepareLexicalDocumentTokens(fields),
    location:prepareEventLocation({ district:first.venue.district, address:first.venue.address }),
  };
}
