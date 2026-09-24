// MVP auth: one shared password, exchanged for an HMAC-signed, HttpOnly session cookie.
import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'aj_session';
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;
const failures = new Map(); // ip -> { count, until }

const authEnabled = () => Boolean(config.auth.password);

function secret() {
  // Without SESSION_SECRET, sessions are tied to the password: changing it logs everyone out.
  return config.auth.sessionSecret || crypto.createHash('sha256').update(`archjobs:${config.auth.password}`).digest('hex');
}

const sign = (payload) => crypto.createHmac('sha256', secret()).update(payload).digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createSessionToken(now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ exp: now + config.auth.sessionDays * 86_400_000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifySessionToken(token, now = Date.now()) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, sign(payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return typeof exp === 'number' && exp > now;
  } catch {
    return false;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function cookieHeader(value, maxAgeSeconds) {
  return [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    config.isProduction ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export function isAuthenticated(req) {
  if (!authEnabled()) return !config.isProduction;
  return verifySessionToken(readCookie(req, COOKIE));
}

export function requireAuth(req, res, next) {
  if (!authEnabled() && config.isProduction) {
    return res.status(503).json({ error: 'APP_PASSWORD is not configured on the server.' });
  }
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: 'Please log in.' });
}

export function login(req, res) {
  const ip = req.ip || 'unknown';
  const state = failures.get(ip);
  if (state?.until > Date.now()) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }
  if (!authEnabled()) {
    return config.isProduction
      ? res.status(503).json({ error: 'APP_PASSWORD is not configured on the server.' })
      : res.json({ ok: true });
  }
  if (!safeEqual(req.body?.password ?? '', config.auth.password)) {
    const count = (state?.count || 0) + 1;
    failures.set(ip, { count: count >= MAX_FAILS ? 0 : count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    return res.status(401).json({ error: 'Wrong password.' });
  }
  failures.delete(ip);
  res.setHeader('Set-Cookie', cookieHeader(createSessionToken(), config.auth.sessionDays * 86_400));
  return res.json({ ok: true });
}

export function logout(req, res) {
  res.setHeader('Set-Cookie', cookieHeader('', 0));
  res.json({ ok: true });
}

export function me(req, res) {
  res.json({ authenticated: isAuthenticated(req), authRequired: authEnabled() || config.isProduction });
}

// Hostinger cron: curl "https://site/api/cron/fetch-jobs?key=CRON_SECRET" (or X-Cron-Key header)
export function requireCronKey(req, res, next) {
  if (!config.cronSecret) return res.status(503).json({ error: 'CRON_SECRET is not configured.' });
  const key = req.get('x-cron-key') || req.query.key || '';
  if (!safeEqual(key, config.cronSecret)) return res.status(401).json({ error: 'Bad cron key.' });
  return next();
}
