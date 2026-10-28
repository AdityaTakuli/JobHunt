import { Router } from 'express';
import { APP_STATUSES } from '../../shared/format.js';
import { query } from '../db/pool.js';
import { applyStatusSideEffects } from '../lib/tracker.js';

export const applicationsRouter = Router();
// Ids are whole numbers; anything else ("1 OR 1=1") is simply not found.
applicationsRouter.param('id', (req, res, next, id) => (/^\d{1,10}$/.test(id) ? next() : res.status(404).json({ error: 'Not found.' })));

const EDITABLE = ['status', 'applied_at', 'follow_up_at', 'contact_name', 'contact_email', 'notes', 'title', 'company', 'apply_url'];

const SELECT = `SELECT a.id, a.job_id, a.status, a.applied_at, a.follow_up_at, a.contact_name, a.contact_email, a.notes, a.source,
    a.created_at, a.updated_at,
    COALESCE(j.title, a.title) AS title, COALESCE(j.company, a.company) AS company,
    COALESCE(j.apply_url, a.apply_url) AS apply_url, j.city, j.role_type, j.is_bim,
    j.salary_text, j.salary_min, j.salary_max, j.salary_period, j.link_status, j.closed_at, j.closed_reason
  FROM applications a LEFT JOIN jobs j ON j.id = a.job_id`;
// Every query here is for the signed-in person's own tracker.

const serialize = (row) => ({ ...row, is_bim: Boolean(row.is_bim) });

function toDateOrNull(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw Object.assign(new Error('Invalid date.'), { status: 400 });
  return d;
}

// Validates and normalizes editable fields from a request body.
function readFields(body, { partial }) {
  const fields = {};
  for (const key of EDITABLE) {
    if (!(key in body)) continue;
    const value = body[key];
    if (key === 'status') {
      if (!APP_STATUSES.includes(value)) throw Object.assign(new Error('Unknown status.'), { status: 400 });
      fields.status = value;
    } else if (key === 'applied_at' || key === 'follow_up_at') {
      fields[key] = toDateOrNull(value);
    } else if (key === 'contact_email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim())) {
      throw Object.assign(new Error('Enter a valid contact email.'), { status: 400 });
    } else if (key === 'apply_url' && value && !/^https?:\/\/\S+$/i.test(String(value).trim())) {
      throw Object.assign(new Error('Links must start with http:// or https://'), { status: 400 });
    } else {
      const text = value == null ? null : String(value).trim();
      const max = key === 'notes' ? 5000 : key === 'apply_url' ? 1000 : 300;
      fields[key] = text ? text.slice(0, max) : null;
    }
  }
  if (!partial && !fields.status) fields.status = 'saved';
  return fields;
}

async function findApplication(id, uid) {
  const [row] = await query(`${SELECT} WHERE a.id = ? AND a.user_id = ?`, [id, uid]);
  return row ? serialize(row) : null;
}

applicationsRouter.get('/', async (req, res) => {
  const rows = await query(`${SELECT} WHERE a.user_id = ? ORDER BY a.updated_at DESC LIMIT 500`, [req.user.id]);
  res.json({ applications: rows.map(serialize) });
});

// Create, or update the existing tracker entry for the same job (Save / Mark as applied).
applicationsRouter.post('/', async (req, res) => {
  const body = req.body || {};
  const uid = req.user.id;
  const now = new Date();
  const jobId = body.job_id ? Number(body.job_id) : null;

  if (jobId) {
    const [job] = await query('SELECT id FROM jobs WHERE id = ?', [jobId]);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    const [existing] = await query('SELECT * FROM applications WHERE job_id = ? AND user_id = ?', [jobId, uid]);
    if (existing) {
      const fields = applyStatusSideEffects(readFields(body, { partial: true }), existing, now);
      if (Object.keys(fields).length) {
        await query('UPDATE applications SET ?, updated_at = ? WHERE id = ?', [fields, now, existing.id]);
      }
      return res.json({ application: await findApplication(existing.id, uid) });
    }
  } else if (!String(body.title || '').trim()) {
    return res.status(400).json({ error: 'Add a role title.' });
  }

  const fields = applyStatusSideEffects(readFields(body, { partial: false }), {}, now);
  const result = await query('INSERT INTO applications SET ?', [{ ...fields, user_id: uid, job_id: jobId, created_at: now, updated_at: now }]);
  res.status(201).json({ application: await findApplication(result.insertId, uid) });
});

applicationsRouter.patch('/:id', async (req, res) => {
  const [current] = await query('SELECT * FROM applications WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!current) return res.status(404).json({ error: 'Application not found.' });
  const now = new Date();
  const fields = applyStatusSideEffects(readFields(req.body || {}, { partial: true }), current, now);
  if (Object.keys(fields).length) {
    await query('UPDATE applications SET ?, updated_at = ? WHERE id = ?', [fields, now, current.id]);
  }
  res.json({ application: await findApplication(current.id, req.user.id) });
});

applicationsRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM applications WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  res.json({ ok: true });
});
