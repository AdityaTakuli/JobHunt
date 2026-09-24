import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { usageToday } from '../lib/aiBudget.js';
import { mailConfigured } from '../lib/mailer.js';
import { getPublicSettings, saveSettings, validateSettings } from '../lib/settings.js';
import { runTask, TASKS } from '../tasks/index.js';
import { localSearchesThisMonth } from '../tasks/fetchJobs.js';

export const settingsRouter = Router();

settingsRouter.get('/settings', async (req, res) => {
  res.json({ settings: await getPublicSettings() });
});

settingsRouter.put('/settings', async (req, res) => {
  const { values, error } = validateSettings(req.body || {});
  if (error) return res.status(400).json({ error });
  await saveSettings(values);
  res.json({ settings: await getPublicSettings() });
});

const aiStatus = (name, today) => {
  const { apiKey, model, limits } = config[name];
  return {
    configured: Boolean(apiKey),
    model,
    today: today[name] || { requests: 0, tokens: 0 },
    dailyTokens: limits.dailyTokens,
    dailyRequests: limits.dailyRequests,
  };
};

// Health of each source: what is configured, last run, recent errors, SerpApi quota, AI budget.
settingsRouter.get('/system', async (req, res) => {
  const [recent, searchesUsed, today] = await Promise.all([
    query('SELECT id, source, run_at, jobs_found, jobs_new, requests_used, error FROM fetch_log ORDER BY run_at DESC, id DESC LIMIT 40'),
    localSearchesThisMonth(),
    usageToday(),
  ]);
  res.json({
    configured: {
      serpapi: Boolean(config.serpapi.apiKey),
      groq: Boolean(config.groq.apiKey),
      gemini: Boolean(config.gemini.apiKey),
      imap: Boolean(config.imap.user && config.imap.pass),
      smtp: mailConfigured(),
      scheduler: config.enableScheduler,
      cron: Boolean(config.cronSecret),
    },
    serpapi: { searchesUsedThisMonth: searchesUsed, monthlyLimit: config.serpapi.monthlyLimit, reserve: config.serpapi.reserve },
    groqModel: config.groq.model,
    ai: { groq: aiStatus('groq', today), gemini: aiStatus('gemini', today) },
    fetchLog: recent,
  });
});

// Manual "Run now" buttons on the Settings screen.
settingsRouter.post('/tasks/:task', async (req, res) => {
  if (!TASKS[req.params.task]) return res.status(404).json({ error: 'Unknown task.' });
  res.json(await runTask(req.params.task, { force: true }));
});
