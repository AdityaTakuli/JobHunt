// Accounts. User 1 is the owner: the password login, and everything saved before accounts existed.
// Others sign in with Google and get their own tracker, firms, hidden jobs, searches and settings;
// the job list itself is shared.

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { getSettings } from './settings.js';

export const OWNER_ID = 1;

const lower = (email) => String(email || '').trim().toLowerCase();

export function isAdmin(row) {
  if (!row) return false;
  return row.id === OWNER_ID || Boolean(row.is_admin) || (Boolean(row.email) && config.auth.adminEmails.includes(lower(row.email)));
}

// What the app and the API handlers see as req.user.
export function sessionUser(row) {
  return {
    id: row.id,
    email: row.email || null,
    name: row.name || null,
    picture: row.picture || null,
    isAdmin: isAdmin(row),
    isOwner: row.id === OWNER_ID,
  };
}

export async function findUser(id) {
  const [row] = await query('SELECT * FROM users WHERE id = ?', [id]);
  return row || null;
}

// Who may sign in with Google: the owner, admins, people already signed up, ALLOWED_EMAILS
// (or * for anyone) and the list admins keep in Settings > People.
export async function mayJoin(email) {
  const e = lower(email);
  if (!e) return false;
  const { ownerEmail, adminEmails, allowedEmails } = config.auth;
  if (e === ownerEmail || adminEmails.includes(e) || allowedEmails.includes('*') || allowedEmails.includes(e)) return true;
  const [existing] = await query('SELECT id FROM users WHERE email = ?', [e]);
  if (existing) return true;
  return (await getSettings()).allowed_emails.map(lower).includes(e);
}

const denied = () => Object.assign(new Error('This Google account is not on the list. Ask the owner to add it in Settings > People.'), { code: 'not_allowed' });

/**
 * Finds or creates the account for a Google sign-in.
 * @param profile { sub, email, name, picture } from Google's ID token (email verified)
 */
export async function signInWithGoogle(profile, now = new Date()) {
  const email = lower(profile.email);
  const details = { name: profile.name?.slice(0, 120) || null, picture: profile.picture?.slice(0, 500) || null, last_login_at: now };

  let [row] = await query('SELECT * FROM users WHERE google_sub = ?', [profile.sub]);
  if (!row) {
    [row] = await query('SELECT * FROM users WHERE email = ?', [email]);
    // The owner's Google account opens the owner account even before it has an email on file.
    if (!row && email === config.auth.ownerEmail) row = await findUser(OWNER_ID);
    if (row && row.google_sub && row.google_sub !== profile.sub) throw denied();
  }
  if (row) {
    await query('UPDATE users SET ?, google_sub = ?, email = COALESCE(email, ?) WHERE id = ?', [details, profile.sub, email, row.id]);
    return findUser(row.id);
  }
  if (!(await mayJoin(email))) throw denied();
  const res = await query('INSERT INTO users SET ?', [{ ...details, email, google_sub: profile.sub, created_at: now }]);
  return findUser(res.insertId);
}

// Removes someone and everything that is theirs alone. The owner cannot be removed.
export async function deleteUser(id) {
  if (Number(id) === OWNER_ID) throw Object.assign(new Error("The owner's account can't be removed."), { status: 400 });
  for (const table of ['applications', 'firms', 'searches', 'user_settings', 'job_hides', 'mail_events']) {
    await query(`DELETE FROM ${table} WHERE user_id = ?`, [id]);
  }
  const res = await query('DELETE FROM users WHERE id = ?', [id]);
  return res.affectedRows > 0;
}
