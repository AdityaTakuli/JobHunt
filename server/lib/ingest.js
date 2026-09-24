// Normalize + dedupe + classify + store. Every source hands its jobs to ingestJobs() in the
// same shape: { source, title, company, locationText, city, description, applyUrl, applyRank,
// postedAt, salary: { text, min, max, period } | null, publisher }.

import { parseJson, query } from '../db/pool.js';
import { labelsToColumns } from './classify.js';
import { checkLink, mapLimit } from './linkCheck.js';
import { cleanText, dedupeKey, isHttpUrl, normalizeCity } from './normalize.js';

const earliest = (a, b) => (!a ? b : !b ? a : a < b ? a : b);

function mergeSources(a, b) {
  const out = [...a];
  for (const s of b) {
    if (!out.some((o) => o.source === s.source && o.url === s.url)) out.push(s);
  }
  return out.slice(0, 12);
}

function mergeCandidates(a, b) {
  const better = b.applyRank > a.applyRank ? b : a;
  return {
    ...a,
    applyUrl: better.applyUrl,
    applyRank: better.applyRank,
    description: (b.description?.length || 0) > (a.description?.length || 0) ? b.description : a.description,
    salary: a.salary || b.salary,
    postedAt: earliest(a.postedAt, b.postedAt),
    locationText: a.locationText || b.locationText,
    sources: mergeSources(a.sources, b.sources),
  };
}

// Dedupe within the batch: one candidate per company + title + city.
export function prepareJobs(rawJobs) {
  const byKey = new Map();
  for (const raw of rawJobs) {
    if (!raw?.title || !isHttpUrl(raw.applyUrl)) continue;
    const city = raw.city ?? normalizeCity(raw.locationText);
    const job = {
      ...raw,
      title: cleanText(raw.title, 300),
      company: cleanText(raw.company, 200),
      city,
      key: dedupeKey({ company: raw.company, title: raw.title, city }),
      sources: [{ source: raw.source, publisher: raw.publisher || null, url: raw.applyUrl }],
    };
    const existing = byKey.get(job.key);
    byKey.set(job.key, existing ? mergeCandidates(existing, job) : job);
  }
  return [...byKey.values()];
}

// Rupee amounts outside this range are parse noise, not pay.
const plausible = (n) => (Number.isFinite(n) && n > 0 && n < 100_000_000 ? Math.round(n) : null);

function salaryColumns(salary) {
  return {
    salary_text: salary?.text?.slice(0, 200) || null,
    salary_min: plausible(salary?.min),
    salary_max: plausible(salary?.max),
    salary_period: salary?.period ?? null,
    salary_is_estimate: 0,
  };
}

async function mergeIntoExisting(row, job, now) {
  const oldSources = parseJson(row.sources, []);
  const sources = mergeSources(oldSources, job.sources);
  const updates = {};
  if (sources.length !== oldSources.length) updates.sources = JSON.stringify(sources);
  if (job.applyRank > row.apply_url_rank) {
    updates.apply_url = job.applyUrl;
    updates.apply_url_rank = job.applyRank;
    updates.link_status = 'unknown';
  }
  if ((job.description?.length || 0) > (row.description?.length || 0)) updates.description = job.description;
  if (!row.salary_text && job.salary?.text) Object.assign(updates, salaryColumns(job.salary));
  if (job.postedAt && (!row.posted_at || job.postedAt < row.posted_at)) updates.posted_at = job.postedAt;
  if (!row.location_text && job.locationText) updates.location_text = job.locationText;
  if (!Object.keys(updates).length) return false;
  updates.updated_at = now;
  await query('UPDATE jobs SET ? WHERE id = ?', [updates, row.id]);
  return true;
}

/**
 * @param rawJobs jobs from any source
 * @param options.classifier from createClassifier()
 * @param options.linkChecker (url) => 'ok' | 'broken' | 'unknown'; pass null to skip checks
 */
export async function ingestJobs(rawJobs, { classifier, linkChecker = checkLink, now = new Date() }) {
  const prepared = prepareJobs(rawJobs);
  const result = { found: rawJobs.length, unique: prepared.length, new: 0, updated: 0, newIds: [], errors: [] };
  if (!prepared.length) return result;

  const rows = await query(
    `SELECT id, dedupe_key, sources, apply_url, apply_url_rank, description, salary_text, posted_at, location_text
       FROM jobs WHERE dedupe_key IN (?)`,
    [prepared.map((j) => j.key)],
  );
  const existing = new Map(rows.map((r) => [r.dedupe_key, r]));

  const fresh = [];
  for (const job of prepared) {
    const row = existing.get(job.key);
    if (row) {
      if (await mergeIntoExisting(row, job, now)) result.updated += 1;
    } else {
      fresh.push(job);
    }
  }

  const linkStatuses = linkChecker
    ? await mapLimit(fresh, 4, (job) => linkChecker(job.applyUrl))
    : fresh.map(() => 'unknown');

  for (const [i, job] of fresh.entries()) {
    const base = {
      title: job.title,
      company: job.company,
      city: job.city,
      location_text: job.locationText || null,
      description: job.description || null,
      salary_text: job.salary?.text || null,
    };
    const { labels, classifier: by } = await classifier.classify(base);
    const row = {
      dedupe_key: job.key,
      ...base,
      apply_url: job.applyUrl.slice(0, 1000),
      apply_url_rank: job.applyRank,
      link_status: linkStatuses[i],
      sources: JSON.stringify(job.sources),
      posted_at: job.postedAt || null,
      ...salaryColumns(job.salary),
      ...labelsToColumns(labels, by, base),
      classified_at: now,
      created_at: now,
      updated_at: now,
    };
    try {
      const res = await query('INSERT INTO jobs SET ?', [row]);
      result.new += 1;
      result.newIds.push(res.insertId);
    } catch (err) {
      // Another run inserted the same job a moment ago.
      if (err.code === 'ER_DUP_ENTRY') result.updated += 1;
      // One bad row must not stop the rest of the batch.
      else if (err.sqlState) result.errors.push(`"${job.title}": ${err.message}`);
      else throw err;
    }
  }
  if (!result.errors.length) delete result.errors;
  return result;
}
