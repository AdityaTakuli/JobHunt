import { Router } from 'express';
import { accountView, requireAdmin } from '../auth.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { revoke } from '../lib/google.js';
import { open } from '../lib/secretBox.js';
import { DAY_MS, istDateString } from '../lib/time.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { deleteUser, findUser, isAdmin, OWNER_ID } from '../lib/users.js';
import { readGmail } from '../tasks/readGmail.js';

export const accountRouter = Router();

accountRouter.get('/account', async (req, res) => {
  res.json({ account: accountView(await findUser(req.user.id)) });
});

// "Check Gmail now" on the Settings screen: reads only her own mailbox.
accountRouter.post('/account/gmail/sync', async (req, res) => {
  // A few job emails per click keeps the answer quick; the 30-minute run reads the rest.
  const result = await readGmail({ userId: req.user.id, jobEmailsPerRun: 4 });
  res.json({ result, account: accountView(await findUser(req.user.id)) });
});

// Emails read from her Gmail, newest day first: [{ day: 'YYYY-MM-DD' (IST), emails: [...] }].
accountRouter.get('/account/gmail/emails', async (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 30, 1), 90);
  const rows = await query(
    `SELECT e.gmail_id, e.received_at, e.from_addr, e.subject, e.kind, e.company, e.role, e.jobs_found, e.application_id,
            COALESCE(j.title, a.title) AS tracked_title, a.status AS tracked_status
       FROM mail_events e
       LEFT JOIN applications a ON a.id = e.application_id AND a.user_id = e.user_id
       LEFT JOIN jobs j ON j.id = a.job_id
      WHERE e.user_id = ? AND e.received_at >= ?
      ORDER BY e.received_at DESC
      LIMIT 500`,
    [req.user.id, new Date(Date.now() - days * DAY_MS)],
  );
  const byDay = new Map();
  for (const r of rows) {
    const day = istDateString(new Date(r.received_at));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({
      id: r.gmail_id,
      receivedAt: r.received_at,
      from: r.from_addr,
      subject: r.subject,
      kind: r.kind,
      company: r.company,
      role: r.role,
      jobsFound: r.jobs_found,
      tracker: r.application_id ? { id: r.application_id, title: r.tracked_title, status: r.tracked_status } : null,
    });
  }
  res.json({ days: [...byDay].map(([day, emails]) => ({ day, emails })) });
});

accountRouter.post('/account/gmail/disconnect', async (req, res) => {
  const row = await findUser(req.user.id);
  const token = open(row?.gmail_token);
  // Also withdraw the permission at Google, so nothing can read her mail with it any more.
  if (token) await revoke(token);
  await query('UPDATE users SET gmail_token = NULL, gmail_connected_at = NULL, gmail_error = NULL WHERE id = ?', [req.user.id]);
  res.json({ account: accountView(await findUser(req.user.id)) });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function people() {
  const [users, settings] = await Promise.all([
    query(
      `SELECT u.id, u.email, u.name, u.picture, u.is_admin, u.created_at, u.last_login_at, u.gmail_token IS NOT NULL AS gmail,
              (SELECT COUNT(*) FROM applications a WHERE a.user_id = u.id) AS tracked
         FROM users u ORDER BY u.id`,
    ),
    getSettings(),
  ]);
  return {
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      picture: u.picture,
      isOwner: u.id === OWNER_ID,
      isAdmin: isAdmin(u),
      gmail: Boolean(u.gmail),
      tracked: Number(u.tracked),
      createdAt: u.created_at,
      lastLoginAt: u.last_login_at,
    })),
    allowed: settings.allowed_emails,
    // Set on the server (ALLOWED_EMAILS / ADMIN_EMAILS / OWNER_EMAIL); shown, not editable here.
    fromServer: [...new Set([config.auth.ownerEmail, ...config.auth.adminEmails, ...config.auth.allowedEmails].filter(Boolean))],
    openToAnyone: config.auth.allowedEmails.includes('*'),
  };
}

accountRouter.get('/people', requireAdmin, async (req, res) => {
  res.json(await people());
});

// Who may sign in with Google: the whole list, replaced.
accountRouter.put('/people/allowed', requireAdmin, async (req, res) => {
  const list = Array.isArray(req.body?.emails) ? req.body.emails : null;
  if (!list) return res.status(400).json({ error: 'Send a list of emails.' });
  const emails = [...new Set(list.map((e) => String(e || '').trim().toLowerCase()).filter(Boolean))].slice(0, 200);
  const bad = emails.find((e) => !EMAIL_RE.test(e));
  if (bad) return res.status(400).json({ error: `"${bad}" is not an email address.` });
  await saveSettings({ allowed_emails: emails });
  res.json(await people());
});

// Removes someone and their tracker, firms, searches and settings. Jobs stay for everyone.
accountRouter.delete('/people/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't remove yourself." });
  const row = await findUser(id);
  if (!row) return res.status(404).json({ error: 'No such person.' });
  const token = open(row.gmail_token);
  if (token) await revoke(token);
  // Off the list too, or they could sign straight back in.
  const settings = await getSettings();
  if (row.email) await saveSettings({ allowed_emails: settings.allowed_emails.filter((e) => e !== row.email) });
  await deleteUser(id);
  res.json(await people());
});
