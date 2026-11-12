# Database

PostgreSQL schema for History Of, written as plain SQL migrations. No ORM is chosen yet, so the schema doesn't depend on one.

```
history-of-db/
├── migrations/                    # Applied in filename order, each once (tracked in schema_migrations)
│   ├── 001_initial_schema.sql
│   └── 002_terms_metadata.sql
├── seeds/                         # Loaded in name order by migrate.sh --seed; all safe to re-run
│   ├── 001_countries.sql          # Country terms
│   └── 002_country_events/        # One events file per country: <slug>.sql (+ README.md with counts)
└── scripts/
    ├── migrate.sh                 # Create DB, apply migrations, run seeds
    ├── fetch-countries.mjs        # Regenerates seeds/001_countries.sql
    └── fetch-country-events.mjs   # Regenerates seeds/002_country_events/
```

Seeds follow the same numbering as migrations. A numbered `.sql` file runs as is; a numbered folder runs every `.sql` file inside it. To add a seed, give it the next number (`003_…`).

## Seeds

| Seed | Contents |
|---|---|
| `001_countries.sql` | 196 current sovereign states as `country` terms: UN members plus Palestine, Vatican City, Kosovo and Taiwan, minus the countries in the `EXCLUDE` list of `fetch-countries.mjs` (currently Israel). Each has a slug, name, Wikidata description, aliases, Wikidata ID and `metadata` (ISO alpha-2/alpha-3, capital) |
| `002_country_events/<slug>.sql` | Historical events for one country (191 files; Bahamas, Barbados, Samoa, Tuvalu and Zambia have none yet): wars, battles, treaties, revolutions, coups, disasters, epidemics, historical periods and more. Up to 60 per country, ranked by how many Wikipedia language editions cover the event, plus every event Wikidata lists as the country's "significant event". Each event has tags, dates with precision, importance, a two-sentence Wikipedia summary, and Wikipedia + Wikidata sources |

Both are generated; don't edit them by hand.

- **Countries:** `node scripts/fetch-countries.mjs` (needs network). Name fixes and extra aliases live in the `OVERRIDES` table in that script; countries to leave out live in `EXCLUDE`.
- **Country events:** `node scripts/fetch-country-events.mjs [--max-per-country 60] [--skip Q852190]`. It rewrites the whole `002_country_events/` folder, including its `README.md` with per-country counts. A full run takes a while because it paces its requests to Wikidata and Wikipedia. Responses are cached in `.cache/` (git-ignored), so a re-run picks up where it stopped. The event types, their tags and minimum popularity live in `EVENT_TYPES` at the top of the script. `EXCLUDE_TITLE` drops events by title (currently any title naming Israel). If a large event type keeps timing out on Wikidata, the script retries it in batches of 40 countries.

Each country events file is self-contained (it adds the sources and tags it uses) and can be loaded on its own once the migrations and `001_countries.sql` have run:

```bash
psql "$DATABASE_URL" -f seeds/002_country_events/japan.sql
```

Events shared by several countries (e.g. World War II) are stored once and linked to each country.

## One-time setup

PostgreSQL must be running locally (tested with PostgreSQL 17). Give your OS user a database role that can create databases:

```bash
sudo -u postgres createuser --createdb "$USER"
```

Then, from this folder:

```bash
cp .env.local.example .env.local  # optional; defaults to postgresql:///history_of?host=/var/run/postgresql
scripts/migrate.sh --seed         # creates history_of, applies migrations, loads seeds
psql history_of                   # look around
```

## Commands

| Command | What it does |
|---|---|
| `scripts/migrate.sh` | Creates the database if missing and applies pending migrations |
| `scripts/migrate.sh --seed` | Same, then runs every file in `seeds/` |
| `scripts/migrate.sh --reset --seed` | Drops and recreates the database first (**destroys local data**) |

**Rule:** never edit a migration that has already been applied. Add a new one (`002_….sql`) instead. The script stores a checksum per migration and stops if an applied file changes.

## Tables

| Table | Purpose |
|---|---|
| `terms` | Things with a history (`Japan`, `Roman Empire`). Slug, type, aliases, Wikidata ID, year span, `metadata` (JSONB), generated `search_tsv` for search |
| `tags` | Themes across terms (`war`, `treaty`) |
| `events` | Dated happenings. Integer years (negative = BCE), optional month/day, `precision`, `display_date`, `importance`, generated `sort_key` |
| `event_terms` | Event ↔ term (many-to-many). `is_primary` marks the main term; at most one per event |
| `event_tags` | Event ↔ tag (many-to-many) |
| `sources` | Data sources and their licenses (Wikipedia, Wikidata) |
| `event_sources` | Which source (and URL) each event came from |
| `crawl_jobs` | Crawler run log: status, stats, errors |
| `term_requests` | Searches for terms we don't have yet, counted so they can be queued for crawling |
| `schema_migrations` | Created by `migrate.sh`; records applied migrations |

### Design notes

- **Years are integers, not `DATE`.** `DATE` can't go before 4713 BCE or say "12th century". `sort_key = year * 10000 + month * 100 + day` gives a single sortable index.
- **Dedupe:** `events.content_hash` is unique, so re-running a crawl doesn't create duplicates.
- **Search:** `pg_trgm` GIN indexes on `terms.name`, `tags.name` and `events.title` support typo-tolerant autocomplete. `terms.search_tsv` (name > aliases > description) supports full-text ranking.

## Example query: a term's timeline

```sql
SELECT e.display_date, e.title,
       array_agg(DISTINCT tg.slug) AS tags
FROM terms t
JOIN event_terms et ON et.term_id = t.id
JOIN events e       ON e.id = et.event_id
LEFT JOIN event_tags etg ON etg.event_id = e.id
LEFT JOIN tags tg        ON tg.id = etg.tag_id
WHERE t.slug = 'japan'
GROUP BY e.id
ORDER BY e.sort_key;
```
