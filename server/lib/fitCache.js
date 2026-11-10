// Job facts for the fit score (what each posting asks for), worked out once per job and kept in
// memory. A posting's text only changes when the job row is updated, so the key includes
// updated_at. Shared by every person: the per-person part of the score is cheap.

import { query } from '../db/pool.js';
import { jobFacts } from './fit.js';

const MAX_ENTRIES = 5_000;
const cache = new Map(); // `${id}:${updated_at ms}` -> facts, oldest first

const keyOf = (job) => `${job.id}:${new Date(job.updated_at || 0).getTime()}`;

function remember(key, facts) {
  cache.delete(key);
  cache.set(key, facts);
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
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
    for (let i = 0; i < todo.length; i += 500) {
      const ids = todo.slice(i, i + 500).map((r) => r.id);
      for (const d of await query('SELECT id, description FROM jobs WHERE id IN (?)', [ids])) descriptions.set(d.id, d.description);
    }
    for (const row of todo) {
      const facts = jobFacts({ ...row, description: descriptions.get(row.id) || '' });
      remember(keyOf(row), facts);
      out.set(row.id, facts);
    }
  }
  return out;
}

export const fitCacheSize = () => cache.size;
export const clearFitCache = () => cache.clear();
