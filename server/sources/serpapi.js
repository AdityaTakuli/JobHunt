// SerpApi Google Jobs engine: Google Jobs results, which include LinkedIn, Naukri, Indeed and
// company career-page listings. One search = one request from the monthly quota.
// Docs: https://serpapi.com/google-jobs-api

import { cleanText, applyRank, APPLY_RANK, isHttpUrl, normalizeCity } from '../lib/normalize.js';
import { parseSalary } from '../lib/salary.js';

const SEARCH_URL = 'https://serpapi.com/search.json';
const ACCOUNT_URL = 'https://serpapi.com/account.json';
export const SOURCE = 'google_jobs';

// Apply links on these hosts are job boards, not the firm's own careers page.
const JOB_BOARDS = [
  'linkedin.com', 'naukri.com', 'indeed.com', 'glassdoor.co.in', 'glassdoor.com', 'foundit.in', 'monsterindia.com',
  'shine.com', 'internshala.com', 'apna.co', 'timesjobs.com', 'instahyre.com', 'cutshort.io', 'hirist.tech',
  'wellfound.com', 'ziprecruiter.com', 'jooble.org', 'talent.com', 'simplyhired.co.in', 'simplyhired.com',
  'bebee.com', 'jobrapido.com', 'careerjet.co.in', 'whatjobs.com', 'adzuna.in', 'teamlease.com', 'workindia.in',
  'freshersworld.com', 'unstop.com', 'google.com', 'google.co.in', 'expertini.com', 'jobleads.com', 'learn4good.com',
  'recruit.net', 'trabajo.org', 'jobsora.com', 'archinect.com', 'dezeen.com', 'bebee.in', 'quikr.com', 'jobaaj.com',
];

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function isJobBoard(url) {
  const host = hostOf(url);
  return JOB_BOARDS.some((board) => host === board || host.endsWith(`.${board}`));
}

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

// Picks the best apply option: the firm's own site, then LinkedIn, then any job board.
export function pickApplyLink(options, fallback) {
  const candidates = (options || [])
    .filter((o) => isHttpUrl(o?.link))
    .map((o) => ({
      url: o.link,
      publisher: cleanText(o.title),
      rank: isJobBoard(o.link) ? applyRank(o.link) : APPLY_RANK.direct,
    }));
  if (!candidates.length && isHttpUrl(fallback)) {
    candidates.push({ url: fallback, publisher: 'Google Jobs', rank: APPLY_RANK.other });
  }
  candidates.sort((a, b) => b.rank - a.rank);
  return candidates[0] || null;
}

export function normalizeSerpJob(job, now = new Date()) {
  const title = cleanText(job.title, 300);
  const apply = pickApplyLink(job.apply_options, job.share_link);
  if (!title || !apply) return null;

  const ext = job.detected_extensions || {};
  let description = String(job.description || '').trim();
  if (!description && Array.isArray(job.job_highlights)) {
    description = job.job_highlights
      .map((h) => [h.title, ...(h.items || []).map((i) => `• ${i}`)].filter(Boolean).join('\n'))
      .join('\n\n');
  }
  const salaryText = ext.salary ? cleanText(ext.salary, 200) : '';
  const parsed = salaryText ? parseSalary(salaryText) : null;
  const locationText = cleanText(job.location, 200) || (ext.work_from_home ? 'Remote' : '');
  const via = cleanText(job.via).replace(/^via\s+/i, '');

  return {
    source: SOURCE,
    title,
    company: cleanText(job.company_name, 200),
    locationText,
    city: normalizeCity(locationText),
    description,
    applyUrl: apply.url,
    applyRank: apply.rank,
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

export async function searchGoogleJobs(query, { apiKey, location, fetchImpl = fetch, timeoutMs = 30_000, now = new Date() }) {
  const params = new URLSearchParams({ engine: 'google_jobs', q: query, gl: 'in', hl: 'en', api_key: apiKey });
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
