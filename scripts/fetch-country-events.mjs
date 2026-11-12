#!/usr/bin/env node
// Builds seeds/002_country_events/<slug>.sql: historical events for every country
// in seeds/001_countries.sql, from Wikidata (CC0) with short summaries from
// English Wikipedia (CC BY-SA 4.0).
//
//   node scripts/fetch-country-events.mjs [--max-per-country 60] [--no-cache] [--skip Q852190]
//
// Steps (responses are cached in .cache/, so a re-run resumes quickly):
//   1. SPARQL, one query per event type: items of that type with an English
//      Wikipedia article, linked to one of our countries via P17 (country)
//      or P710 (participant).
//   2. Wikidata API: each country's P793 "significant event" list.
//   3. Wikidata API: full entity data (label, dates, links) in batches of 50.
//   4. Wikipedia API: first two sentences of each article as the summary.
//   5. Rank events per country by number of Wikipedia language editions,
//      keep the top N, and write one self-contained SQL file per country.
//
// This is a stopgap until the real crawler exists. The output is committed so
// seeding never needs network access.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DB_DIR = fileURLToPath(new URL('..', import.meta.url));
const COUNTRIES_SQL = path.join(DB_DIR, 'seeds/001_countries.sql');
const OUT_DIR = path.join(DB_DIR, 'seeds/002_country_events');
const CACHE = path.join(DB_DIR, '.cache');

const args = process.argv.slice(2);
const MAX_PER_COUNTRY = Number(args[args.indexOf('--max-per-country') + 1]) || 60;
const USE_CACHE = !args.includes('--no-cache');
// --skip Q852190,Q744913 leaves out event types (e.g. ones that keep timing out).
const SKIP = new Set(args.includes('--skip') ? args[args.indexOf('--skip') + 1].split(',') : []);

const USER_AGENT = 'HistoryOf/0.1 (seed script)';
const SPARQL = 'https://query.wikidata.org/sparql';
const WD_API = 'https://www.wikidata.org/w/api.php';
const WP_API = 'https://en.wikipedia.org/w/api.php';

// Wikidata class → our tag slugs. minSitelinks filters out minor items for
// noisy classes (a protest needs more language editions than a war to count).
const EVENT_TYPES = {
  Q198: { tags: ['war'], min: 3 },                 // war
  Q8465: { tags: ['war', 'civil-war'], min: 3 },   // civil war
  Q103495: { tags: ['war'], min: 3 },              // world war
  Q21994376: { tags: ['war', 'independence'], min: 3 }, // war of independence
  Q350604: { tags: ['conflict'], min: 5 },         // armed conflict
  Q180684: { tags: ['conflict'], min: 5 },         // conflict
  Q178561: { tags: ['battle'], min: 5 },           // battle
  Q1261499: { tags: ['battle'], min: 5 },          // naval battle
  Q188055: { tags: ['siege'], min: 5 },            // siege
  Q467011: { tags: ['invasion'], min: 3 },         // invasion
  Q2001676: { tags: ['military'], min: 8 },        // offensive
  Q831663: { tags: ['military'], min: 8 },         // military campaign
  Q188686: { tags: ['occupation'], min: 3 },       // military occupation
  Q10931: { tags: ['revolution'], min: 3 },        // revolution
  Q124734: { tags: ['rebellion'], min: 3 },        // rebellion
  Q45382: { tags: ['coup'], min: 3 },              // coup d'état
  Q131569: { tags: ['treaty'], min: 3 },           // treaty
  Q625298: { tags: ['treaty'], min: 3 },           // peace treaty
  Q1464916: { tags: ['independence'], min: 3 },    // declaration of independence
  Q43109: { tags: ['referendum'], min: 5 },        // referendum
  Q7944: { tags: ['disaster', 'earthquake'], min: 5 },
  Q8070: { tags: ['disaster'], min: 5 },           // tsunami
  Q7692360: { tags: ['disaster'], min: 5 },        // volcanic eruption
  Q8068: { tags: ['disaster'], min: 5 },           // flood
  Q168983: { tags: ['disaster'], min: 8 },         // conflagration
  Q179057: { tags: ['disaster'], min: 8 },         // explosion
  Q3839081: { tags: ['disaster'], min: 5 },        // disaster
  Q744913: { tags: ['accident'], min: 10 },        // aviation accident
  Q852190: { tags: ['accident'], min: 10 },        // shipwreck
  Q44512: { tags: ['epidemic'], min: 3 },          // epidemic
  Q12184: { tags: ['epidemic'], min: 3 },          // pandemic
  Q168247: { tags: ['famine'], min: 3 },           // famine
  Q3199915: { tags: ['massacre'], min: 5 },        // massacre
  Q41397: { tags: ['genocide'], min: 3 },          // genocide
  Q273120: { tags: ['protest'], min: 8 },          // protest
  Q175331: { tags: ['protest'], min: 8 },          // demonstration
  Q124757: { tags: ['riot'], min: 8 },             // riot
  Q2223653: { tags: ['terrorism'], min: 8 },       // terrorist attack
  Q3882219: { tags: ['assassination'], min: 5 },   // assassination
  Q13418847: { tags: [], min: 5 },                 // historical event
  Q11514315: { tags: ['era'], min: 3 },            // historical period
};

const TAG_NAMES = {
  war: 'War', 'civil-war': 'Civil war', independence: 'Independence', conflict: 'Conflict',
  battle: 'Battle', siege: 'Siege', invasion: 'Invasion', military: 'Military',
  occupation: 'Occupation', revolution: 'Revolution', rebellion: 'Rebellion', coup: 'Coup',
  treaty: 'Treaty', referendum: 'Referendum', disaster: 'Disaster', earthquake: 'Earthquake',
  accident: 'Accident', epidemic: 'Epidemic', famine: 'Famine', massacre: 'Massacre',
  genocide: 'Genocide', protest: 'Protest', riot: 'Riot', terrorism: 'Terrorism',
  assassination: 'Assassination', era: 'Era',
};

const PRECISION = { 6: 'millennium', 7: 'century', 8: 'decade', 9: 'year', 10: 'month', 11: 'day' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const CURRENT_YEAR = new Date().getUTCFullYear();

// Events left out of every country's timeline, matched against the English
// title. Events naming Israel are excluded at the project owner's request.
const EXCLUDE_TITLE = /\bisrael(i|is)?\b/i;

// ---------------------------------------------------------------------------
// HTTP with cache, polite pacing and retries
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
let lastRequest = 0;

async function cached(name, key, fn) {
  const file = path.join(CACHE, name, `${hash(key)}.json`);
  if (USE_CACHE) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {}
  }
  const data = await fn();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
  return data;
}

async function request(url, init = {}, { gapMs = 1000, tries = 6 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const wait = lastRequest + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequest = Date.now();

    let res;
    try {
      res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, ...init.headers },
        signal: AbortSignal.timeout(90_000),
      });
    } catch (err) {
      if (attempt >= tries) throw err;
      await sleep(5000 * attempt);
      continue;
    }
    if (res.ok) {
      // WDQS can answer 200 and then cut the body off when a query times out.
      const text = await res.text().catch(() => '');
      try {
        return JSON.parse(text);
      } catch {
        if (attempt >= tries) throw new Error(`Truncated/invalid JSON from ${url.slice(0, 120)}`);
        log(`  invalid JSON (${text.length} bytes), retrying in ${10 * attempt}s`);
        await sleep(10_000 * attempt);
        continue;
      }
    }

    const retryAfter = Number(res.headers.get('retry-after'));
    if (attempt >= tries || ![429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`${res.status} from ${url.slice(0, 120)}: ${(await res.text()).slice(0, 200)}`);
    }
    const backoff = retryAfter > 0 ? retryAfter * 1000 : 10_000 * attempt;
    log(`  ${res.status}, retrying in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
  }
}

const log = (...m) => console.log(new Date().toISOString().slice(11, 19), ...m);

function sparql(query, { tries = 6 } = {}) {
  return request(SPARQL, {
    method: 'POST',
    body: new URLSearchParams({ query }),
    headers: { Accept: 'application/sparql-results+json' },
  }, { gapMs: 3000, tries });
}

function mwApi(base, params) {
  const url = `${base}?${new URLSearchParams({ format: 'json', formatversion: '2', maxlag: '5', ...params })}`;
  return request(url, {}, { gapMs: 300 });
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------
async function loadCountries() {
  const sql = await readFile(COUNTRIES_SQL, 'utf8');
  const countries = [];
  for (const line of sql.split('\n')) {
    const m = line.match(/^\s+\('([a-z0-9-]+)', .*, '(Q\d+)', '\{"iso_alpha2"/);
    if (m) countries.push({ slug: m[1], qid: m[2] });
  }
  if (countries.length < 150) throw new Error(`Only parsed ${countries.length} countries`);
  return countries;
}

const skippedTypes = [];
const CHUNK = 40; // countries per fallback SPARQL batch

const typeQuery = (type, min, qids) => `SELECT DISTINCT ?e WHERE {
      ?e wdt:P31 wd:${type} ; wikibase:sitelinks ?sl . FILTER(?sl >= ${min})
      ?e wdt:P17|wdt:P710 ?c . VALUES ?c { ${qids.map((q) => `wd:${q}`).join(' ')} }
    }`;

async function runTypeQuery(type, query, label, tries) {
  return cached('sparql', query, async () => {
    log(`SPARQL ${type}${label}`);
    return (await sparql(query, { tries })).results.bindings.map((b) => b.e.value.split('/').pop());
  });
}

async function candidatesByType(countryQids) {
  const ids = new Set();
  for (const [type, { min }] of Object.entries(EVENT_TYPES)) {
    if (SKIP.has(type)) {
      skippedTypes.push(type);
      continue;
    }
    let rows;
    try {
      // One query for all countries is cheapest; give it two tries.
      rows = await runTypeQuery(type, typeQuery(type, min, countryQids), '', 2);
    } catch {
      // Heavy classes (e.g. battles) can time out on WDQS. Retry in smaller
      // country batches; each batch is cached on its own.
      log(`  ${type}: full query failed, retrying in batches of ${CHUNK} countries`);
      try {
        rows = [];
        for (let i = 0; i < countryQids.length; i += CHUNK) {
          const chunk = countryQids.slice(i, i + CHUNK);
          const label = ` [${i + 1}-${i + chunk.length}]`;
          rows.push(...(await runTypeQuery(type, typeQuery(type, min, chunk), label, 6)));
        }
      } catch (err) {
        // Still failing: skip this class rather than sink the run; retried next time.
        log(`  ${type}: SKIPPED (${err.message.slice(0, 80)})`);
        skippedTypes.push(type);
        continue;
      }
    }
    rows.forEach((id) => ids.add(id));
    log(`  ${type}: ${rows.length} (total ${ids.size})`);
  }
  return ids;
}

async function getEntities(ids, props) {
  const out = {};
  const list = [...ids];
  for (let i = 0; i < list.length; i += 50) {
    const batch = list.slice(i, i + 50);
    const data = await cached('entities', `${props}|${batch.join(',')}`, () =>
      mwApi(WD_API, { action: 'wbgetentities', ids: batch.join('|'), props, languages: 'en' }),
    );
    Object.assign(out, data.entities);
    if ((i / 50) % 20 === 0) log(`  entities ${Math.min(i + 50, list.length)}/${list.length}`);
  }
  return out;
}

async function getSummaries(titles) {
  const out = {};
  const list = [...titles];
  for (let i = 0; i < list.length; i += 20) {
    const batch = list.slice(i, i + 20);
    const data = await cached('extracts', batch.join('|'), () =>
      mwApi(WP_API, {
        action: 'query', prop: 'extracts', exintro: '1', explaintext: '1',
        exsentences: '2', exlimit: '20', redirects: '1', titles: batch.join('|'),
      }),
    );
    const q = data.query ?? {};
    const back = {}; // resolved title → requested title
    for (const n of q.normalized ?? []) back[n.to] = n.from;
    for (const r of q.redirects ?? []) back[r.to] = back[r.from] ?? r.from;
    for (const p of q.pages ?? []) if (p.extract) out[back[p.title] ?? p.title] = p.extract;
    if ((i / 20) % 25 === 0) log(`  summaries ${Math.min(i + 20, list.length)}/${list.length}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing Wikidata entities
// ---------------------------------------------------------------------------
function bestClaims(entity, prop) {
  const claims = (entity.claims?.[prop] ?? []).filter((c) => c.rank !== 'deprecated' && c.mainsnak.datavalue);
  const preferred = claims.filter((c) => c.rank === 'preferred');
  return preferred.length ? preferred : claims;
}

const itemIds = (entity, prop) => bestClaims(entity, prop).map((c) => c.mainsnak.datavalue.value.id);

// Wikidata JSON times use historical numbering (no year 0; -0660 = 660 BCE),
// which matches our convention.
function parseTime(entity, prop) {
  const claim = bestClaims(entity, prop)[0];
  if (!claim) return null;
  const { time, precision } = claim.mainsnak.datavalue.value;
  const m = time.match(/^([+-])(\d+)-(\d\d)-(\d\d)/);
  if (!m || precision < 6) return null;
  const year = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  if (year === 0) return null;
  return {
    year,
    month: precision >= 10 && Number(m[3]) ? Number(m[3]) : null,
    day: precision >= 11 && Number(m[4]) ? Number(m[4]) : null,
    precision: PRECISION[Math.min(precision, 11)],
  };
}

function formatDate(d) {
  const era = d.year < 0 ? ' BCE' : '';
  const y = Math.abs(d.year);
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  switch (d.precision) {
    case 'millennium': return `${ordinal(Math.floor((y - 1) / 1000) + 1)} millennium${era}`;
    case 'century': return `${ordinal(Math.floor((y - 1) / 100) + 1)} century${era}`;
    case 'decade': return `${Math.floor(y / 10) * 10}s${era}`;
    case 'month': return `${MONTHS[d.month - 1]} ${y}${era}`;
    case 'day': return `${d.day} ${MONTHS[d.month - 1]} ${y}${era}`;
    default: return `${y}${era}`;
  }
}

function formatRange(start, end) {
  if (!end || end.year === start.year && end.month === start.month && end.day === start.day) {
    return formatDate(start);
  }
  const coarse = (d) => ['year', 'decade', 'century', 'millennium'].includes(d.precision);
  // Same year but one side only known to the year: "2021", not "2021 – 8 August 2021".
  if (start.year === end.year && (coarse(start) || coarse(end))) {
    return formatDate(coarse(start) ? start : end);
  }
  if (start.precision === 'year' && end.precision === 'year' && start.year > 0) {
    return `${start.year}–${end.year}`;
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function cleanSummary(text, fallback) {
  let s = (text ?? '').replace(/\s+/g, ' ').replace(/\s\(\s*\)/g, '').trim();
  if (s.length > 600) s = s.slice(0, s.lastIndexOf(' ', 597)) + '…';
  if (s) return s;
  return fallback ? fallback[0].toUpperCase() + fallback.slice(1) + '.' : null;
}

// Wikipedia language editions → 0–100.
const importanceOf = (sitelinks) =>
  Math.max(1, Math.min(100, Math.round((100 * Math.log(sitelinks + 1)) / Math.log(200))));

// ---------------------------------------------------------------------------
// SQL output
// ---------------------------------------------------------------------------
const sql = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

function insertChunks(table, columns, rows, size = 500) {
  const parts = [];
  for (let i = 0; i < rows.length; i += size) {
    parts.push(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n` +
        rows.slice(i, i + size).map((r) => `  (${r.map(sql).join(', ')})`).join(',\n') + ';',
    );
  }
  return parts.join('\n\n');
}

function countrySql({ slug, date, tags, events, links, eventTags }) {
  return `-- ${slug}.sql
-- GENERATED by scripts/fetch-country-events.mjs on ${date}. Do not edit by hand.
-- Sources: Wikidata (CC0) for events and dates; English Wikipedia (CC BY-SA 4.0) for summaries.
-- ${events.length} events for the term '${slug}'.
-- Safe to re-run. Events that already exist (same Wikidata item, or same title and
-- start year) are reused, so events shared between countries are stored once.

BEGIN;

INSERT INTO sources (slug, name, base_url, license) VALUES
  ('wikipedia', 'Wikipedia', 'https://en.wikipedia.org', 'CC BY-SA 4.0'),
  ('wikidata',  'Wikidata',  'https://www.wikidata.org', 'CC0')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO tags (slug, name) VALUES
${tags.map(([s, n]) => `  (${sql(s)}, ${sql(n)})`).join(',\n')}
ON CONFLICT (slug) DO NOTHING;

CREATE TEMP TABLE stage_events (
  qid text PRIMARY KEY, title text, summary text,
  start_year int, start_month smallint, start_day smallint,
  end_year int, end_month smallint, end_day smallint,
  precision date_precision, display_date text, importance smallint, url text,
  event_id bigint
) ON COMMIT DROP;
CREATE TEMP TABLE stage_links (qid text, term_slug text, relevance real, is_primary boolean) ON COMMIT DROP;
CREATE TEMP TABLE stage_tags (qid text, tag_slug text) ON COMMIT DROP;

${insertChunks('stage_events', ['qid', 'title', 'summary', 'start_year', 'start_month', 'start_day', 'end_year', 'end_month', 'end_day', 'precision', 'display_date', 'importance', 'url'], events)}

${insertChunks('stage_links', ['qid', 'term_slug', 'relevance', 'is_primary'], links, 1000)}
${eventTags.length ? '\n' + insertChunks('stage_tags', ['qid', 'tag_slug'], eventTags, 1000) + '\n' : ''}
-- Reuse events that already exist: same Wikidata item, or same title + start year.
UPDATE stage_events s SET event_id = e.id
FROM events e WHERE e.content_hash = md5('wikidata:' || s.qid);

UPDATE stage_events s SET event_id = e.id
FROM events e
WHERE s.event_id IS NULL AND lower(e.title) = lower(s.title) AND e.start_year = s.start_year;

WITH inserted AS (
  INSERT INTO events (title, summary, start_year, start_month, start_day, end_year, end_month,
                      end_day, precision, display_date, importance, content_hash, metadata)
  SELECT title, summary, start_year, start_month, start_day, end_year, end_month, end_day,
         precision, display_date, importance, md5('wikidata:' || qid),
         jsonb_build_object('wikidata_id', qid)
  FROM stage_events WHERE event_id IS NULL
  RETURNING id, metadata ->> 'wikidata_id' AS qid
)
UPDATE stage_events s SET event_id = i.id FROM inserted i WHERE i.qid = s.qid;

-- Existing events matched by title keep their own data but learn their Wikidata ID.
UPDATE events e SET metadata = e.metadata || jsonb_build_object('wikidata_id', s.qid)
FROM stage_events s WHERE e.id = s.event_id AND NOT e.metadata ? 'wikidata_id';

-- Don't add a second primary term to events that already have one.
INSERT INTO event_terms (event_id, term_id, relevance, is_primary)
SELECT s.event_id, t.id, l.relevance,
       l.is_primary AND NOT EXISTS (
         SELECT 1 FROM event_terms x WHERE x.event_id = s.event_id AND x.is_primary)
FROM stage_links l
JOIN stage_events s ON s.qid = l.qid
JOIN terms t ON t.slug = l.term_slug
ON CONFLICT (event_id, term_id) DO NOTHING;

INSERT INTO event_tags (event_id, tag_id)
SELECT s.event_id, tg.id
FROM stage_tags st
JOIN stage_events s ON s.qid = st.qid
JOIN tags tg ON tg.slug = st.tag_slug
ON CONFLICT DO NOTHING;

INSERT INTO event_sources (event_id, source_id, url, external_id)
SELECT s.event_id, src.id, s.url, NULL FROM stage_events s JOIN sources src ON src.slug = 'wikipedia'
UNION ALL
SELECT s.event_id, src.id, 'https://www.wikidata.org/wiki/' || s.qid, s.qid
FROM stage_events s JOIN sources src ON src.slug = 'wikidata'
ON CONFLICT DO NOTHING;

COMMIT;
`;
}

// ---------------------------------------------------------------------------
async function main() {
  const countries = await loadCountries();
  const qidToSlug = Object.fromEntries(countries.map((c) => [c.qid, c.slug]));
  log(`${countries.length} countries`);

  log('Step 1: candidate events by type');
  const ids = await candidatesByType(countries.map((c) => c.qid));

  log("Step 2: countries' significant events (P793)");
  const countryEntities = await getEntities(countries.map((c) => c.qid), 'claims');
  const significant = {}; // event qid → Set(country slug)
  for (const c of countries) {
    for (const id of itemIds(countryEntities[c.qid] ?? {}, 'P793')) {
      (significant[id] ??= new Set()).add(c.slug);
      ids.add(id);
    }
  }

  log(`Step 3: entity data for ${ids.size} events`);
  const entities = await getEntities(ids, 'labels|descriptions|claims|sitelinks');

  const events = [];
  for (const [qid, e] of Object.entries(entities)) {
    if (e.missing !== undefined || !e.sitelinks?.enwiki) continue;
    const title = e.labels?.en?.value ?? e.sitelinks.enwiki.title;
    if (EXCLUDE_TITLE.test(title) || EXCLUDE_TITLE.test(e.sitelinks.enwiki.title)) continue;
    const start = parseTime(e, 'P585') ?? parseTime(e, 'P580');
    if (!start || start.year > CURRENT_YEAR) continue;
    let end = parseTime(e, 'P582');
    if (end && end.year < start.year) end = null;

    const types = itemIds(e, 'P31');
    const known = types.filter((t) => EVENT_TYPES[t]);
    const sitelinks = Object.keys(e.sitelinks).length;
    if (!known.length && !significant[qid]) continue;
    // Noisy-class threshold also applies when an item is reached another way.
    if (!significant[qid] && sitelinks < Math.min(...known.map((t) => EVENT_TYPES[t].min))) continue;

    const inCountry = itemIds(e, 'P17').filter((q) => qidToSlug[q]).map((q) => qidToSlug[q]);
    const participants = itemIds(e, 'P710').filter((q) => qidToSlug[q]).map((q) => qidToSlug[q]);
    const links = new Map(); // slug → relevance
    for (const s of participants) links.set(s, 0.7);
    for (const s of inCountry) links.set(s, 1.0);
    for (const s of significant[qid] ?? []) links.set(s, 1.0);
    if (!links.size) continue;

    events.push({
      qid,
      title,
      description: e.descriptions?.en?.value ?? null,
      wikiTitle: e.sitelinks.enwiki.title,
      start, end, sitelinks,
      tags: [...new Set(known.flatMap((t) => EVENT_TYPES[t].tags))],
      links,
      primary: inCountry.length === 1 ? inCountry[0] : null,
      significantFor: significant[qid] ?? new Set(),
    });
  }
  log(`${events.length} dated events with an English article`);

  // Keep each country's top N events (all of its P793 events are always kept).
  const kept = new Map(); // qid → Set(slug)
  for (const c of countries) {
    const mine = events
      .filter((ev) => ev.links.has(c.slug))
      .sort((a, b) =>
        Number(b.significantFor.has(c.slug)) - Number(a.significantFor.has(c.slug)) ||
        b.links.get(c.slug) - a.links.get(c.slug) ||
        b.sitelinks - a.sitelinks,
      );
    const pinned = mine.filter((ev) => ev.significantFor.has(c.slug));
    const chosen = pinned.length >= MAX_PER_COUNTRY ? pinned : mine.slice(0, MAX_PER_COUNTRY);
    for (const ev of chosen) (kept.get(ev.qid) ?? kept.set(ev.qid, new Set()).get(ev.qid)).add(c.slug);
  }
  const final = events.filter((ev) => kept.has(ev.qid)).sort((a, b) => a.qid.localeCompare(b.qid, 'en', { numeric: true }));
  log(`${final.length} events kept`);

  log('Step 4: Wikipedia summaries');
  const summaries = await getSummaries(new Set(final.map((ev) => ev.wikiTitle)));

  // Build rows
  const eventRow = new Map(final.map((ev) => [ev.qid, [
    ev.qid, ev.title, cleanSummary(summaries[ev.wikiTitle], ev.description),
    ev.start.year, ev.start.month, ev.start.day,
    ev.end?.year ?? null, ev.end?.year ? ev.end.month : null, ev.end?.month ? ev.end.day : null,
    ev.start.precision, formatRange(ev.start, ev.end), importanceOf(ev.sitelinks),
    `https://en.wikipedia.org/wiki/${encodeURIComponent(ev.wikiTitle.replace(/ /g, '_'))}`,
  ]]));

  // Start from an empty folder so countries that drop out don't leave stale files.
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const date = new Date().toISOString().slice(0, 10);
  const perCountry = [];
  for (const c of countries) {
    const mine = final
      .filter((ev) => kept.get(ev.qid).has(c.slug))
      .sort((a, b) => a.start.year - b.start.year || a.qid.localeCompare(b.qid, 'en', { numeric: true }));
    perCountry.push({ slug: c.slug, count: mine.length });
    if (!mine.length) continue;

    const usedTags = [...new Set(mine.flatMap((ev) => ev.tags))].sort();
    await writeFile(path.join(OUT_DIR, `${c.slug}.sql`), countrySql({
      slug: c.slug,
      date,
      tags: usedTags.map((t) => [t, TAG_NAMES[t]]),
      events: mine.map((ev) => eventRow.get(ev.qid)),
      links: mine.map((ev) => [ev.qid, c.slug, ev.links.get(c.slug), ev.primary === c.slug]),
      eventTags: mine.flatMap((ev) => ev.tags.map((t) => [ev.qid, t])),
    }));
  }

  const empty = perCountry.filter((c) => !c.count).map((c) => c.slug);
  const counts = perCountry.map((c) => c.count).sort((a, b) => a - b);
  const shared = final.filter((ev) => kept.get(ev.qid).size > 1).length;
  await writeFile(path.join(OUT_DIR, 'README.md'), `# Country event seeds

GENERATED by \`scripts/fetch-country-events.mjs\` on ${date}. Do not edit the \`.sql\` files by hand.

- One file per country (\`<slug>.sql\`), each self-contained and safe to re-run.
- ${perCountry.length - empty.length} files, ${final.length} distinct events (${shared} shared by more than one country).
- Events per country: min ${counts.find((n) => n > 0) ?? 0}, median ${counts[Math.floor(counts.length / 2)]}, max ${counts.at(-1)} (cap ${MAX_PER_COUNTRY}).
- No events found for: ${empty.join(', ') || 'none'}.
- Event types skipped because Wikidata timed out: ${skippedTypes.join(', ') || 'none'}.

Load one country: \`psql "$DATABASE_URL" -f seeds/002_country_events/japan.sql\`
(requires the migrations and \`001_countries.sql\`, which creates the country terms).

| Country | Events |
|---|---|
${perCountry.map((c) => `| ${c.slug} | ${c.count} |`).join('\n')}
`);

  log(`Wrote ${perCountry.length - empty.length} files to ${OUT_DIR}`);
  log(`Events per country: min ${counts[0]}, median ${counts[Math.floor(counts.length / 2)]}, max ${counts.at(-1)}`);
  log(`Countries with no events (${empty.length}): ${empty.join(', ') || 'none'}`);
  if (skippedTypes.length) log(`Skipped event types (re-run to retry): ${skippedTypes.join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
