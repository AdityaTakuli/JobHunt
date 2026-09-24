import { Router } from 'express';
import { parseJson, query } from '../db/pool.js';
import { getEstimates } from '../lib/estimate.js';
import { getSettings } from '../lib/settings.js';
import { DAY_MS, startOfIstDay } from '../lib/time.js';

export const jobsRouter = Router();

const LIST_COLUMNS = `j.id, j.title, j.company, j.city, j.location_text, j.apply_url, j.link_status, j.sources,
  j.posted_at, j.created_at, j.salary_text, j.salary_min, j.salary_max, j.salary_period, j.salary_is_estimate,
  j.role_type, j.is_bim, j.software, j.match_score, j.classifier, j.classify_reason, j.is_relevant, j.is_hidden,
  a.id AS application_id, a.status AS application_status`;

export function serializeJob(row, estimates = {}) {
  const job = {
    ...row,
    is_bim: Boolean(row.is_bim),
    is_relevant: Boolean(row.is_relevant),
    is_hidden: Boolean(row.is_hidden),
    salary_is_estimate: Boolean(row.salary_is_estimate),
    sources: parseJson(row.sources, []),
    software: parseJson(row.software, []),
  };
  if (!job.salary_text && !job.salary_min && estimates[job.role_type]) {
    job.salary_estimate = estimates[job.role_type];
  }
  return job;
}

const intParam = (v, fallback, { min = 0, max = Infinity } = {}) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// Builds the feed WHERE clause from query-string filters. city=mine means her chosen cities
// (Settings), plus remote jobs and jobs with no city.
export function feedFilters(q, now = new Date(), myCities = []) {
  const where = ['j.is_archived = 0', 'j.is_hidden = 0', 'j.is_relevant = 1'];
  const params = [];

  if (q.city === 'mine') {
    if (myCities.length) {
      where.push(`(j.city IN (?) OR j.city IN ('', 'Remote'))`);
      params.push(myCities);
    }
  } else if (q.city && q.city !== 'all') {
    where.push('j.city = ?');
    params.push(String(q.city));
  }
  if (['internship', 'fresher', 'experienced'].includes(q.role)) {
    where.push('j.role_type = ?');
    params.push(q.role);
  } else if (q.role !== 'all') {
    // Experienced roles are hidden by default.
    where.push("(j.role_type IS NULL OR j.role_type <> 'experienced')");
  }
  const software = String(q.software || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (software.length) {
    where.push(`(${software.map(() => 'JSON_CONTAINS(j.software, JSON_QUOTE(?))').join(' OR ')})`);
    params.push(...software);
  }
  const within = intParam(q.within, 0, { min: 0, max: 24 * 60 });
  if (within) {
    where.push('COALESCE(j.posted_at, j.created_at) >= ?');
    params.push(new Date(now.getTime() - within * 3_600_000));
  }
  if (q.source) {
    where.push("JSON_SEARCH(j.sources, 'one', ?, NULL, '$[*].source') IS NOT NULL");
    params.push(String(q.source));
  }
  if (q.bim === '1') where.push('j.is_bim = 1');
  if (q.hideApplied === '1') {
    where.push("(a.status IS NULL OR a.status = 'saved')");
  }
  if (q.q) {
    const like = `%${String(q.q).slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;
    where.push('(j.title LIKE ? OR j.company LIKE ?)');
    params.push(like, like);
  }
  return { where: where.join(' AND '), params };
}

jobsRouter.get('/', async (req, res) => {
  const myCities = req.query.city === 'mine' ? (await getSettings()).cities : [];
  const { where, params } = feedFilters(req.query, new Date(), myCities);
  const limit = intParam(req.query.limit, 50, { min: 1, max: 200 });
  const offset = intParam(req.query.offset, 0, { min: 0 });
  const [rows, [{ total }], estimates] = await Promise.all([
    query(
      `SELECT ${LIST_COLUMNS} FROM jobs j LEFT JOIN applications a ON a.job_id = j.id
        WHERE ${where}
        ORDER BY COALESCE(j.posted_at, j.created_at) DESC, j.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    query(`SELECT COUNT(*) AS total FROM jobs j LEFT JOIN applications a ON a.job_id = j.id WHERE ${where}`, params),
    getEstimates(),
  ]);
  res.json({ jobs: rows.map((r) => serializeJob(r, estimates)), total: Number(total), limit, offset });
});

// Filter options and the top-of-page counter.
jobsRouter.get('/meta', async (req, res) => {
  const now = new Date();
  const [cities, [counts], [followUps], settings] = await Promise.all([
    query(
      `SELECT city, COUNT(*) AS n FROM jobs
        WHERE is_archived = 0 AND is_hidden = 0 AND is_relevant = 1 AND city <> ''
        GROUP BY city ORDER BY n DESC LIMIT 30`,
    ),
    query(
      `SELECT SUM(created_at >= ?) AS new_today, COUNT(*) AS active FROM jobs
        WHERE is_archived = 0 AND is_hidden = 0 AND is_relevant = 1
          AND (role_type IS NULL OR role_type <> 'experienced')`,
      [startOfIstDay(now)],
    ),
    query(
      `SELECT COUNT(*) AS due FROM applications
        WHERE status IN ('applied', 'interview') AND follow_up_at IS NOT NULL AND follow_up_at <= ?`,
      [now],
    ),
    getSettings(),
  ]);
  res.json({
    cities: cities.map((c) => ({ city: c.city, count: Number(c.n) })),
    myCities: settings.cities,
    newToday: Number(counts.new_today || 0),
    activeJobs: Number(counts.active || 0),
    followUpsDue: Number(followUps.due || 0),
  });
});

// Hidden by her (with reason) and filtered out by the classifier, for tuning the rules.
jobsRouter.get('/review', async (req, res) => {
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [hidden, filtered] = await Promise.all([
    query(
      `SELECT id, title, company, city, apply_url, hide_reason, hidden_at FROM jobs
        WHERE is_hidden = 1 ORDER BY hidden_at DESC LIMIT 50`,
    ),
    query(
      `SELECT id, title, company, city, apply_url, classifier, classify_reason, created_at FROM jobs
        WHERE is_relevant = 0 AND is_hidden = 0 AND created_at >= ? ORDER BY created_at DESC LIMIT 50`,
      [since],
    ),
  ]);
  res.json({ hidden, filtered });
});

async function findJob(id) {
  const [row] = await query(
    `SELECT ${LIST_COLUMNS}, j.description, j.hide_reason FROM jobs j
       LEFT JOIN applications a ON a.job_id = j.id WHERE j.id = ?`,
    [id],
  );
  return row;
}

jobsRouter.get('/:id', async (req, res) => {
  const row = await findJob(req.params.id);
  if (!row) return res.status(404).json({ error: 'Job not found.' });
  res.json({ job: serializeJob(row, await getEstimates()) });
});

// F10: hide + log the reason, so false positives can be turned into exclude keywords.
jobsRouter.post('/:id/hide', async (req, res) => {
  const reason = String(req.body?.reason || 'Not relevant').trim().slice(0, 200);
  const result = await query('UPDATE jobs SET is_hidden = 1, hidden_at = ?, hide_reason = ?, updated_at = ? WHERE id = ?', [
    new Date(),
    reason,
    new Date(),
    req.params.id,
  ]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Job not found.' });
  res.json({ ok: true });
});

jobsRouter.post('/:id/unhide', async (req, res) => {
  await query('UPDATE jobs SET is_hidden = 0, hidden_at = NULL, hide_reason = NULL, updated_at = ? WHERE id = ?', [
    new Date(),
    req.params.id,
  ]);
  res.json({ ok: true });
});

// A job the classifier wrongly filtered out: show it and stop re-classifying it.
jobsRouter.post('/:id/restore', async (req, res) => {
  await query(
    `UPDATE jobs SET is_relevant = 1, is_hidden = 0, classifier = 'manual',
            match_score = GREATEST(match_score, 50), updated_at = ? WHERE id = ?`,
    [new Date(), req.params.id],
  );
  res.json({ ok: true });
});
