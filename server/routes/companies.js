import { Router } from 'express';
import { parseJson, query } from '../db/pool.js';

export const companiesRouter = Router();

// Each watched company with its careers link and how many open roles we already have stored.
// The titles themselves stay on the Jobs page — listing them here just repeated the feed.
companiesRouter.get('/', async (req, res) => {
  const rows = await query('SELECT * FROM companies ORDER BY sort_order');
  const companies = [];
  for (const c of rows) {
    const names = parseJson(c.match_names, [c.name]);
    const like = names.map(() => 'j.company LIKE ?').join(' OR ');
    const where = `j.closed_at IS NULL AND j.is_archived = 0 AND j.is_relevant = 1 AND (${like})
      AND NOT EXISTS (SELECT 1 FROM job_hides h WHERE h.job_id = j.id AND h.user_id = ?)`;
    const params = [...names.map((n) => `${n.replace(/[\\%_]/g, '\\$&')}%`), req.user.id];
    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM jobs j WHERE ${where}`, params);
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
      openRoles: Number(n),
    });
  }
  companies.sort((a, b) => b.openRoles - a.openRoles);
  res.json({ companies });
});
