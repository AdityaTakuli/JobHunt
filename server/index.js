import fs from 'node:fs';
import path from 'node:path';
import { createApp } from './app.js';
import { config, ROOT_DIR } from './config.js';
import { closePool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { startScheduler } from './scheduler.js';

function warnAboutConfig() {
  const missing = [];
  if (!config.auth.password) missing.push(config.isProduction ? 'APP_PASSWORD (API is locked until set)' : 'APP_PASSWORD (auth off in dev)');
  if (!config.serpapi.apiKey) missing.push('SERPAPI_KEY (no Google Jobs fetch)');
  if (!config.groq.apiKey && !config.gemini.apiKey) missing.push('GROQ_API_KEY/GEMINI_API_KEY (rule classifier only)');
  if (!config.imap.user) missing.push('IMAP_USER/IMAP_PASSWORD (no LinkedIn alerts)');
  if (!config.smtp.user) missing.push('SMTP_USER/SMTP_PASSWORD (no digest email)');
  if (missing.length) console.warn(`Not configured: ${missing.join('; ')}`);
}

// Hosts that skip the build step (or run it elsewhere) would otherwise serve no web app, so
// build it here when it is missing. Takes a few seconds, once per deploy.
async function ensureWebBuild() {
  const index = path.join(ROOT_DIR, 'web', 'dist', 'index.html');
  if (fs.existsSync(index)) return;
  console.log('web/dist is missing: building the web app…');
  try {
    const { build } = await import('vite');
    await build({ configFile: path.join(ROOT_DIR, 'vite.config.js'), logLevel: 'warn' });
    console.log('Web app built.');
  } catch (err) {
    console.error(`Web build failed, serving the API only: ${err.message}`);
  }
}

async function main() {
  // Tables are created with IF NOT EXISTS, so running this on every boot is safe.
  await migrate();
  await ensureWebBuild();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`ArchJobs listening on http://localhost:${config.port}`);
    warnAboutConfig();
  });
  const tasks = config.enableScheduler ? startScheduler() : [];
  if (tasks.length) console.log(`Scheduler on: ${tasks.length} tasks (Asia/Kolkata).`);

  const shutdown = async () => {
    tasks.forEach((t) => t.stop());
    server.close();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});
