import {
  sqliteTable,
  text,
  integer,
  real,
  index,
} from 'drizzle-orm/sqlite-core';
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    startsAt: text('starts_at').notNull(),
    checkedAt: text('checked_at').notNull(),
    category: text('category').notNull(),
    price: real('price'),
    sourceUrl: text('source_url').notNull(),
    payload: text('payload').notNull(),
  },
  (t) => [
    index('idx_events_starts_at').on(t.startsAt),
    index('idx_events_source_url').on(t.sourceUrl),
  ],
);
export const embeddings = sqliteTable('embeddings', {
  eventId: text('event_id').primaryKey(),
  hash: text('hash').notNull(),
  model: text('model').notNull(),
  vector: text('vector').notNull(),
});
export const metadata = sqliteTable('metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
export const limits = sqliteTable(
  'request_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    expiresAt: integer('expires_at').notNull(),
  },
  (t) => [index('idx_request_limits_expires_at').on(t.expiresAt)],
);
