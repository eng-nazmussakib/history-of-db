-- 002_terms_metadata.sql
-- Free-form per-term data that doesn't deserve its own column
-- (e.g. ISO 3166 codes and capital for countries).

ALTER TABLE terms ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';

-- Look up countries by ISO code (e.g. for flags or map data later).
CREATE UNIQUE INDEX terms_iso_alpha2 ON terms ((metadata ->> 'iso_alpha2'))
  WHERE metadata ? 'iso_alpha2' AND metadata ->> 'iso_alpha2' IS NOT NULL;
