// Job facts for the fit score (what each posting asks for), worked out once per job and kept in
// memory. A posting's text only changes when the job row is updated, so the key includes
// updated_at; a new AI analysis (which says what is a must-have) drops the job with forgetJob.
// Shared by every person: the per-person part of the score is cheap.
//
// Every place that shows a fit score (the card, the details, the best-fit sort) goes through here,
// so one job has one score. They used to differ: the details counted the analysis, the card did not.

import { parseJson, query } from '../db/pool.js';
import { jobFacts } from './fit.js';

const MAX_ENTRIES = 5_000;
const cache = new Map(); // `${id}:${updated_at ms}` -> facts, oldest first
const keysById = new Map(); // id -> its cache key

const keyOf = (job) => `${job.id}:${new Date(job.updated_at || 0).getTime()}`;

function remember(id, key, facts) {
  const old = keysById.get(id);
  if (old && old !== key) cache.delete(old);
  cache.delete(key);
  cache.set(key, facts);
  keysById.set(id, key);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
    keysById.delete(Number(oldest.split(':')[0]));
  }
}

// After a job's AI analysis is written or rewritten.
export function forgetJob(id) {
  const key = keysById.get(Number(id));
  if (key) cache.delete(key);
  keysById.delete(Number(id));
}

/**
 * Facts for each job in `rows` (which need id, updated_at, title, software). Descriptions are
 * loaded from the database only for jobs not cached yet.
 * @returns Map job id -> facts
 */
export async function factsFor(rows) {
  const out = new Map();
  const todo = [];
  for (const row of rows) {
    const hit = cache.get(keyOf(row));
    if (hit) out.set(row.id, hit);
    else todo.push(row);
  }
  if (todo.length) {
    const descriptions = new Map();
    const analyses = new Map();
    for (let i = 0; i < todo.length; i += 500) {
      const ids = todo.slice(i, i + 500).map((r) => r.id);
      const [texts, stored] = await Promise.all([
        query('SELECT id, description FROM jobs WHERE id IN (?)', [ids]),
        query('SELECT job_id, analysis FROM job_analyses WHERE job_id IN (?)', [ids]),
      ]);
      for (const d of texts) descriptions.set(d.id, d.description);
      for (const a of stored) analyses.set(a.job_id, parseJson(a.analysis, null));
    }
    for (const row of todo) {
      const facts = jobFacts({ ...row, description: descriptions.get(row.id) || '' }, analyses.get(row.id) || null);
      remember(row.id, keyOf(row), facts);
      out.set(row.id, facts);
    }
  }
  return out;
}

export const fitCacheSize = () => cache.size;
export function clearFitCache() {
  cache.clear();
  keysById.clear();
}
