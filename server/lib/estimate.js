// "Market estimate" for jobs without a posted stipend: the middle 50% of stipends/salaries that
// were actually posted for the same role type, from our own jobs table. Shown clearly labeled.

import { query } from '../db/pool.js';

const MIN_SAMPLES = 5;
const CACHE_MS = 10 * 60_000;
let cache = { at: 0, value: null };

function percentile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

const round = (n, step) => Math.max(step, Math.round(n / step) * step);

// rows: [{ role_type, salary_min, salary_max, salary_period }] -> { internship: {...}, fresher: {...} }
export function computeEstimates(rows) {
  const monthly = {};
  for (const r of rows) {
    if (!r.role_type || !r.salary_min) continue;
    const mid = (Number(r.salary_min) + Number(r.salary_max || r.salary_min)) / 2;
    const perMonth = r.salary_period === 'year' ? mid / 12 : r.salary_period === 'month' ? mid : null;
    if (!perMonth || perMonth < 1000) continue;
    (monthly[r.role_type] ||= []).push(perMonth);
  }
  const out = {};
  for (const [role, values] of Object.entries(monthly)) {
    if (values.length < MIN_SAMPLES) continue;
    values.sort((a, b) => a - b);
    const lo = percentile(values, 0.25);
    const hi = percentile(values, 0.75);
    out[role] =
      role === 'internship'
        ? { min: round(lo, 1000), max: round(hi, 1000), period: 'month', samples: values.length }
        : { min: round(lo * 12, 10_000), max: round(hi * 12, 10_000), period: 'year', samples: values.length };
  }
  return out;
}

export async function getEstimates(now = Date.now()) {
  if (cache.value && now - cache.at < CACHE_MS) return cache.value;
  const rows = await query(
    `SELECT role_type, salary_min, salary_max, salary_period FROM jobs
      WHERE salary_min IS NOT NULL AND salary_is_estimate = 0 AND is_relevant = 1
        AND created_at > ? AND salary_period IN ('month', 'year')`,
    [new Date(now - 180 * 86_400_000)],
  );
  cache = { at: now, value: computeEstimates(rows) };
  return cache.value;
}
