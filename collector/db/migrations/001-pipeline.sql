CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS biplan_pipeline;
CREATE TABLE biplan_pipeline.migrations (version integer PRIMARY KEY, sha256 text NOT NULL);
CREATE TABLE biplan_pipeline.raw_objects (
 sha256 text PRIMARY KEY CHECK (sha256 ~ '^[a-f0-9]{64}$'), object_key text NOT NULL,
 bytes bigint NOT NULL CHECK(bytes >= 0), verified_at timestamptz NOT NULL
);
CREATE TABLE biplan_pipeline.collections (
 id text PRIMARY KEY, input_hash text NOT NULL, scope text NOT NULL CHECK(scope IN ('complete','partial','unknown')),
 horizon_start timestamptz, horizon_end timestamptz, inventory jsonb NOT NULL,
 state text NOT NULL DEFAULT 'collected' CHECK(state IN ('collected','prepared','published')),
 publication_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(scope <> 'complete' OR (horizon_start IS NOT NULL AND horizon_end > horizon_start))
);
CREATE TABLE biplan_pipeline.fetches (
 id text PRIMARY KEY, provider text NOT NULL, url text NOT NULL, method text NOT NULL DEFAULT 'GET',
 status integer CHECK(status BETWEEN 100 AND 599), headers jsonb NOT NULL DEFAULT '{}',
 fetched_at timestamptz NOT NULL, collector_revision text NOT NULL, raw_sha256 text REFERENCES biplan_pipeline.raw_objects,
 complete boolean, receipt_text text
);
CREATE TABLE biplan_pipeline.page_receipts (
 collection_id text REFERENCES biplan_pipeline.collections, url text NOT NULL, provider text NOT NULL,
 status text NOT NULL CHECK(status IN ('verified','retired','failed','quarantined','unvisited')),
 observed_at timestamptz NOT NULL, raw_sha256 text REFERENCES biplan_pipeline.raw_objects,
 listing_ids jsonb NOT NULL, reconciliation_required boolean NOT NULL DEFAULT false, PRIMARY KEY(collection_id,url),
 CHECK(status NOT IN ('verified','retired') OR raw_sha256 IS NOT NULL),
 CHECK(status <> 'retired' OR jsonb_array_length(listing_ids)=0)
);
CREATE TABLE biplan_pipeline.listings (
 revision_id text PRIMARY KEY, listing_id text NOT NULL, input_hash text NOT NULL,
 provider text NOT NULL CHECK(provider IN ('biletix','biletinial','bubilet')), provider_event_id text,
 provider_session_ids text[] NOT NULL, url text NOT NULL, title text NOT NULL,
 description text NOT NULL, category text NOT NULL, starts_at timestamptz NOT NULL,
 observed_at timestamptz NOT NULL, availability text NOT NULL,
 raw_sha256 text NOT NULL REFERENCES biplan_pipeline.raw_objects, extractor_version text NOT NULL,
 body jsonb NOT NULL, UNIQUE(listing_id,input_hash), UNIQUE(listing_id,revision_id)
);
CREATE TABLE biplan_pipeline.listing_heads (
 listing_id text PRIMARY KEY, revision_id text NOT NULL,
 withheld boolean NOT NULL DEFAULT false, reason text,
 FOREIGN KEY(listing_id,revision_id) REFERENCES biplan_pipeline.listings(listing_id,revision_id)
);
CREATE TABLE biplan_pipeline.collection_listings (
 collection_id text REFERENCES biplan_pipeline.collections, listing_id text,
 revision_id text NOT NULL, PRIMARY KEY(collection_id,listing_id),
 FOREIGN KEY(listing_id,revision_id) REFERENCES biplan_pipeline.listings(listing_id,revision_id)
);
CREATE TABLE biplan_pipeline.normalized_listings (
 revision_id text REFERENCES biplan_pipeline.listings,
 title_key text NOT NULL, venue_key text NOT NULL, category text NOT NULL, district text, body jsonb NOT NULL,
 normalization_version text NOT NULL, PRIMARY KEY(revision_id,normalization_version)
);
CREATE TABLE biplan_pipeline.venues (
 id text PRIMARY KEY, name text NOT NULL, district text, location geography(Point,4326), evidence jsonb NOT NULL
);
CREATE INDEX venues_name_trgm ON biplan_pipeline.venues USING gin(name gin_trgm_ops);
CREATE INDEX venues_location ON biplan_pipeline.venues USING gist(location);
CREATE TABLE biplan_pipeline.venue_aliases (
 venue_id text REFERENCES biplan_pipeline.venues, provider text NOT NULL, name text NOT NULL,
 provider_venue_id text, input_hash text NOT NULL, PRIMARY KEY(venue_id,provider,name,input_hash)
);
CREATE INDEX venue_aliases_name_trgm ON biplan_pipeline.venue_aliases USING gin(name gin_trgm_ops);
CREATE TABLE biplan_pipeline.productions (id text PRIMARY KEY, title_key text NOT NULL, category text NOT NULL);
CREATE TABLE biplan_pipeline.sessions (
 revision_id text PRIMARY KEY, id text NOT NULL, production_id text REFERENCES biplan_pipeline.productions,
 venue_id text NOT NULL REFERENCES biplan_pipeline.venues, starts_at timestamptz NOT NULL, city text NOT NULL,
 dependency_hash text NOT NULL, UNIQUE(id,revision_id)
);
CREATE TABLE biplan_pipeline.session_listings (
 session_revision_id text REFERENCES biplan_pipeline.sessions, listing_revision_id text REFERENCES biplan_pipeline.listings,
 provider text NOT NULL, PRIMARY KEY(session_revision_id,listing_revision_id), UNIQUE(session_revision_id,provider)
);
CREATE TABLE biplan_pipeline.collection_sessions (
 collection_id text REFERENCES biplan_pipeline.collections, session_id text NOT NULL, revision_id text NOT NULL,
 search_document_id text,
 PRIMARY KEY(collection_id,session_id), FOREIGN KEY(session_id,revision_id) REFERENCES biplan_pipeline.sessions(id,revision_id)
);
CREATE TABLE biplan_pipeline.identity_decisions (
 input_hash text NOT NULL, rule_version text NOT NULL, left_listing_id text NOT NULL, right_listing_id text NOT NULL,
 outcome text NOT NULL, rule text NOT NULL, evidence jsonb NOT NULL,
 model_version text, calibration_version text, evidence_hash text, manual_override boolean NOT NULL DEFAULT false,
 PRIMARY KEY(input_hash,rule_version)
);
CREATE TABLE biplan_pipeline.identity_judgments (
 cache_key text PRIMARY KEY CHECK(cache_key ~ '^[a-f0-9]{64}$'),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'), rubric_version text NOT NULL,
 model_version text NOT NULL, calibration_version text,
 outcome text NOT NULL CHECK(outcome IN ('same_session','different','insufficient_evidence')),
 same_probability double precision NOT NULL CHECK(same_probability BETWEEN 0 AND 1),
 different_probability double precision NOT NULL CHECK(different_probability BETWEEN 0 AND 1),
 insufficient_probability double precision NOT NULL CHECK(insufficient_probability BETWEEN 0 AND 1),
 confidence double precision NOT NULL CHECK(confidence BETWEEN 0 AND 1),
 input_tokens integer NOT NULL CHECK(input_tokens>=0), output_tokens integer NOT NULL CHECK(output_tokens>=0),
 evidence jsonb NOT NULL CHECK(jsonb_typeof(evidence)='array' AND jsonb_array_length(evidence)=2),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(abs(same_probability+different_probability+insufficient_probability-1)<=0.02)
);
CREATE TABLE biplan_pipeline.offers (
 revision_id text PRIMARY KEY, id text NOT NULL, listing_revision_id text NOT NULL REFERENCES biplan_pipeline.listings,
 provider text NOT NULL, url text NOT NULL, availability text NOT NULL, observed_at timestamptz NOT NULL,
 dependency_hash text NOT NULL, UNIQUE(id,revision_id), UNIQUE(listing_revision_id)
);
CREATE TABLE biplan_pipeline.offer_tiers (
 offer_revision_id text REFERENCES biplan_pipeline.offers, tier_index integer NOT NULL CHECK(tier_index>=0),
 provider_tier_id text, name text, price_minor bigint CHECK(price_minor>=0), currency text NOT NULL,
 availability text NOT NULL, fee_minor bigint CHECK(fee_minor>=0), price_kind text NOT NULL DEFAULT 'starting' CHECK(price_kind IN ('starting','total')),
 PRIMARY KEY(offer_revision_id,tier_index), CHECK(price_kind <> 'total' OR fee_minor IS NOT NULL)
);
CREATE TABLE biplan_pipeline.search_documents (
 id text PRIMARY KEY, session_revision_id text NOT NULL REFERENCES biplan_pipeline.sessions,
 document_hash text NOT NULL, document_text text NOT NULL, lexical tsvector NOT NULL, lexical_tokens text[] NOT NULL, prepared_location jsonb,
 embedding_profile text, embedding vector(1024), embedding_status text NOT NULL CHECK(embedding_status IN ('cached','missing','failed')),
 CHECK((embedding IS NULL)=(embedding_status<>'cached'))
);
ALTER TABLE biplan_pipeline.collection_sessions ADD FOREIGN KEY(search_document_id) REFERENCES biplan_pipeline.search_documents(id);
CREATE INDEX search_documents_lexical ON biplan_pipeline.search_documents USING gin(lexical);
CREATE TABLE biplan_pipeline.publications (
 id text PRIMARY KEY, manifest jsonb NOT NULL, content_hash text NOT NULL, session_count integer NOT NULL,
 offer_count integer NOT NULL, validated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE biplan_pipeline.publication_sessions (
 publication_id text REFERENCES biplan_pipeline.publications, session_id text NOT NULL,
 session_revision_id text NOT NULL, search_document_id text NOT NULL REFERENCES biplan_pipeline.search_documents,
 body jsonb NOT NULL, PRIMARY KEY(publication_id,session_id),
 FOREIGN KEY(session_id,session_revision_id) REFERENCES biplan_pipeline.sessions(id,revision_id)
);
CREATE TABLE biplan_pipeline.publication_offers (
 publication_id text NOT NULL, session_id text NOT NULL, offer_id text NOT NULL, offer_revision_id text NOT NULL,
 PRIMARY KEY(publication_id,session_id,offer_id), FOREIGN KEY(publication_id,session_id) REFERENCES biplan_pipeline.publication_sessions,
 FOREIGN KEY(offer_id,offer_revision_id) REFERENCES biplan_pipeline.offers(id,revision_id)
);
CREATE TABLE biplan_pipeline.active_publication (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), publication_id text REFERENCES biplan_pipeline.publications
);
INSERT INTO biplan_pipeline.active_publication(singleton,publication_id) VALUES(true,NULL);
CREATE TABLE biplan_pipeline.jobs (
 id text PRIMARY KEY, stage text NOT NULL, subject text NOT NULL, input_hash text NOT NULL, stage_version text NOT NULL,
 input jsonb NOT NULL, output jsonb, state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','completed','failed')),
 fence bigint NOT NULL DEFAULT 0, lease_owner text, lease_until timestamptz, attempt integer NOT NULL DEFAULT 0,
 UNIQUE(stage,subject,input_hash,stage_version)
);
CREATE TABLE biplan_pipeline.collection_jobs (
 collection_id text REFERENCES biplan_pipeline.collections, job_id text REFERENCES biplan_pipeline.jobs, PRIMARY KEY(collection_id,job_id)
);
CREATE TABLE biplan_pipeline.raw_collections (
 id text PRIMARY KEY, input_hash text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE biplan_pipeline.raw_collection_jobs (
 raw_collection_id text REFERENCES biplan_pipeline.raw_collections, job_id text REFERENCES biplan_pipeline.jobs, PRIMARY KEY(raw_collection_id,job_id)
);
CREATE TABLE biplan_pipeline.job_attempts (
 job_id text REFERENCES biplan_pipeline.jobs, fence bigint NOT NULL, owner text NOT NULL,
 started_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 outcome text, cost_microusd bigint NOT NULL DEFAULT 0 CHECK(cost_microusd>=0), error_code text,
 PRIMARY KEY(job_id,fence)
);
