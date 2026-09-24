import { Router } from 'express';
import { FIRM_STATUSES } from '../../shared/format.js';
import { query } from '../db/pool.js';
import { getSettings } from '../lib/settings.js';

export const firmsRouter = Router();

const TEXT_FIELDS = { name: 200, city: 120, type: 40, website: 500, contact_email: 200, notes: 5000 };

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

function normalizeWebsite(url) {
  const value = String(url || '').trim();
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function readFirm(body, { partial }) {
  const firm = {};
  for (const [key, max] of Object.entries(TEXT_FIELDS)) {
    if (!(key in body)) continue;
    const text = body[key] == null ? '' : String(body[key]).trim();
    firm[key] = text ? text.slice(0, max) : null;
  }
  if ('website' in firm) firm.website = normalizeWebsite(firm.website);
  if (firm.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(firm.contact_email)) throw badRequest('Enter a valid email.');
  if ('status' in body) {
    if (!FIRM_STATUSES.includes(body.status)) throw badRequest('Unknown status.');
    firm.status = body.status;
  }
  if ('last_emailed_at' in body) {
    const d = body.last_emailed_at ? new Date(body.last_emailed_at) : null;
    if (d && Number.isNaN(d.getTime())) throw badRequest('Invalid date.');
    firm.last_emailed_at = d;
  }
  if (!partial && !firm.name) throw badRequest('Firm name is required.');
  if (partial && 'name' in firm && !firm.name) throw badRequest('Firm name is required.');
  return firm;
}

firmsRouter.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const params = [];
  let where = '1 = 1';
  if (q) {
    const like = `%${q.slice(0, 100).replace(/[\\%_]/g, '\\$&')}%`;
    where = '(name LIKE ? OR city LIKE ? OR type LIKE ? OR contact_email LIKE ? OR notes LIKE ?)';
    params.push(like, like, like, like, like);
  }
  if (req.query.status && FIRM_STATUSES.includes(req.query.status)) {
    where += ' AND status = ?';
    params.push(req.query.status);
  }
  const rows = await query(`SELECT * FROM firms WHERE ${where} ORDER BY name LIMIT 1000`, params);
  res.json({ firms: rows });
});

// Cold-email ideas for empty states: firms not contacted yet, preferring her cities.
firmsRouter.get('/suggestions', async (req, res) => {
  const { cities } = await getSettings();
  const rows = await query(
    `SELECT * FROM firms WHERE status = 'not contacted'
      ORDER BY ${cities.length ? '(city IN (?)) DESC,' : ''} created_at ASC LIMIT 5`,
    cities.length ? [cities] : [],
  );
  res.json({ firms: rows });
});

firmsRouter.post('/', async (req, res) => {
  const now = new Date();
  const firm = readFirm(req.body || {}, { partial: false });
  const result = await query('INSERT INTO firms SET ?', [{ status: 'not contacted', ...firm, created_at: now, updated_at: now }]);
  const [row] = await query('SELECT * FROM firms WHERE id = ?', [result.insertId]);
  res.status(201).json({ firm: row });
});

// Bulk add from a pasted CSV (parsed in the browser). Skips names that already exist.
firmsRouter.post('/import', async (req, res) => {
  const rows = Array.isArray(req.body?.firms) ? req.body.firms.slice(0, 1000) : [];
  if (!rows.length) return res.status(400).json({ error: 'Nothing to import.' });
  const existing = new Set((await query('SELECT LOWER(name) AS n FROM firms')).map((r) => r.n));
  const now = new Date();
  const values = [];
  const errors = [];
  rows.forEach((raw, i) => {
    try {
      const firm = readFirm(raw, { partial: false });
      if (existing.has(firm.name.toLowerCase())) return;
      existing.add(firm.name.toLowerCase());
      values.push([firm.name, firm.city ?? null, firm.type ?? null, firm.website ?? null, firm.contact_email ?? null, firm.notes ?? null, 'not contacted', now, now]);
    } catch (err) {
      errors.push(`Row ${i + 1}: ${err.message}`);
    }
  });
  if (values.length) {
    await query('INSERT INTO firms (name, city, type, website, contact_email, notes, status, created_at, updated_at) VALUES ?', [values]);
  }
  res.json({ imported: values.length, skipped: rows.length - values.length - errors.length, errors });
});

firmsRouter.patch('/:id', async (req, res) => {
  const firm = readFirm(req.body || {}, { partial: true });
  if (Object.keys(firm).length) {
    const result = await query('UPDATE firms SET ?, updated_at = ? WHERE id = ?', [firm, new Date(), req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Firm not found.' });
  }
  const [row] = await query('SELECT * FROM firms WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Firm not found.' });
  res.json({ firm: row });
});

// One tap after sending a cold email.
firmsRouter.post('/:id/emailed', async (req, res) => {
  const now = new Date();
  const result = await query("UPDATE firms SET last_emailed_at = ?, status = 'emailed', updated_at = ? WHERE id = ?", [
    now,
    now,
    req.params.id,
  ]);
  if (!result.affectedRows) return res.status(404).json({ error: 'Firm not found.' });
  const [row] = await query('SELECT * FROM firms WHERE id = ?', [req.params.id]);
  res.json({ firm: row });
});

firmsRouter.delete('/:id', async (req, res) => {
  await query('DELETE FROM firms WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});
