-- 001_initial_schema.sql
-- Core schema for History Of: terms, tags, events, sources, and crawl bookkeeping.
--
-- Dates are stored as integers (negative year = BCE) instead of DATE, because
-- DATE cannot go before 4713 BCE and cannot express "12th century".

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE term_type AS ENUM (
  'country', 'empire', 'state', 'city', 'region',
  'war', 'battle', 'person', 'organization', 'idea', 'invention', 'other'
);

CREATE TYPE date_precision AS ENUM (
  'day', 'month', 'year', 'decade', 'century', 'millennium'
);

CREATE TYPE crawl_status AS ENUM (
  'queued', 'running', 'succeeded', 'failed'
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- array_to_string() is only STABLE, so it can't be used in a generated column.
-- For text[] input the result is deterministic, so this wrapper is safe.
CREATE FUNCTION immutable_array_to_string(arr text[], sep text)
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE
RETURN array_to_string(arr, sep);

-- Keeps updated_at current on every UPDATE.
CREATE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- sources: where events come from (for attribution and licensing)
-- ---------------------------------------------------------------------------
CREATE TABLE sources (
  id          smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text NOT NULL,
  base_url    text,
  license     text,                      -- e.g. 'CC BY-SA 4.0', 'CC0'
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- terms: named things that have a history (Japan, Roman Empire, Internet…)
-- ---------------------------------------------------------------------------
CREATE TABLE terms (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug             text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name             text NOT NULL,
  type             term_type NOT NULL DEFAULT 'other',
  description      text,
  aliases          text[] NOT NULL DEFAULT '{}',
  wikidata_id      text UNIQUE CHECK (wikidata_id ~ '^Q[0-9]+$'),
  start_year       integer,              -- negative = BCE; NULL = unknown
  end_year         integer,              -- NULL = still exists / ongoing
  image_url        text,
  crawl_priority   smallint NOT NULL DEFAULT 0,
  last_crawled_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', name), 'A') ||
    setweight(to_tsvector('simple', immutable_array_to_string(aliases, ' ')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) STORED,

  CHECK (end_year IS NULL OR start_year IS NULL OR end_year >= start_year)
);

CREATE INDEX terms_name_trgm   ON terms USING gin (name gin_trgm_ops);
CREATE INDEX terms_search_tsv  ON terms USING gin (search_tsv);
CREATE INDEX terms_aliases     ON terms USING gin (aliases);
CREATE INDEX terms_crawl_queue ON terms (crawl_priority DESC, last_crawled_at NULLS FIRST);

CREATE TRIGGER terms_updated_at BEFORE UPDATE ON terms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- tags: themes that span many terms (war, treaty, revolution…)
-- ---------------------------------------------------------------------------
CREATE TABLE tags (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text NOT NULL,
  description text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tags_name_trgm ON tags USING gin (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- events: dated things that happened
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         text NOT NULL,
  summary       text,

  start_year    integer  NOT NULL,       -- negative = BCE
  start_month   smallint CHECK (start_month BETWEEN 1 AND 12),
  start_day     smallint CHECK (start_day BETWEEN 1 AND 31),
  end_year      integer,
  end_month     smallint CHECK (end_month BETWEEN 1 AND 12),
  end_day       smallint CHECK (end_day BETWEEN 1 AND 31),
  precision     date_precision NOT NULL DEFAULT 'year',
  display_date  text,                    -- pre-formatted, e.g. 'c. 1200 BCE'

  importance    smallint NOT NULL DEFAULT 50 CHECK (importance BETWEEN 0 AND 100),
  location      jsonb,                   -- { "name": "...", "lat": 0, "lon": 0 }
  content_hash  text NOT NULL UNIQUE,    -- dedupe guard for re-crawls
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  -- One sortable number: year, then month, then day.
  sort_key bigint GENERATED ALWAYS AS (
    start_year::bigint * 10000
    + coalesce(start_month, 0) * 100
    + coalesce(start_day, 0)
  ) STORED,

  CHECK (start_day IS NULL OR start_month IS NOT NULL),
  CHECK (end_day   IS NULL OR end_month   IS NOT NULL),
  CHECK (end_month IS NULL OR end_year    IS NOT NULL),
  CHECK (end_year  IS NULL OR end_year >= start_year)
);

CREATE INDEX events_sort_key    ON events (sort_key);
CREATE INDEX events_title_trgm  ON events USING gin (title gin_trgm_ops);

CREATE TRIGGER events_updated_at BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Links
-- ---------------------------------------------------------------------------

-- An event can appear on many term timelines.
CREATE TABLE event_terms (
  event_id    bigint NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  term_id     bigint NOT NULL REFERENCES terms  (id) ON DELETE CASCADE,
  relevance   real    NOT NULL DEFAULT 1.0 CHECK (relevance BETWEEN 0 AND 1),
  is_primary  boolean NOT NULL DEFAULT false,  -- the term the event is "mainly about"
  PRIMARY KEY (event_id, term_id)
);

CREATE INDEX event_terms_term ON event_terms (term_id, event_id);
-- At most one primary term per event.
CREATE UNIQUE INDEX event_terms_one_primary ON event_terms (event_id) WHERE is_primary;

CREATE TABLE event_tags (
  event_id  bigint  NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  tag_id    integer NOT NULL REFERENCES tags   (id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, tag_id)
);

CREATE INDEX event_tags_tag ON event_tags (tag_id, event_id);

CREATE TABLE event_sources (
  event_id      bigint   NOT NULL REFERENCES events  (id) ON DELETE CASCADE,
  source_id     smallint NOT NULL REFERENCES sources (id) ON DELETE RESTRICT,
  url           text NOT NULL,
  external_id   text,                    -- e.g. Wikidata QID of the event
  retrieved_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, source_id, url)
);

CREATE INDEX event_sources_source ON event_sources (source_id);

-- ---------------------------------------------------------------------------
-- Crawl bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE crawl_jobs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term_id      bigint   REFERENCES terms   (id) ON DELETE SET NULL,
  source_id    smallint REFERENCES sources (id) ON DELETE SET NULL,
  status       crawl_status NOT NULL DEFAULT 'queued',
  stats        jsonb NOT NULL DEFAULT '{}',   -- { "fetched": n, "inserted": n, ... }
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  CHECK (finished_at IS NULL OR started_at IS NOT NULL)
);

CREATE INDEX crawl_jobs_status ON crawl_jobs (status, created_at);
CREATE INDEX crawl_jobs_term   ON crawl_jobs (term_id, created_at DESC);

-- Searches for terms we don't have yet, so they can be queued for crawling.
CREATE TABLE term_requests (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  query             text NOT NULL UNIQUE,  -- normalized (lower-cased, trimmed)
  count             integer NOT NULL DEFAULT 1 CHECK (count > 0),
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  resolved_term_id  bigint REFERENCES terms (id) ON DELETE SET NULL
);

CREATE INDEX term_requests_open ON term_requests (count DESC) WHERE resolved_term_id IS NULL;
