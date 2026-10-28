import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { googleCallback, googleStart, login, logout, me, requireAuth, requireCronKey } from './auth.js';
import { config, ROOT_DIR } from './config.js';
import { accountRouter } from './routes/account.js';
import { analysisRouter } from './routes/analysis.js';
import { applicationsRouter } from './routes/applications.js';
import { companiesRouter } from './routes/companies.js';
import { firmsRouter } from './routes/firms.js';
import { jobsRouter } from './routes/jobs.js';
import { searchRouter } from './routes/search.js';
import { settingsRouter } from './routes/settings.js';
import { runTask, TASKS } from './tasks/index.js';

const WEB_DIST = path.join(ROOT_DIR, 'web', 'dist');

// Content-Security-Policy: the page runs only its own scripts (plus the small inline theme script
// in index.html, allowed by its hash), talks only to this server, and can't be framed. A job
// title or email text that somehow carried a script would not run.
function contentSecurityPolicy() {
  const hashes = [];
  try {
    const html = fs.readFileSync(path.join(WEB_DIST, 'index.html'), 'utf8');
    for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      hashes.push(`'sha256-${crypto.createHash('sha256').update(body).digest('base64')}'`);
    }
  } catch {
    // No build yet (development with Vite): the API alone needs no scripts.
  }
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    // React and the animation library set style attributes.
    "style-src 'self' 'unsafe-inline'",
    // Company icons and Google profile pictures come from other sites.
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Hostinger (and most hosts) terminate HTTPS at a proxy.
  app.set('trust proxy', 1);

  const csp = contentSecurityPolicy();
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    // Browsers that have seen the site once use HTTPS only (production is HTTPS behind a proxy).
    if (config.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.post('/api/login', login);
  app.post('/api/logout', logout);
  app.get('/api/me', me);
  app.get('/api/auth/google/start', googleStart);
  app.get('/api/auth/google/callback', googleCallback);

  // Called by Hostinger cron with ?key=CRON_SECRET. GET so a plain `curl URL` works.
  app.all('/api/cron/:task', requireCronKey, async (req, res) => {
    if (!Object.hasOwn(TASKS, req.params.task)) return res.status(404).json({ error: 'Unknown task.' });
    res.json(await runTask(req.params.task, { force: req.query.force === '1' }));
  });

  app.use('/api', requireAuth);
  app.use('/api/jobs', analysisRouter);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/applications', applicationsRouter);
  app.use('/api/firms', firmsRouter);
  app.use('/api/companies', companiesRouter);
  app.use('/api', accountRouter);
  app.use('/api', settingsRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // React app (built by `npm run build`).
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
    // Public, for Google's consent screen and anyone not signed in.
    app.get('/privacy', (req, res) => res.sendFile(path.join(WEB_DIST, 'privacy.html')));
    app.get('/{*splat}', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(WEB_DIST, 'index.html'));
    });
  } else {
    app.get('/', (req, res) => res.type('text').send('API running. Build the web app with `npm run build`, or use `npm run dev`.'));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && config.isProduction ? 'Something went wrong.' : err.message });
  });

  return app;
}
