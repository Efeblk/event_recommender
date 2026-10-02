import { prepareListingSearchRecord } from '../../contracts/search.ts';

export const SEARCH_RECORD_VERSION='pipeline-search.v1';

/** Voyage-compatible text and lexical token preparation; no requests or web imports. */
export function preparePipelineSearchRecord(session) {
  const prepared=prepareListingSearchRecord(session);
  return {text:prepared.documentText,lexicalTokens:prepared.lexicalTokens,location:prepared.location};
}
