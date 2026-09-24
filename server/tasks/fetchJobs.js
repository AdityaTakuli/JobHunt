// Runs at 07:00 and 18:00 IST: searches Google Jobs via SerpApi with a rotating subset of the
// saved queries x cities (both set on the Settings screen), stays inside the monthly quota, then
// archives stale jobs.

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { createClassifier } from '../lib/classify.js';
import { ingestJobs } from '../lib/ingest.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { daysLeftInIstMonth, startOfIstMonth } from '../lib/time.js';
import { getAccount, resolveLocation, searchGoogleJobs, SOURCE } from '../sources/serpapi.js';
import { archiveOldJobs } from './archive.js';

export async function localSearchesThisMonth(now = new Date()) {
  const [row] = await query('SELECT COALESCE(SUM(requests_used), 0) AS used FROM fetch_log WHERE source = ? AND run_at >= ?', [
    SOURCE,
    startOfIstMonth(now),
  ]);
  return Number(row.used);
}

// How many searches this run may use: spread what is left (minus a reserve) over the runs
// remaining this month, capped at queriesPerRun.
export function searchesForThisRun({ searchesLeft, reserve, queriesPerRun, runsPerDay, daysLeft }) {
  const available = searchesLeft - reserve;
  if (available <= 0) return 0;
  const runsLeft = Math.max(1, runsPerDay * daysLeft);
  return Math.min(queriesPerRun, Math.max(1, Math.floor(available / runsLeft)));
}

export function pickQueries(queries, startIndex, count) {
  if (!queries.length || count <= 0) return { picked: [], nextIndex: startIndex };
  const picked = [];
  for (let i = 0; i < Math.min(count, queries.length); i += 1) {
    picked.push(queries[(startIndex + i) % queries.length]);
  }
  return { picked, nextIndex: (startIndex + picked.length) % queries.length };
}

// Every query is searched in every city, one (query, city) pair per search. Pairs are ordered
// so consecutive searches alternate cities, and they rotate across runs, so adding a city shares
// the same quota instead of multiplying it. No cities = search without a location.
export function searchPairs(queries, cities) {
  if (!cities?.length) return queries.map((query) => ({ query, city: '' }));
  return queries.flatMap((query) => cities.map((city) => ({ query, city })));
}

// "BIM intern" + "Mumbai" -> "BIM intern Mumbai". Queries that already name a place are kept.
export function searchText({ query, city }) {
  if (!city || query.toLowerCase().includes(city.toLowerCase())) return query;
  return `${query} ${city === 'Remote' ? 'remote' : city}`;
}

// SerpApi location for a city, looked up once and cached in settings. A failed lookup is not
// cached; the search still runs with the city in the query text.
async function locationFor(city, cache, fetchImpl) {
  if (!city || city === 'Remote') return null;
  const key = city.toLowerCase();
  if (key in cache) return cache[key];
  try {
    cache[key] = await resolveLocation(city, { fetchImpl });
    return cache[key];
  } catch {
    return null;
  }
}

async function logRun(entry) {
  await query('INSERT INTO fetch_log SET ?', [{ run_at: new Date(), jobs_found: 0, jobs_new: 0, requests_used: 0, ...entry }]);
}

export async function fetchJobs({ fetchImpl = fetch, linkChecker, now = new Date() } = {}) {
  const { serpapi } = config;
  const summary = { source: SOURCE };

  if (!serpapi.apiKey) {
    summary.skipped = 'SERPAPI_KEY is not set';
  } else {
    const settings = await getSettings();

    // Quota: SerpApi's account endpoint is authoritative and free; fall back to our own log.
    let searchesLeft;
    try {
      const account = await getAccount({ apiKey: serpapi.apiKey, fetchImpl });
      searchesLeft = account.searchesLeft ?? serpapi.monthlyLimit - account.thisMonthUsage;
      summary.quotaFrom = 'serpapi';
    } catch (err) {
      searchesLeft = serpapi.monthlyLimit - (await localSearchesThisMonth(now));
      summary.quotaFrom = `local log (${err.message})`;
    }
    summary.searchesLeft = searchesLeft;

    const count = searchesForThisRun({
      searchesLeft,
      reserve: serpapi.reserve,
      queriesPerRun: serpapi.queriesPerRun,
      runsPerDay: serpapi.runsPerDay,
      daysLeft: daysLeftInIstMonth(now),
    });
    const pairs = searchPairs(settings.search_queries, settings.cities);
    const { picked, nextIndex } = pickQueries(pairs, settings.query_rotation_index, count);

    if (!picked.length) {
      summary.skipped = `Paused: ${searchesLeft} searches left (reserve ${serpapi.reserve})`;
      await logRun({ source: SOURCE, error: summary.skipped });
    } else {
      const jobs = [];
      const errors = [];
      const locations = { ...settings.serp_locations };
      let used = 0;
      for (const pair of picked) {
        const q = searchText(pair);
        const loc = await locationFor(pair.city, locations, fetchImpl);
        try {
          jobs.push(...(await searchGoogleJobs(q, { apiKey: serpapi.apiKey, location: loc?.location, gl: loc?.gl, fetchImpl, now })));
          used += 1;
        } catch (err) {
          errors.push(`"${q}": ${err.message}`);
        }
      }
      await saveSettings({ query_rotation_index: nextIndex, serp_locations: locations });

      const classifier = createClassifier({ extraExclude: settings.extra_exclude_keywords, cities: settings.cities, fetchImpl });
      const result = await ingestJobs(jobs, { classifier, ...(linkChecker !== undefined && { linkChecker }), now });
      Object.assign(summary, { queries: picked.map(searchText), requestsUsed: used, ...result, classifiedBy: classifier.stats });
      if (errors.length) summary.errors = errors;
      await logRun({
        source: SOURCE,
        jobs_found: result.found,
        jobs_new: result.new,
        requests_used: used,
        error: errors.length ? errors.join('\n').slice(0, 2000) : null,
      });
    }
  }

  summary.archived = await archiveOldJobs(now);
  return summary;
}
