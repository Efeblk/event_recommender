import { sql } from './db.mjs';
import { createSqlPublicationRepository } from '../../web/lib/publication-repository.ts';

export function createPublicationStore(query = sql, options = {}) {
  return createSqlPublicationRepository(query, options);
}
