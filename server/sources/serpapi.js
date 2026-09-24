// SerpApi Google Jobs engine: Google Jobs results, which include LinkedIn, Naukri, Indeed and
// company career-page listings. One search = one request from the monthly quota.
// Docs: https://serpapi.com/google-jobs-api

import { APPLY_RANK, cleanText, isHttpUrl, normalizeCity, rankApplyOptions, repairCompany } from '../lib/normalize.js';

export { isJobBoard } from '../lib/normalize.js';
import { parseSalary } from '../lib/salary.js';

const SEARCH_URL = 'https://serpapi.com/search.json';
const ACCOUNT_URL = 'https://serpapi.com/account.json';
const LOCATIONS_URL = 'https://serpapi.com/locations.json';
export const SOURCE = 'google_jobs';

// "3 days ago", "20 hours ago", "30+ days ago", "Just posted" -> Date
export function parsePostedAt(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/just (now|posted)|today|moments? ago/.test(t)) return new Date(now);
  if (/yesterday/.test(t)) return new Date(now.getTime() - 86_400_000);
  const m = t.match(/(\d+)\+?\s*(minute|min|hour|hr|day|week|month)s?\s+ago/);
  if (!m) return null;
  const unitMs = { minute: 60_000, min: 60_000, hour: 3_600_000, hr: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 };
  return new Date(now.getTime() - Number(m[1]) * unitMs[m[2]]);
}

// Every apply option Google lists, best first: the firm's own site, LinkedIn, job boards, other
// sites, reposting sites. Google's own share link is the last resort.
export function applyOptionsFor(options, fallback, company = '') {
  const list = rankApplyOptions(
    (options || []).map((o) => ({ url: o?.link, publisher: o?.title })),
    company,
  );
  if (!list.length && isHttpUrl(fallback)) list.push({ url: fallback, publisher: 'Google Jobs', kind: 'aggregator', rank: APPLY_RANK.aggregator });
  return list;
}

export function pickApplyLink(options, fallback, company) {
  return applyOptionsFor(options, fallback, company)[0] || null;
}

export function normalizeSerpJob(job, now = new Date()) {
  const title = cleanText(job.title, 300);
  if (!title) return null;

  const ext = job.detected_extensions || {};
  let description = String(job.description || '').trim();
  if (!description && Array.isArray(job.job_highlights)) {
    description = job.job_highlights
      .map((h) => [h.title, ...(h.items || []).map((i) => `• ${i}`)].filter(Boolean).join('\n'))
      .join('\n\n');
  }
  const company = repairCompany(cleanText(job.company_name, 200), `${title}\n${description}`);
  const applyOptions = applyOptionsFor(job.apply_options, job.share_link, company);
  const apply = applyOptions[0];
  if (!apply) return null;
  const salaryText = ext.salary ? cleanText(ext.salary, 200) : '';
  const parsed = salaryText ? parseSalary(salaryText) : null;
  const locationText = cleanText(job.location, 200) || (ext.work_from_home ? 'Remote' : '');
  const via = cleanText(job.via).replace(/^via\s+/i, '');

  return {
    source: SOURCE,
    title,
    company,
    locationText,
    city: normalizeCity(locationText),
    description,
    applyUrl: apply.url,
    applyRank: apply.rank,
    applyKind: apply.kind,
    applyOptions,
    postedAt: parsePostedAt(ext.posted_at, now),
    salary: salaryText ? { text: salaryText, min: parsed?.min ?? null, max: parsed?.max ?? null, period: parsed?.period ?? null } : null,
    publisher: apply.publisher || via || 'Google Jobs',
  };
}

async function getJson(url, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  return { res, data };
}

export async function searchGoogleJobs(query, { apiKey, location, gl = 'in', fetchImpl = fetch, timeoutMs = 30_000, now = new Date() }) {
  const params = new URLSearchParams({ engine: 'google_jobs', q: query, gl, hl: 'en', api_key: apiKey });
  if (location) params.set('location', location);
  const { res, data } = await getJson(`${SEARCH_URL}?${params}`, fetchImpl, timeoutMs);
  if (data?.error) {
    // An empty result page still uses a search but is not a failure.
    if (/hasn.t returned any results/i.test(data.error)) return [];
    throw new Error(`SerpApi: ${data.error}`);
  }
  if (!res.ok || !data) throw new Error(`SerpApi HTTP ${res.status}`);
  return (data.jobs_results || []).map((j) => normalizeSerpJob(j, now)).filter(Boolean);
}

// Turns a city typed on the Settings screen ("Mumbai", "Dubai") into SerpApi's canonical
// location and Google country code. Free, needs no key and is not counted toward the quota.
// Indian matches win, so "Kochi" is Kerala, not Japan. Returns null when nothing matches.
export async function resolveLocation(city, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const { res, data } = await getJson(`${LOCATIONS_URL}?${new URLSearchParams({ q: city, limit: '10' })}`, fetchImpl, timeoutMs);
  if (!res.ok || !Array.isArray(data)) throw new Error(`SerpApi locations: HTTP ${res.status}`);
  if (!data.length) return null;
  const best = data.find((l) => l.country_code === 'IN') || data[0];
  return { location: best.canonical_name, gl: String(best.country_code || 'in').toLowerCase() };
}

// Free and not counted toward the quota.
export async function getAccount({ apiKey, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const { res, data } = await getJson(`${ACCOUNT_URL}?${new URLSearchParams({ api_key: apiKey })}`, fetchImpl, timeoutMs);
  if (!res.ok || !data || data.error) throw new Error(`SerpApi account: ${data?.error || `HTTP ${res.status}`}`);
  return {
    searchesPerMonth: Number(data.searches_per_month) || null,
    searchesLeft: data.total_searches_left == null ? null : Number(data.total_searches_left),
    thisMonthUsage: Number(data.this_month_usage) || 0,
    renewalDate: data.plan_renewal_date || null,
  };
}
