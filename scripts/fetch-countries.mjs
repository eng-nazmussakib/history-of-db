#!/usr/bin/env node
// Builds seeds/001_countries.sql from Wikidata (CC0).
//
//   node scripts/fetch-countries.mjs
//
// Pulls every current sovereign state (instance of Q3624078 with no dissolution
// date): 193 UN members plus Palestine, Vatican City, Kosovo and Taiwan.
// The generated SQL is committed, so seeding never needs network access.
// Re-run this script only when you want to refresh the list.

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../seeds/001_countries.sql', import.meta.url));
const ENDPOINT = 'https://query.wikidata.org/sparql';

const QUERY = `
SELECT ?item ?name ?desc ?iso2 ?iso3
       (SAMPLE(?capLabel) AS ?capital)
       (GROUP_CONCAT(DISTINCT ?alias; separator="|") AS ?aliases)
WHERE {
  ?item wdt:P31 wd:Q3624078 .
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }
  ?item rdfs:label ?name FILTER(LANG(?name) = "en")
  OPTIONAL { ?item schema:description ?desc FILTER(LANG(?desc) = "en") }
  OPTIONAL { ?item wdt:P297 ?iso2 }
  OPTIONAL { ?item wdt:P298 ?iso3 }
  OPTIONAL { ?item wdt:P36 ?cap . ?cap rdfs:label ?capLabel FILTER(LANG(?capLabel) = "en") }
  OPTIONAL { ?item skos:altLabel ?alias FILTER(LANG(?alias) = "en") }
}
GROUP BY ?item ?name ?desc ?iso2 ?iso3
`;

// Wikidata models a few states as their wider "Kingdom of …". Use the country
// itself, and prefer the everyday English name.
const OVERRIDES = {
  Q756617: { qid: 'Q35', name: 'Denmark', iso2: 'DK', iso3: 'DNK', desc: 'country in Northern Europe' },
  Q29999: { qid: 'Q55', name: 'Netherlands', desc: 'country in Northwestern Europe', addAliases: ['Holland'] },
  Q148: { name: 'China', addAliases: ["People's Republic of China", 'PRC'] },
  Q778: { name: 'Bahamas', addAliases: ['The Bahamas'] },
  Q1005: { name: 'Gambia', addAliases: ['The Gambia'] },
  Q30: { addAliases: ['USA', 'United States of America'] },
  Q145: { addAliases: ['UK', 'Britain', 'Great Britain'] },
};

// Countries left out of the seed on purpose (Wikidata QIDs). Israel (Q801) is
// excluded at the project owner's request. Removing a country here also removes
// it from the events seed, because fetch-country-events.mjs reads this list.
const EXCLUDE = new Set(['Q801']);

// Slang, spaced-out abbreviations and fragments left after stripping "the".
const ALIAS_BLOCKLIST = /^'?(murica|merica)$|\bof a$|^(states|g b|u k|u\. s\.( a\.)?)$/i;
const MAX_ALIASES = 8;

function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cleanAliases(raw, name, extra = []) {
  const seen = new Set([name.toLowerCase()]);
  const out = [];
  for (let alias of [...extra, ...raw]) {
    alias = alias.trim().replace(/^the\s+/i, '');
    const key = alias.toLowerCase();
    if (alias.length < 3 && !extra.includes(alias)) continue; // drop 'cn', 'US' style codes
    if (alias === alias.toLowerCase() && alias.length <= 3) continue;
    if (/^['’]/.test(alias) || ALIAS_BLOCKLIST.test(alias)) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(alias);
    if (out.length >= MAX_ALIASES) break;
  }
  return out;
}

const sql = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sqlArray = (arr) => `ARRAY[${arr.map(sql).join(', ')}]::text[]`;
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

async function main() {
  const res = await fetch(`${ENDPOINT}?query=${encodeURIComponent(QUERY)}`, {
    headers: {
      Accept: 'application/sparql-results+json',
      'User-Agent': 'HistoryOf/0.1 (seed script)',
    },
  });
  if (!res.ok) throw new Error(`Wikidata responded ${res.status}`);
  const rows = (await res.json()).results.bindings;

  const countries = rows
    .filter((r) => !EXCLUDE.has(r.item.value.split('/').pop()))
    .map((r) => {
      const wdQid = r.item.value.split('/').pop();
      const o = OVERRIDES[wdQid] ?? {};
      const name = o.name ?? r.name.value;
      return {
        qid: o.qid ?? wdQid,
        name,
        slug: slugify(name),
        description: capitalize(o.desc ?? r.desc?.value ?? null),
        aliases: cleanAliases(r.aliases?.value ? r.aliases.value.split('|') : [], name, o.addAliases),
        metadata: {
          iso_alpha2: o.iso2 ?? r.iso2?.value ?? null,
          iso_alpha3: o.iso3 ?? r.iso3?.value ?? null,
          capital: r.capital?.value ?? null,
        },
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));

  const slugs = new Set(countries.map((c) => c.slug));
  if (slugs.size !== countries.length) throw new Error('Duplicate slugs in country list');

  const values = countries
    .map(
      (c) =>
        `  (${sql(c.slug)}, ${sql(c.name)}, ${sql(c.description)}, ${sqlArray(c.aliases)}, ` +
        `${sql(c.qid)}, ${sql(JSON.stringify(c.metadata))}::jsonb)`,
    )
    .join(',\n');

  const out = `-- 001_countries.sql
-- GENERATED by scripts/fetch-countries.mjs on ${new Date().toISOString().slice(0, 10)}. Do not edit by hand.
-- Source: Wikidata (CC0). ${countries.length} current sovereign states${EXCLUDE.size ? ` (${EXCLUDE.size} excluded, see EXCLUDE in the script)` : ""}.
-- Safe to re-run: existing rows are refreshed, hand-written descriptions and years are kept.

INSERT INTO terms (slug, name, type, description, aliases, wikidata_id, metadata, crawl_priority)
SELECT slug, name, 'country', description, aliases, wikidata_id, metadata, 10
FROM (VALUES
${values}
) AS v(slug, name, description, aliases, wikidata_id, metadata)
ON CONFLICT (slug) DO UPDATE SET
  name        = EXCLUDED.name,
  type        = EXCLUDED.type,
  wikidata_id = EXCLUDED.wikidata_id,
  metadata    = terms.metadata || EXCLUDED.metadata,
  aliases     = ARRAY(SELECT DISTINCT unnest(terms.aliases || EXCLUDED.aliases)),
  description = coalesce(terms.description, EXCLUDED.description);
`;

  await writeFile(OUT, out);
  console.log(`Wrote ${countries.length} countries to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
