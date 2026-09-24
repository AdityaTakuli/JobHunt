import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { login, logout, me, requireAuth, requireCronKey } from './auth.js';
import { config, ROOT_DIR } from './config.js';
import { applicationsRouter } from './routes/applications.js';
import { firmsRouter } from './routes/firms.js';
import { jobsRouter } from './routes/jobs.js';
import { settingsRouter } from './routes/settings.js';
import { runTask, TASKS } from './tasks/index.js';

const WEB_DIST = path.join(ROOT_DIR, 'web', 'dist');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Hostinger (and most hosts) terminate HTTPS at a proxy.
  app.set('trust proxy', 1);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.post('/api/login', login);
  app.post('/api/logout', logout);
  app.get('/api/me', me);

  // Called by Hostinger cron with ?key=CRON_SECRET. GET so a plain `curl URL` works.
  app.all('/api/cron/:task', requireCronKey, async (req, res) => {
    if (!TASKS[req.params.task]) return res.status(404).json({ error: 'Unknown task.' });
    res.json(await runTask(req.params.task, { force: req.query.force === '1' }));
  });

  app.use('/api', requireAuth);
  app.use('/api/jobs', jobsRouter);
  app.use('/api/applications', applicationsRouter);
  app.use('/api/firms', firmsRouter);
  app.use('/api', settingsRouter);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  // React app (built by `npm run build`).
  if (fs.existsSync(WEB_DIST)) {
    app.use(express.static(WEB_DIST, { index: false, maxAge: '1h' }));
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
