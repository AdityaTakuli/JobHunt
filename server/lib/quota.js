// Weekly free use of the paid features. Free accounts get a few tailored CVs, AI job suggestions,
// AI answers in ARCH and profile reads each week (config.freeLimits.weekly); Pro (a running paid
// plan) and admins have no weekly limit, only the daily caps every feature already has.
// Weeks start Monday midnight IST. Tailoring and job analysis reserve a use before the AI starts
// (reserveUse), so five requests at once can't all slip under a limit of two, and hand it back if
// the AI fails (refundUse): a failed run costs nothing.

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { isEnabled, planStatus } from './razorpay.js';
import { startOfIstWeek } from './time.js';

export const QUOTA_FEATURES = ['tailor', 'analysis', 'fill', 'profile'];

const NAMES = {
  tailor: 'tailored CVs and cover letters',
  analysis: 'job fit checks',
  fill: 'ARCH form answers',
  profile: 'profile reads',
};

// Off until payments are on, unless FREE_LIMITS forces it.
export function freeLimitsOn(cfg = config) {
  return cfg.freeLimits.mode === 'on' || (cfg.freeLimits.mode === 'auto' && isEnabled(cfg.razorpay));
}

export function nextWeek(now = new Date()) {
  return new Date(startOfIstWeek(now).getTime() + 7 * 86_400_000);
}

// "₹199", the cheapest plan's price, or '' with no plans.
function fromPrice(cfg = config) {
  const amounts = cfg.razorpay.plans.map((p) => p.amount);
  return amounts.length ? `₹${(Math.min(...amounts) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '';
}

export function limitMessage(feature, limit, cfg = config) {
  const price = fromPrice(cfg);
  return `That was this week's last free one: you get ${limit} free ${NAMES[feature]} a week, and they come back on Monday. Pro has no weekly limit${price ? ` (from ${price} a month, with a free trial)` : ''}: Settings > Plan.`;
}

/**
 * Where a person stands this week: { limited, plan, resetsAt, features: { tailor: { used, limit } } }.
 * limit is null when there is no weekly limit for them.
 */
export async function quotaFor(user, now = new Date(), cfg = config) {
  const [row] = await query('SELECT plan, plan_expires_at FROM users WHERE id = ?', [user.id]);
  const plan = planStatus(row, now);
  const rows = await query('SELECT feature, COUNT(*) AS n FROM feature_uses WHERE user_id = ? AND created_at >= ? GROUP BY feature', [
    user.id,
    startOfIstWeek(now),
  ]);
  const used = Object.fromEntries(rows.map((r) => [r.feature, Number(r.n)]));
  const limited = freeLimitsOn(cfg) && !user.isAdmin && !plan.active;
  return {
    limited,
    plan,
    admin: Boolean(user.isAdmin),
    resetsAt: nextWeek(now).toISOString(),
    features: Object.fromEntries(QUOTA_FEATURES.map((f) => [f, { used: used[f] || 0, limit: limited ? cfg.freeLimits.weekly[f] : null }])),
  };
}

// The weekly limit a feature has hit, as { limit, used, message }, or null when it may run.
export async function weeklyBlock(user, feature, now = new Date(), cfg = config) {
  const q = await quotaFor(user, now, cfg);
  const f = q.features[feature];
  if (f.limit == null || f.used < f.limit) return null;
  return { ...f, message: limitMessage(feature, f.limit, cfg) };
}

// One person's checks and reservations run one at a time (the app is one Node process), so the
// count read and the row added can't interleave with another request of theirs.
const queues = new Map(); // user id -> tail of their queue
async function oneAtATime(userId, fn) {
  const before = queues.get(userId) || Promise.resolve();
  let done;
  const mine = new Promise((resolve) => (done = resolve));
  const tail = before.then(() => mine);
  queues.set(userId, tail);
  await before;
  try {
    return await fn();
  } finally {
    done();
    if (queues.get(userId) === tail) queues.delete(userId);
  }
}

/**
 * Takes one use of a feature for this week: { id } when it may run, or { blocked } (as weeklyBlock)
 * when the free uses are gone. Pro and admins always get one; it is counted for the record.
 */
export async function reserveUse(user, feature, now = new Date(), cfg = config) {
  return oneAtATime(user.id, async () => {
    const blocked = await weeklyBlock(user, feature, now, cfg);
    if (blocked) return { blocked };
    const res = await query('INSERT INTO feature_uses (user_id, feature, created_at) VALUES (?, ?, ?)', [user.id, feature, now]);
    return { id: res.insertId };
  });
}

// Gives back a reserved use when the AI work failed.
export async function refundUse(id) {
  if (!id) return;
  await query('DELETE FROM feature_uses WHERE id = ?', [id]).catch((err) => console.warn(`Could not hand back use ${id}: ${err.message}`));
}

export async function recordUse(userId, feature, now = new Date()) {
  await query('INSERT INTO feature_uses (user_id, feature, created_at) VALUES (?, ?, ?)', [userId, feature, now]).catch((err) =>
    console.warn(`Could not count a ${feature} use for user ${userId}: ${err.message}`),
  );
}
