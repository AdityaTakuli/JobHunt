import { Router } from 'express';
import { parseJson, query } from '../db/pool.js';

export const companiesRouter = Router();

const ROLES_SHOWN = 6;

// Each watched company with its careers link and the open roles we have for it (newest first).
// Roles she hid stay hidden here too.
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
    const roles = await query(
      `SELECT j.id, j.title, j.city, j.role_type, j.exp_min, j.apply_url, COALESCE(j.posted_at, j.created_at) AS posted_at
         FROM jobs j WHERE ${where} ORDER BY (j.role_type IN ('internship', 'fresher')) DESC, COALESCE(j.posted_at, j.created_at) DESC LIMIT ${ROLES_SHOWN}`,
      params,
    );
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
      roles,
    });
  }
  res.json({ companies });
});
