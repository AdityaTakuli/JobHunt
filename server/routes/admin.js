// The Admin page: who uses ArchJobs, how and when, who pays, and which coupons went where. Admins
// only (requireAdmin in app.js). Usage comes from the events table (lib/events.js, names and times
// only), the work done from feature_uses, money from payments.

import { Router } from 'express';
import { query } from '../db/pool.js';
import { EVENT_LABELS, recordEvents } from '../lib/events.js';
import { isAdmin } from '../lib/users.js';

export const adminRouter = Router();

// Anyone signed in reports what they did: { events: ['page:jobs', 'job:open'] }.
export async function postEvents(req, res) {
  const names = Array.isArray(req.body?.events) ? req.body.events : [];
  const kept = await recordEvents(req.user.id, names);
  res.json({ ok: true, kept });
}

const IST = "'+05:30'";
const istDay = (col) => `DATE(CONVERT_TZ(${col}, '+00:00', ${IST}))`;
const istHour = (col) => `HOUR(CONVERT_TZ(${col}, '+00:00', ${IST}))`;
const FEATURE_LABELS = { tailor: 'Tailored CVs made', analysis: 'Job fit checks made', fill: 'ARCH form answers', profile: 'Profile reads' };

function windowOf(req) {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  return { days, since: new Date(Date.now() - days * 86_400_000) };
}

// Admins' own clicks are left out unless ?admins=1, so they don't skew the numbers.
async function hiddenIds(req) {
  if (req.query.admins === '1') return [0];
  const rows = await query('SELECT id, email, is_admin FROM users');
  const ids = rows.filter((r) => isAdmin(r)).map((r) => r.id);
  return ids.length ? ids : [0];
}

function planOf(u, now = new Date()) {
  const running = u.plan && u.plan_expires_at && new Date(u.plan_expires_at) > now;
  if (!running) return { status: 'free', until: null };
  return { status: u.plan === 'trial' ? 'trial' : 'pro', plan: u.plan, until: new Date(u.plan_expires_at).toISOString() };
}

adminRouter.get('/overview', async (req, res) => {
  const { days, since } = windowOf(req);
  const hide = await hiddenIds(req);
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(now.getTime() - 30 * 86_400_000);
  const active = async (from) =>
    Number((await query('SELECT COUNT(DISTINCT user_id) AS n FROM events WHERE created_at >= ? AND user_id NOT IN (?)', [from, hide]))[0].n);

  const [[users], [newUsers], [pro], [trial], [revenue], [revenueWindow], [coupons], daily, hours, events, work, signups] = await Promise.all([
    query('SELECT COUNT(*) AS n FROM users WHERE id NOT IN (?)', [hide]),
    query('SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND id NOT IN (?)', [since, hide]),
    query("SELECT COUNT(*) AS n FROM users WHERE plan IS NOT NULL AND plan <> 'trial' AND plan_expires_at > ? AND id NOT IN (?)", [now, hide]),
    query("SELECT COUNT(*) AS n FROM users WHERE plan = 'trial' AND plan_expires_at > ? AND id NOT IN (?)", [now, hide]),
    query("SELECT COALESCE(SUM(amount), 0) AS paise, COUNT(*) AS n FROM payments WHERE status = 'paid' AND mode = 'live'"),
    query("SELECT COALESCE(SUM(amount), 0) AS paise, COUNT(*) AS n FROM payments WHERE status = 'paid' AND mode = 'live' AND paid_at >= ?", [since]),
    query("SELECT COUNT(*) AS n FROM coupon_redemptions WHERE coupon NOT LIKE '\\_%'"),
    query(
      `SELECT ${istDay('created_at')} AS day, COUNT(DISTINCT user_id) AS users, COUNT(*) AS events FROM events
        WHERE created_at >= ? AND user_id NOT IN (?) GROUP BY day ORDER BY day`,
      [since, hide],
    ),
    query(
      `SELECT ${istHour('created_at')} AS hour, COUNT(*) AS events, COUNT(DISTINCT user_id) AS users FROM events
        WHERE created_at >= ? AND user_id NOT IN (?) GROUP BY hour`,
      [since, hide],
    ),
    query('SELECT name, COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM events WHERE created_at >= ? AND user_id NOT IN (?) GROUP BY name', [since, hide]),
    query('SELECT feature, COUNT(*) AS n, COUNT(DISTINCT user_id) AS users FROM feature_uses WHERE created_at >= ? AND user_id NOT IN (?) GROUP BY feature', [since, hide]),
    query(`SELECT ${istDay('created_at')} AS day, COUNT(*) AS n FROM users WHERE created_at >= ? AND id NOT IN (?) GROUP BY day`, [since, hide]),
  ]);

  const byHour = Array.from({ length: 24 }, (_, h) => {
    const row = hours.find((r) => Number(r.hour) === h);
    return { hour: h, events: Number(row?.events || 0), users: Number(row?.users || 0) };
  });
  // Every day of the window, so quiet days show as zero rather than vanishing.
  const dayKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getTime() + 330 * 60_000 - i * 86_400_000).toISOString().slice(0, 10);
    const row = daily.find((r) => dayKey(r.day) === d);
    const joined = signups.find((r) => dayKey(r.day) === d);
    series.push({ day: d, users: Number(row?.users || 0), events: Number(row?.events || 0), signups: Number(joined?.n || 0) });
  }

  res.json({
    days,
    includesAdmins: req.query.admins === '1',
    totals: {
      users: Number(users.n),
      newUsers: Number(newUsers.n),
      activeToday: await active(dayAgo),
      active7: await active(weekAgo),
      active30: await active(monthAgo),
      pro: Number(pro.n),
      trial: Number(trial.n),
      revenue: Number(revenue.paise),
      payments: Number(revenue.n),
      revenueWindow: Number(revenueWindow.paise),
      couponsUsed: Number(coupons.n),
    },
    daily: series,
    hours: byHour,
    events: events
      .map((e) => ({ name: e.name, label: EVENT_LABELS[e.name] || e.name, count: Number(e.n), users: Number(e.users) }))
      .sort((a, b) => b.count - a.count),
    work: work.map((w) => ({ feature: w.feature, label: FEATURE_LABELS[w.feature] || w.feature, count: Number(w.n), users: Number(w.users) })).sort((a, b) => b.count - a.count),
  });
});

adminRouter.get('/users', async (req, res) => {
  const { days, since } = windowOf(req);
  const [rows, work, coupons, paid] = await Promise.all([
    query(
      `SELECT u.id, u.name, u.email, u.is_admin, u.created_at, u.last_login_at, u.plan, u.plan_expires_at, u.gmail_token IS NOT NULL AS gmail,
              (SELECT MAX(e.created_at) FROM events e WHERE e.user_id = u.id) AS last_seen,
              (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id AND e.created_at >= ?) AS events,
              (SELECT COUNT(*) FROM events e WHERE e.user_id = u.id AND e.name = 'login') AS logins,
              (SELECT COUNT(DISTINCT ${istDay('e.created_at')}) FROM events e WHERE e.user_id = u.id AND e.created_at >= ?) AS active_days,
              (SELECT COUNT(*) FROM applications a WHERE a.user_id = u.id) AS tracked
         FROM users u`,
      [since, since],
    ),
    query('SELECT user_id, feature, COUNT(*) AS n FROM feature_uses WHERE created_at >= ? GROUP BY user_id, feature', [since]),
    query('SELECT user_id, coupon, created_at FROM coupon_redemptions ORDER BY created_at'),
    query("SELECT user_id, COALESCE(SUM(amount), 0) AS paise FROM payments WHERE status = 'paid' AND mode = 'live' GROUP BY user_id"),
  ]);
  const users = rows.map((u) => {
    const mine = work.filter((w) => w.user_id === u.id);
    const used = coupons.filter((c) => c.user_id === u.id);
    return {
      id: u.id,
      name: u.name || null,
      email: u.email || null,
      admin: isAdmin(u),
      joined: u.created_at,
      lastLogin: u.last_login_at,
      lastSeen: u.last_seen || u.last_login_at || null,
      events: Number(u.events),
      logins: Number(u.logins),
      activeDays: Number(u.active_days),
      tracked: Number(u.tracked),
      gmail: Boolean(u.gmail),
      work: Object.fromEntries(mine.map((w) => [w.feature, Number(w.n)])),
      coupons: used.filter((c) => !c.coupon.startsWith('_')).map((c) => c.coupon),
      hadTrial: used.some((c) => c.coupon === '_TRIAL'),
      paid: Number(paid.find((p) => p.user_id === u.id)?.paise || 0),
      ...planOf(u),
    };
  });
  users.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
  res.json({ days, users });
});

adminRouter.param('id', (req, res, next, id) => (/^\d{1,10}$/.test(id) ? next() : res.status(404).json({ error: 'Not found.' })));

adminRouter.get('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const [[user], events, work, payments, hours] = await Promise.all([
    query('SELECT id, name, email, created_at, last_login_at, plan, plan_expires_at FROM users WHERE id = ?', [id]),
    query('SELECT name, created_at FROM events WHERE user_id = ? ORDER BY id DESC LIMIT 150', [id]),
    query('SELECT feature, created_at FROM feature_uses WHERE user_id = ? ORDER BY id DESC LIMIT 100', [id]),
    query('SELECT plan, amount, status, mode, coupon, created_at, paid_at FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50', [id]),
    query(`SELECT ${istHour('created_at')} AS hour, COUNT(*) AS n FROM events WHERE user_id = ? GROUP BY hour`, [id]),
  ]);
  if (!user) return res.status(404).json({ error: 'Not found.' });
  // One timeline: what they pressed and the work it led to, newest first.
  const timeline = [
    ...events.map((e) => ({ at: e.created_at, label: EVENT_LABELS[e.name] || e.name, kind: e.name.split(':')[0] })),
    ...work.map((w) => ({ at: w.created_at, label: FEATURE_LABELS[w.feature]?.replace(/s made$|s$/, '') || w.feature, kind: 'work' })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 150);
  res.json({
    user: { id: user.id, name: user.name, email: user.email, joined: user.created_at, lastLogin: user.last_login_at, ...planOf(user) },
    timeline,
    payments: payments.map((p) => ({ ...p, amount: Number(p.amount) })),
    hours: Array.from({ length: 24 }, (_, h) => Number(hours.find((r) => Number(r.hour) === h)?.n || 0)),
  });
});

adminRouter.get('/payments', async (req, res) => {
  const rows = await query(
    `SELECT p.id, p.plan, p.days, p.amount, p.list_amount, p.currency, p.status, p.mode, p.coupon, p.created_at, p.paid_at, u.id AS user_id, u.name, u.email
       FROM payments p LEFT JOIN users u ON u.id = p.user_id ORDER BY p.id DESC LIMIT 300`,
  );
  res.json({
    payments: rows.map((p) => ({
      id: p.id,
      plan: p.plan,
      days: p.days,
      amount: Number(p.amount),
      listAmount: p.list_amount == null ? null : Number(p.list_amount),
      status: p.status,
      mode: p.mode,
      coupon: p.coupon,
      createdAt: p.created_at,
      paidAt: p.paid_at,
      user: { id: p.user_id, name: p.name, email: p.email },
    })),
  });
});
