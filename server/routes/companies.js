import { Router } from 'express';
import { parseJson, query } from '../db/pool.js';
import { STILL_OPEN } from '../lib/deadline.js';
import { isRunning, runTask } from '../tasks/index.js';

export const companiesRouter = Router();

const ROLES_SHOWN = 3;
// A firm checked this recently is not read again on request (its feed is not hammered).
const RECHECK_AFTER_MS = 5 * 60_000;
let checkingSlugs = [];

// Each watched company with its careers link and the open roles we have for it (newest first).
// Firms with openings are listed first. Roles she hid stay hidden here too.
// ?type=internship shows internships only; ?type=job everything else (fresher and full-time roles).
const TYPE_WHERE = {
  internship: " AND j.role_type = 'internship'",
  job: " AND (j.role_type IS NULL OR j.role_type <> 'internship')",
};

const isIntern = (j) => j.role_type === 'internship';
const fitsType = { internship: isIntern, job: (j) => !isIntern(j) };
const entryFirst = (a, b) => Number(['internship', 'fresher'].includes(b.role_type)) - Number(['internship', 'fresher'].includes(a.role_type)) || new Date(b.posted_at) - new Date(a.posted_at);

companiesRouter.get('/', async (req, res) => {
  const type = Object.hasOwn(TYPE_WHERE, req.query.type) ? req.query.type : '';
  const rows = await query('SELECT * FROM companies ORDER BY sort_order');
  const namesOf = new Map(rows.map((c) => [c.slug, parseJson(c.match_names, [c.name]).map((n) => String(n).toLowerCase())]));
  const allNames = [...new Set([...namesOf.values()].flat())];
  // One query for every firm's open roles (it was two per firm: 34 queries on a 5-connection
  // pool queued badly under load), then split by firm here. A name matches the start of the
  // job's company, as LIKE 'name%' did.
  const jobs = allNames.length
    ? await query(
        `SELECT j.id, j.title, j.company, j.city, j.role_type, j.apply_url, COALESCE(j.posted_at, j.created_at) AS posted_at
           FROM jobs j
          WHERE ${STILL_OPEN} AND j.is_archived = 0 AND j.is_relevant = 1 AND (${allNames.map(() => 'j.company LIKE ?').join(' OR ')})
            AND NOT EXISTS (SELECT 1 FROM job_hides h WHERE h.job_id = j.id AND h.user_id = ?)`,
        [...allNames.map((n) => `${n.replace(/[\\%_]/g, '\\$&')}%`), req.user.id],
      )
    : [];
  const companies = [];
  for (const c of rows) {
    const names = namesOf.get(c.slug);
    const mine = jobs.filter((j) => names.some((n) => String(j.company || '').toLowerCase().startsWith(n)));
    // Both counts every time, so the switch can say how many of each there are.
    const interns = mine.filter(isIntern).length;
    const total = mine.length;
    const shown = type ? mine.filter(fitsType[type]) : mine;
    const n = shown.length;
    const roles = [...shown]
      .sort(entryFirst)
      .slice(0, ROLES_SHOWN)
      .map(({ company, ...r }) => r);
    companies.push({
      slug: c.slug,
      name: c.name,
      kind: c.kind,
      cities: c.cities,
      careersUrl: c.careers_url,
      note: c.note,
      tracked: Boolean(c.feed_type),
      lastCheckedAt: c.last_checked_at,
      lastError: c.last_error,
      lastFound: c.last_found,
      lastNew: c.last_new,
      openRoles: Number(n),
      internships: interns,
      jobs: total - interns,
      roles,
    });
  }
  companies.sort((a, b) => b.openRoles - a.openRoles);
  const totals = { internship: companies.reduce((s, c) => s + c.internships, 0), job: companies.reduce((s, c) => s + c.jobs, 0) };
  res.json({ companies, type, totals, checking: isRunning('fetch-companies') ? checkingSlugs : [] });
});

// "Check now": reads the firm's careers feed (or every firm's) right away instead of waiting for
// the morning run. Answers at once; the page polls GET / until `checking` is empty.
companiesRouter.post('/check', async (req, res) => {
  if (isRunning('fetch-companies')) return res.status(202).json({ checking: checkingSlugs });
  const slug = req.body?.slug ? String(req.body.slug) : null;
  const rows = await query('SELECT slug, last_checked_at, last_error FROM companies WHERE feed_type IS NOT NULL');
  const now = Date.now();
  const due = rows.filter((r) => (!slug || r.slug === slug) && (r.last_error || !r.last_checked_at || now - new Date(r.last_checked_at).getTime() > RECHECK_AFTER_MS));
  if (slug && !rows.some((r) => r.slug === slug)) return res.status(404).json({ error: 'This company has no careers feed to check.' });
  if (!due.length) return res.json({ checking: [], fresh: true });
  checkingSlugs = due.map((r) => r.slug);
  runTask('fetch-companies', { slugs: checkingSlugs })
    .catch((err) => console.error(`Company check failed: ${err.message}`))
    .finally(() => {
      checkingSlugs = [];
    });
  res.status(202).json({ checking: checkingSlugs });
});
