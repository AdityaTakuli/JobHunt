// Sign-in. Two ways in, both ending in an HMAC-signed, HttpOnly session cookie naming the account:
//   - the owner's password (APP_PASSWORD) opens the owner account (user 1);
//   - "Continue with Google" opens the account for that Google email (lib/users.js decides who
//     may join). Connecting Gmail is a second Google step from Settings, with its own consent.
import crypto from 'node:crypto';
import { config } from './config.js';
import { query } from './db/pool.js';
import { authUrl, exchangeCode, GMAIL_SCOPE, googleConfigured, revoke } from './lib/google.js';
import { seal } from './lib/secretBox.js';
import { findUser, OWNER_ID, sessionUser, signInWithGoogle } from './lib/users.js';
import { readGmail } from './tasks/readGmail.js';

const COOKIE = 'aj_session';
const OAUTH_COOKIE = 'aj_oauth';
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const failures = new Map(); // ip -> { count, until }

const authEnabled = () => Boolean(config.auth.password) || googleConfigured();

function secret() {
  // Without SESSION_SECRET, sessions are tied to the password: changing it logs everyone out.
  return (
    config.auth.sessionSecret ||
    crypto.createHash('sha256').update(`archjobs:${config.auth.password}:${config.google.clientSecret}`).digest('hex')
  );
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function signed(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSigned(token, now = Date.now()) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof data.exp === 'number' && data.exp > now ? data : null;
  } catch {
    return null;
  }
}

export function createSessionToken(userId = OWNER_ID, now = Date.now()) {
  return signed({ uid: userId, exp: now + config.auth.sessionDays * 86_400_000 });
}

// The account a session token opens, or null. Tokens from before accounts existed open the owner's.
export function verifySessionToken(token, now = Date.now()) {
  const data = readSigned(token, now);
  if (!data) return null;
  return Number.isInteger(data.uid) ? data.uid : OWNER_ID;
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookieHeader(name, value, maxAgeSeconds, path = '/') {
  return [`${name}=${value}`, `Path=${path}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`, config.isProduction ? 'Secure' : null]
    .filter(Boolean)
    .join('; ');
}

const sessionCookie = (userId) => cookieHeader(COOKIE, createSessionToken(userId), config.auth.sessionDays * 86_400);

// The signed-in account's id, or null. With no way to sign in configured (local dev), everyone is the owner.
function sessionUserId(req) {
  if (!authEnabled()) return config.isProduction ? null : OWNER_ID;
  return verifySessionToken(readCookie(req, COOKIE));
}

async function currentUser(req) {
  const id = sessionUserId(req);
  if (!id) return null;
  const row = await findUser(id);
  return row ? { row, user: sessionUser(row) } : null;
}

export async function requireAuth(req, res, next) {
  if (!authEnabled() && config.isProduction) {
    return res.status(503).json({ error: 'Sign-in is not configured on the server (APP_PASSWORD or Google).' });
  }
  try {
    const found = await currentUser(req);
    if (!found) return res.status(401).json({ error: 'Please log in.' });
    req.user = found.user;
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.isAdmin) return next();
  return res.status(403).json({ error: 'Only the owner can do that.' });
}

export function login(req, res) {
  const ip = req.ip || 'unknown';
  const state = failures.get(ip);
  if (state?.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  if (!config.auth.password) {
    if (!authEnabled() && !config.isProduction) return res.json({ ok: true });
    return res.status(400).json({ error: 'Password sign-in is off. Use Continue with Google.' });
  }
  if (!safeEqual(req.body?.password ?? '', config.auth.password)) {
    // Forget old entries now and then, so a flood of addresses can't grow this without end.
    if (failures.size > 10_000) for (const [key, s] of failures) if (!(s.until > Date.now())) failures.delete(key);
    const count = (state?.count || 0) + 1;
    failures.set(ip, { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    return res.status(401).json({ error: 'Wrong password.' });
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', sessionCookie(OWNER_ID));
  return res.json({ ok: true });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', cookieHeader(COOKIE, '', 0));
  res.json({ ok: true });
}

// Account details for the app: who is signed in and whether Gmail is connected.
export function accountView(row) {
  return {
    ...sessionUser(row),
    gmail: {
      connected: Boolean(row.gmail_token),
      connectedAt: row.gmail_connected_at,
      syncedAt: row.gmail_synced_at,
      error: row.gmail_error,
    },
  };
}

export async function me(req, res, next) {
  try {
    const found = await currentUser(req);
    res.json({
      authenticated: Boolean(found),
      authRequired: authEnabled() || config.isProduction,
      google: googleConfigured(),
      passwordLogin: Boolean(config.auth.password),
      user: found ? accountView(found.row) : null,
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/auth/google/start            -> sign in (or join) with Google
// GET /api/auth/google/start?mode=gmail -> signed in already: allow reading job alerts in Gmail
export async function googleStart(req, res, next) {
  try {
    if (!googleConfigured()) return res.redirect('/?auth_error=not_configured');
    const gmail = req.query.mode === 'gmail';
    let loginHint;
    let uid = null;
    if (gmail) {
      const found = await currentUser(req);
      if (!found) return res.redirect('/?auth_error=signin_first');
      uid = found.user.id;
      loginHint = found.user.email || undefined;
    }
    const nonce = crypto.randomBytes(16).toString('base64url');
    res.setHeader('Set-Cookie', cookieHeader(OAUTH_COOKIE, signed({ n: nonce, gmail, uid, exp: Date.now() + 10 * 60_000 }), 600, '/api/auth'));
    return res.redirect(authUrl({ state: nonce, gmail, loginHint }));
  } catch (err) {
    return next(err);
  }
}

export async function googleCallback(req, res) {
  const flow = readSigned(readCookie(req, OAUTH_COOKIE));
  const gmail = Boolean(flow?.gmail);
  const fail = (code) => res.redirect(gmail ? `/?gmail_error=${code}#/settings` : `/?auth_error=${code}`);
  res.setHeader('Set-Cookie', cookieHeader(OAUTH_COOKIE, '', 0, '/api/auth'));

  if (!flow || !req.query.state || !safeEqual(req.query.state, flow.n)) return fail('expired');
  if (req.query.error) return fail(req.query.error === 'access_denied' ? 'cancelled' : 'failed');
  if (!req.query.code) return fail('failed');

  let grant;
  try {
    grant = await exchangeCode(String(req.query.code));
  } catch (err) {
    console.error('Google sign-in failed:', err.message);
    return fail('failed');
  }

  if (!gmail) {
    try {
      const row = await signInWithGoogle(grant.profile);
      res.append('Set-Cookie', sessionCookie(row.id));
      return res.redirect('/#/jobs');
    } catch (err) {
      if (err.code === 'not_allowed') return fail('not_allowed');
      console.error('Google sign-in failed:', err.message);
      return fail('failed');
    }
  }

  // Connecting Gmail: only for the account that started it, with the Google account it uses.
  const found = await currentUser(req).catch(() => null);
  if (!found || found.user.id !== flow.uid) return fail('expired');
  const { row } = found;
  const { profile } = grant;
  if (!grant.scopes.includes(GMAIL_SCOPE)) return fail('no_gmail');
  if (!grant.refreshToken) return fail('failed');
  if (row.google_sub && row.google_sub !== profile.sub) {
    await revoke(grant.refreshToken);
    return fail('other_account');
  }
  const [taken] = await query('SELECT id FROM users WHERE (google_sub = ? OR email = ?) AND id <> ?', [profile.sub, profile.email, row.id]);
  if (taken) {
    await revoke(grant.refreshToken);
    return fail('other_account');
  }
  const now = new Date();
  await query(
    'UPDATE users SET gmail_token = ?, gmail_connected_at = ?, gmail_error = NULL, google_sub = ?, email = COALESCE(email, ?), name = COALESCE(name, ?), picture = COALESCE(picture, ?) WHERE id = ?',
    [seal(grant.refreshToken), now, profile.sub, profile.email, profile.name, profile.picture, row.id],
  );
  // First read in the background, so her alerts are there when she looks.
  readGmail({ userId: row.id }).catch((err) => console.error('Gmail sync failed:', err.message));
  return res.redirect('/?gmail=connected#/settings');
}

// Hostinger cron: curl "https://site/api/cron/fetch-jobs?key=CRON_SECRET" (or X-Cron-Key header)
export function requireCronKey(req, res, next) {
  if (!config.cronSecret) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  const key = req.get('x-cron-key') || req.query.key || '';
  if (!safeEqual(key, config.cronSecret)) return res.status(401).json({ error: 'Bad cron key.' });
  return next();
}
