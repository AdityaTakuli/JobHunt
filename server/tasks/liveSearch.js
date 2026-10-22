// A search typed on the Jobs page: runs it (in that place) on Google Jobs through SerpApi, stores
// the results like any other fetch, and returns their ids in Google's order for the feed.
// What she typed is tidied first (lib/searchQuery.js: spelling, short forms, a city in the text,
// "architecture" added to a bare keyword); exact=true searches her words as they are.
// Guarded like the scheduled fetch: a repeat within CACHE_HOURS reuses the stored results, and
// typed searches stop at a daily limit and before the monthly reserve kept for scheduled fetches.

import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';
import { createClassifier } from '../lib/classify.js';
import { ingestJobs, prepareJobs } from '../lib/ingest.js';
import { cleanText, normalizeCity } from '../lib/normalize.js';
import { understandSearch } from '../lib/searchQuery.js';
import { classifierContext, getSettings, saveSettings } from '../lib/settings.js';
import { startOfIstDay } from '../lib/time.js';
import { getAccount, searchGoogleJobs, SOURCE } from '../sources/serpapi.js';
import { localSearchesThisMonth, locationFor, searchText } from './fetchJobs.js';

export const CACHE_HOURS = 6;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Searches that spent a SerpApi search today, per person (repeats answered from saved results
// don't count).
export async function typedSearchesToday(userId, now = new Date()) {
  const [row] = await query('SELECT COUNT(*) AS n FROM searches WHERE user_id = ? AND cached = 0 AND searched_at >= ?', [userId, startOfIstDay(now)]);
  return Number(row.n);
}

// Keeps a search in her history. A repeat within the cache window reuses the row she has.
async function remember(userId, { text, place, ids, found, cached, now }) {
  const [mine] = await query(
    'SELECT id FROM searches WHERE user_id = ? AND query = ? AND location = ? AND searched_at >= ? ORDER BY searched_at DESC LIMIT 1',
    [userId, text, place, new Date(now.getTime() - CACHE_HOURS * 3_600_000)],
  );
  if (mine && cached) {
    await query('UPDATE searches SET hidden = 0 WHERE id = ?', [mine.id]);
    return;
  }
  await query('INSERT INTO searches SET ?', [
    { user_id: userId, query: text, location: place, searched_at: now, job_ids: JSON.stringify(ids), found, cached: cached ? 1 : 0 },
  ]);
}

export async function liveSearch({ q, location = '', exact = false, userId = 1, fetchImpl = fetch, now = new Date() }) {
  const { serpapi } = config;
  if (cleanText(q).length < 2) throw fail(400, 'Type a role or keyword to search for.');
  let text;
  let place;
  let adjusted = false;
  if (exact) {
    text = cleanText(q, 120);
    // "begaluru" and "Bangalore" both mean Bengaluru, for the search and for the saved-results cache.
    place = cleanText(location, 80);
    place = (place && normalizeCity(place)) || place;
  } else {
    ({ query: text, place, adjusted } = understandSearch(q, location));
  }
  const about = { searched: text, place, adjusted };

  // Saved results are shared: the same search by anyone in the last few hours costs nothing.
  const [cached] = await query(
    'SELECT job_ids, found, searched_at FROM searches WHERE query = ? AND location = ? AND cached = 0 AND searched_at >= ? ORDER BY searched_at DESC LIMIT 1',
    [text, place, new Date(now.getTime() - CACHE_HOURS * 3_600_000)],
  );
  if (cached) {
    const ids = parseJson(cached.job_ids, []);
    await remember(userId, { text, place, ids, found: cached.found, cached: true, now });
    return { ids, found: cached.found, new: 0, cached: true, searchedAt: cached.searched_at, ...about };
  }

  if (!serpapi.apiKey) throw fail(503, 'Google search is not set up (SERPAPI_KEY is missing on the server).');
  if ((await typedSearchesToday(userId, now)) >= serpapi.manualDailyLimit) {
    throw fail(429, `That's today's ${serpapi.manualDailyLimit} searches. New ones reset at midnight; the jobs already found are still here.`);
  }

  let searchesLeft;
  try {
    const account = await getAccount({ apiKey: serpapi.apiKey, fetchImpl });
    searchesLeft = account.searchesLeft ?? serpapi.monthlyLimit - account.thisMonthUsage;
  } catch {
    searchesLeft = serpapi.monthlyLimit - (await localSearchesThisMonth(now));
  }
  if (searchesLeft <= serpapi.reserve) {
    throw fail(429, `Only ${Math.max(0, searchesLeft)} searches are left this month, and they're kept for the automatic fetch.`);
  }

  const settings = await getSettings();
  const context = await classifierContext();
  const locations = { ...settings.serp_locations };
  const loc = await locationFor(place, locations, fetchImpl);
  // A place Google does not know (or "Remote") goes into the query text instead.
  const searchFor = place && !loc ? searchText({ query: text, city: place }) : text;

  let found;
  try {
    found = await searchGoogleJobs(searchFor, { apiKey: serpapi.apiKey, location: loc?.location, gl: loc?.gl, fetchImpl, now });
  } catch (err) {
    await query('INSERT INTO fetch_log SET ?', [{ source: SOURCE, run_at: now, requests_used: 1, error: `Search "${searchFor}": ${err.message}`.slice(0, 2000) }]);
    throw fail(502, `Google Jobs search failed: ${err.message}`);
  }
  await saveSettings({ serp_locations: locations });

  // Keyword rules label results straight away so they show in seconds; the AI re-label that runs
  // right after (retry-classify) upgrades them within the token budget.
  const classifier = createClassifier({ freellm: null, groq: null, gemini: null, ...context });
  const result = await ingestJobs(found, { classifier, linkChecker: null, now });
  const keys = prepareJobs(found).map((j) => j.key);
  const rows = keys.length ? await query('SELECT id, dedupe_key FROM jobs WHERE dedupe_key IN (?)', [keys]) : [];
  const idByKey = new Map(rows.map((r) => [r.dedupe_key, r.id]));
  const ids = keys.map((k) => idByKey.get(k)).filter(Boolean);

  await query('INSERT INTO fetch_log SET ?', [{ source: SOURCE, run_at: now, jobs_found: found.length, jobs_new: result.new, requests_used: 1 }]);
  await remember(userId, { text, place, ids, found: found.length, cached: false, now });
  return { ids, found: found.length, new: result.new, cached: false, searchesLeft: searchesLeft - 1, ...about };
}
