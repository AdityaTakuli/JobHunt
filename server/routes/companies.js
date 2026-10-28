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
companiesRouter.get('/', async (req, res) => {
  const rows = await query('SELECT * FROM companies ORDER BY sort_order');
  const companies = [];
  for (const c of rows) {
    const names = parseJson(c.match_names, [c.name]);
    const like = names.map(() => 'j.company LIKE ?').join(' OR ');
    const where = `${STILL_OPEN} AND j.is_archived = 0 AND j.is_relevant = 1 AND (${like})
      AND NOT EXISTS (SELECT 1 FROM job_hides h WHERE h.job_id = j.id AND h.user_id = ?)`;
    const params = [...names.map((n) => `${n.replace(/[\\%_]/g, '\\$&')}%`), req.user.id];
    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM jobs j WHERE ${where}`, params);
    const roles = Number(n)
      ? await query(
          `SELECT j.id, j.title, j.city, j.role_type, j.apply_url, COALESCE(j.posted_at, j.created_at) AS posted_at
             FROM jobs j WHERE ${where} ORDER BY (j.role_type IN ('internship', 'fresher')) DESC, COALESCE(j.posted_at, j.created_at) DESC LIMIT ${ROLES_SHOWN}`,
          params,
        )
      : [];
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
      roles,
    });
  }
  companies.sort((a, b) => b.openRoles - a.openRoles);
  res.json({ companies, checking: isRunning('fetch-companies') ? checkingSlugs : [] });
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
