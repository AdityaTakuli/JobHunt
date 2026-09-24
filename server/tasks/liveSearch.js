// A search typed on the Jobs page: runs exactly that query (in that place) on Google Jobs through
// SerpApi, stores the results like any other fetch, and returns their ids for the feed.
// Guarded like the scheduled fetch: a repeat within CACHE_HOURS reuses the stored results, and
// typed searches stop at a daily limit and before the monthly reserve kept for scheduled fetches.

import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';
import { createClassifier } from '../lib/classify.js';
import { ingestJobs, prepareJobs } from '../lib/ingest.js';
import { cleanText } from '../lib/normalize.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { startOfIstDay } from '../lib/time.js';
import { getAccount, searchGoogleJobs, SOURCE } from '../sources/serpapi.js';
import { localSearchesThisMonth, locationFor, searchText } from './fetchJobs.js';

export const CACHE_HOURS = 6;

const fail = (status, message) => Object.assign(new Error(message), { status });

export async function typedSearchesToday(now = new Date()) {
  const [row] = await query('SELECT COUNT(*) AS n FROM searches WHERE searched_at >= ?', [startOfIstDay(now)]);
  return Number(row.n);
}

export async function liveSearch({ q, location = '', fetchImpl = fetch, now = new Date() }) {
  const { serpapi } = config;
  const text = cleanText(q, 120);
  const place = cleanText(location, 80);
  if (text.length < 2) throw fail(400, 'Type a role or keyword to search for.');

  const [cached] = await query(
    'SELECT job_ids, found, searched_at FROM searches WHERE query = ? AND location = ? AND searched_at >= ? ORDER BY searched_at DESC LIMIT 1',
    [text, place, new Date(now.getTime() - CACHE_HOURS * 3_600_000)],
  );
  if (cached) return { ids: parseJson(cached.job_ids, []), found: cached.found, new: 0, cached: true, searchedAt: cached.searched_at };

  if (!serpapi.apiKey) throw fail(503, 'Google search is not set up (SERPAPI_KEY is missing on the server).');
  if ((await typedSearchesToday(now)) >= serpapi.manualDailyLimit) {
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
  const classifier = createClassifier({ groq: null, gemini: null, extraExclude: settings.extra_exclude_keywords, cities: settings.cities });
  const result = await ingestJobs(found, { classifier, linkChecker: null, now });
  const keys = prepareJobs(found).map((j) => j.key);
  const ids = keys.length ? (await query('SELECT id FROM jobs WHERE dedupe_key IN (?)', [keys])).map((r) => r.id) : [];

  await query('INSERT INTO fetch_log SET ?', [{ source: SOURCE, run_at: now, jobs_found: found.length, jobs_new: result.new, requests_used: 1 }]);
  await query('INSERT INTO searches SET ?', [{ query: text, location: place, searched_at: now, job_ids: JSON.stringify(ids), found: found.length }]);
  return { ids, found: found.length, new: result.new, cached: false, searchesLeft: searchesLeft - 1 };
}
