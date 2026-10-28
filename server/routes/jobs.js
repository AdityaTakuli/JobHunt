import { Router } from 'express';
import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';
import { getEstimates } from '../lib/estimate.js';
import { normalizeCity } from '../lib/normalize.js';
import { getUserSettings } from '../lib/settings.js';
import { STILL_OPEN } from '../lib/deadline.js';
import { DAY_MS, startOfIstDay } from '../lib/time.js';
import { localSearchesThisMonth } from '../tasks/fetchJobs.js';
import { typedSearchesToday } from '../tasks/liveSearch.js';

export const jobsRouter = Router();

const LIST_COLUMNS = `j.id, j.title, j.company, j.city, j.location_text, j.apply_url, j.apply_kind, j.apply_options, j.link_status, j.sources,
  j.posted_at, j.created_at, j.salary_text, j.salary_min, j.salary_max, j.salary_period, j.salary_is_estimate,
  j.role_type, j.is_bim, j.software, j.match_score, j.exp_min, j.exp_max, j.classifier, j.classify_reason, j.is_relevant,
  j.deadline_at, j.closed_at, j.closed_reason, a.id AS application_id, a.status AS application_status`;

// Ids come from the session (integers), so they can sit in the SQL; this keeps the join and the
// WHERE parameters in one simple order.
const userId = (id) => {
  const n = Number(id);
  if (!Number.isInteger(n) || n < 1) throw new Error('Bad user id');
  return n;
};
// Her own tracker entry for each job (each person has their own tracker).
export const trackerJoin = (uid) => `LEFT JOIN applications a ON a.job_id = j.id AND a.user_id = ${userId(uid)}`;
// Jobs she hid stay hidden for her only.
const notHiddenBy = (uid) => `NOT EXISTS (SELECT 1 FROM job_hides h WHERE h.job_id = j.id AND h.user_id = ${userId(uid)})`;

export function serializeJob(row, estimates = {}) {
  const job = {
    ...row,
    is_bim: Boolean(row.is_bim),
    is_relevant: Boolean(row.is_relevant),
    is_hidden: Boolean(row.is_hidden),
    // Past its apply-by date counts as closed even before the clean-up marks it.
    is_closed: Boolean(row.closed_at) || (row.deadline_at != null && new Date(row.deadline_at) < new Date()),
    salary_is_estimate: Boolean(row.salary_is_estimate),
    sources: parseJson(row.sources, []),
    apply_options: parseJson(row.apply_options, []),
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

const idList = (v) =>
  String(v || '')
    .split(',')
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 200);

// Builds the feed WHERE clause from query-string filters for one person. city=mine means their
// chosen cities (Settings), plus remote jobs and jobs with no city. ids=1,2,3 limits the list to
// the results of a live search: those are shown even if archived or judged not relevant, since
// she asked for them. Closed postings and jobs she hid never show.
export function feedFilters(q, now = new Date(), myCities = [], uid = 1) {
  const ids = idList(q.ids);
  const where = [STILL_OPEN, notHiddenBy(uid), ...(ids.length ? ['j.id IN (?)'] : ['j.is_archived = 0', 'j.is_relevant = 1'])];
  const params = ids.length ? [ids] : [];

  if (ids.length) {
    // City and keyword were part of the search itself.
  } else if (q.city === 'mine') {
    if (myCities.length) {
      where.push(`(j.city IN (?) OR j.city IN ('', 'Remote'))`);
      params.push(myCities);
    }
  } else if (q.city && q.city !== 'all') {
    // Typed cities come in any spelling: "bangalore" finds the jobs stored as "Bengaluru".
    where.push('j.city = ?');
    params.push(normalizeCity(String(q.city).slice(0, 80)) || String(q.city));
  }
  // Experience: exp=N keeps roles asking for at most N years. Roles that do not say count only
  // when classified as an internship or fresher role. exp=any turns the filter off.
  const exp = q.exp === undefined || q.exp === '' || q.exp === 'any' ? null : intParam(q.exp, null, { min: 0, max: 30 });
  if (exp != null) {
    where.push("(j.exp_min <= ? OR (j.exp_min IS NULL AND j.role_type IN ('internship', 'fresher')))");
    params.push(exp);
  }

  if (q.role === 'job') {
    where.push("(j.role_type IS NULL OR j.role_type <> 'internship')");
  } else if (['internship', 'fresher', 'experienced'].includes(q.role)) {
    where.push('j.role_type = ?');
    params.push(q.role);
  } else if (q.role !== 'all' && q.exp === undefined) {
    // Without an experience filter, experienced roles are hidden by default.
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
  // LinkedIn jobs: from the LinkedIn alert emails, or with a LinkedIn apply link from Google.
  if (q.linkedin === '1') {
    where.push(
      `(j.apply_kind = 'linkedin' OR JSON_SEARCH(j.sources, 'one', 'linkedin_email', NULL, '$[*].source') IS NOT NULL
        OR JSON_SEARCH(j.apply_options, 'one', 'linkedin', NULL, '$[*].kind') IS NOT NULL)`,
    );
  }
  // Where she can apply: company = the firm's own site, direct = + LinkedIn, trusted = + job boards.
  const APPLY_KINDS = { company: ['company'], direct: ['company', 'linkedin'], trusted: ['company', 'linkedin', 'board'] };
  if (APPLY_KINDS[q.apply]) {
    where.push('j.apply_kind IN (?)');
    params.push(APPLY_KINDS[q.apply]);
  }
  if (q.hideApplied === '1') {
    where.push("(a.status IS NULL OR a.status = 'saved')");
  }
  if (q.q && !ids.length) {
    const like = `%${String(q.q).slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;
    where.push('(j.title LIKE ? OR j.company LIKE ?)');
    params.push(like, like);
  }
  return { where: where.join(' AND '), params, ids };
}

const SORTS = { match: 'j.match_score DESC,', direct: 'j.apply_url_rank DESC,' };

// Search results sorted by relevance: roles judged relevant first, each group in Google's order.
// `ids` are integers checked by idList, so they can sit in the SQL.
const orderBy = (sort, ids) => (sort === 'relevance' && ids.length ? `j.is_relevant DESC, FIELD(j.id, ${ids.join(',')}),` : SORTS[sort] || '');

jobsRouter.get('/', async (req, res) => {
  const myCities = req.query.city === 'mine' ? (await getUserSettings(req.user.id)).cities : [];
  const { where, params, ids } = feedFilters(req.query, new Date(), myCities, req.user.id);
  const limit = intParam(req.query.limit, 50, { min: 1, max: 200 });
  const offset = intParam(req.query.offset, 0, { min: 0 });
  const [rows, [{ total }], estimates] = await Promise.all([
    query(
      `SELECT ${LIST_COLUMNS} FROM jobs j ${trackerJoin(req.user.id)}
        WHERE ${where}
        ORDER BY ${orderBy(req.query.sort, ids)} COALESCE(j.posted_at, j.created_at) DESC, j.id DESC
        LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    query(`SELECT COUNT(*) AS total FROM jobs j ${trackerJoin(req.user.id)} WHERE ${where}`, params),
    getEstimates(),
  ]);
  res.json({ jobs: rows.map((r) => serializeJob(r, estimates)), total: Number(total), limit, offset });
});

// Filter options and the top-of-page counter.
jobsRouter.get('/meta', async (req, res) => {
  const now = new Date();
  const uid = req.user.id;
  const open = `j.is_archived = 0 AND ${STILL_OPEN} AND j.is_relevant = 1 AND ${notHiddenBy(uid)}`;
  const [cities, [counts], [followUps], settings, searchesUsed, typedToday] = await Promise.all([
    query(`SELECT j.city, COUNT(*) AS n FROM jobs j WHERE ${open} AND j.city <> '' GROUP BY j.city ORDER BY n DESC LIMIT 30`),
    query(
      `SELECT SUM(j.created_at >= ?) AS new_today, COUNT(*) AS active FROM jobs j
        WHERE ${open} AND (j.role_type IS NULL OR j.role_type <> 'experienced')`,
      [startOfIstDay(now)],
    ),
    query(
      `SELECT COUNT(*) AS due FROM applications
        WHERE user_id = ? AND status IN ('applied', 'interview') AND follow_up_at IS NOT NULL AND follow_up_at <= ?`,
      [uid, now],
    ),
    getUserSettings(uid),
    localSearchesThisMonth(now),
    typedSearchesToday(uid, now),
  ]);
  res.json({
    search: {
      configured: Boolean(config.serpapi.apiKey),
      leftThisMonth: Math.max(0, config.serpapi.monthlyLimit - searchesUsed),
      leftToday: Math.max(0, config.serpapi.manualDailyLimit - typedToday),
    },
    cities: cities.map((c) => ({ city: c.city, count: Number(c.n) })),
    myCities: settings.cities,
    displayName: settings.display_name || String(req.user.name || '').split(' ')[0] || '',
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
      `SELECT j.id, j.title, j.company, j.city, j.apply_url, h.reason AS hide_reason, h.hidden_at FROM job_hides h
         JOIN jobs j ON j.id = h.job_id
        WHERE h.user_id = ? ORDER BY h.hidden_at DESC LIMIT 50`,
      [req.user.id],
    ),
    query(
      `SELECT j.id, j.title, j.company, j.city, j.apply_url, j.classifier, j.classify_reason, j.created_at FROM jobs j
        WHERE j.is_relevant = 0 AND ${STILL_OPEN} AND ${notHiddenBy(req.user.id)} AND j.created_at >= ?
        ORDER BY j.created_at DESC LIMIT 50`,
      [since],
    ),
  ]);
  res.json({ hidden, filtered });
});

async function findJob(id, uid) {
  const [row] = await query(
    `SELECT ${LIST_COLUMNS}, j.description, h.reason AS hide_reason, h.job_id IS NOT NULL AS is_hidden FROM jobs j
       ${trackerJoin(uid)}
       LEFT JOIN job_hides h ON h.job_id = j.id AND h.user_id = ${userId(uid)}
      WHERE j.id = ?`,
    [id],
  );
  return row;
}

jobsRouter.get('/:id', async (req, res) => {
  const row = await findJob(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Job not found.' });
  res.json({ job: serializeJob(row, await getEstimates()) });
});

// F10: hide + log the reason, so false positives can be turned into exclude keywords. Hidden for
// her only.
jobsRouter.post('/:id/hide', async (req, res) => {
  const reason = String(req.body?.reason || 'Not relevant').trim().slice(0, 200);
  const [job] = await query('SELECT id FROM jobs WHERE id = ?', [req.params.id]);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  await query(
    'INSERT INTO job_hides (user_id, job_id, reason, hidden_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE reason = VALUES(reason), hidden_at = VALUES(hidden_at)',
    [req.user.id, job.id, reason, new Date()],
  );
  res.json({ ok: true });
});

jobsRouter.post('/:id/unhide', async (req, res) => {
  await query('DELETE FROM job_hides WHERE user_id = ? AND job_id = ?', [req.user.id, req.params.id]);
  res.json({ ok: true });
});

// A job the classifier wrongly filtered out: show it (to everyone) and stop re-classifying it.
jobsRouter.post('/:id/restore', async (req, res) => {
  await query(
    `UPDATE jobs SET is_relevant = 1, classifier = 'manual',
            match_score = GREATEST(match_score, 50), updated_at = ? WHERE id = ?`,
    [new Date(), req.params.id],
  );
  await query('DELETE FROM job_hides WHERE user_id = ? AND job_id = ?', [req.user.id, req.params.id]);
  res.json({ ok: true });
});
