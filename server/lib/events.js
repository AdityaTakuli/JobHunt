// First-party usage statistics for the owner's Admin page: which pages and features people use,
// and when. Only the name of the action and the time are kept: never search words, CV text or
// anything typed. Kept for RETENTION_DAYS, deleted with the account, never sent anywhere else.

import { query } from '../db/pool.js';

export const RETENTION_DAYS = 180;

// Every name the app may record. Anything else is dropped.
export const EVENT_NAMES = new Set([
  // Recorded by the server
  'login',
  // Opening the app and its pages
  'app:open',
  'page:jobs',
  'page:tracker',
  'page:profile',
  'page:companies',
  'page:firms',
  'page:settings',
  // Jobs
  'job:open',
  'job:apply',
  'job:save',
  'job:hide',
  'search:run',
  // The paid tools, as pressed (the work done is counted separately in feature_uses)
  'tailor:click',
  'analysis:click',
  // Pro
  'gopro:header',
  'gopro:banner',
  'gopro:limit',
  'plan:pay',
  'plan:trial',
  'coupon:apply',
  // ARCH in Chrome
  'extension:download',
]);

// What the Admin page calls each event.
export const EVENT_LABELS = {
  login: 'Signed in',
  'app:open': 'Opened the app',
  'page:jobs': 'Jobs page',
  'page:tracker': 'Tracker page',
  'page:profile': 'Profile page',
  'page:companies': 'Companies page',
  'page:firms': 'Firm list page',
  'page:settings': 'Settings page',
  'job:open': 'Opened a job',
  'job:apply': 'Clicked Apply',
  'job:save': 'Saved a job',
  'job:hide': 'Hid a job',
  'search:run': 'Ran a search',
  'tailor:click': 'Pressed Tailor my CV',
  'analysis:click': 'Pressed Analyse this job',
  'gopro:header': 'Clicked Go Pro (top bar)',
  'gopro:banner': 'Clicked Go Pro (Jobs strip)',
  'gopro:limit': 'Clicked Go Pro (at a limit)',
  'plan:pay': 'Pressed Pay',
  'plan:trial': 'Started the free trial',
  'coupon:apply': 'Applied a coupon',
  'extension:download': 'Downloaded ARCH in Chrome',
};

// At most this many events per person per hour, so a stuck tab can't flood the table.
const HOURLY_CAP = 400;
const counts = new Map(); // user id -> { hour, n }

function allowance(userId, wanted, now) {
  const hour = Math.floor(now / 3_600_000);
  const c = counts.get(userId);
  const used = c && c.hour === hour ? c.n : 0;
  const take = Math.max(0, Math.min(wanted, HOURLY_CAP - used));
  counts.set(userId, { hour, n: used + take });
  if (counts.size > 5000) for (const [k, v] of counts) if (v.hour !== hour) counts.delete(k);
  return take;
}

// Records known events for a person; unknown names are ignored. Never throws.
export async function recordEvents(userId, names, now = new Date()) {
  if (!userId) return 0;
  const known = (Array.isArray(names) ? names : [names]).filter((n) => typeof n === 'string' && EVENT_NAMES.has(n)).slice(0, 50);
  const take = allowance(userId, known.length, now.getTime());
  if (!take) return 0;
  try {
    await query('INSERT INTO events (user_id, name, created_at) VALUES ?', [known.slice(0, take).map((n) => [userId, n, now])]);
    return take;
  } catch (err) {
    console.warn(`Could not record events for user ${userId}: ${err.message}`);
    return 0;
  }
}

export const recordEvent = (userId, name, now) => recordEvents(userId, [name], now);

export async function forgetOldEvents(now = new Date()) {
  const res = await query('DELETE FROM events WHERE created_at < ?', [new Date(now.getTime() - RETENTION_DAYS * 86_400_000)]);
  return res.affectedRows || 0;
}
