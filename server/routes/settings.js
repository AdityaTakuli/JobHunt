import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { usageToday } from '../lib/aiBudget.js';
import { providerConfigured } from '../lib/classify.js';
import { mailConfigured } from '../lib/mailer.js';
import { requireAdmin } from '../auth.js';
import { getPublicSettings, saveSettings, saveUserSettings, validateSettings } from '../lib/settings.js';
import { runTask, TASKS } from '../tasks/index.js';
import { localSearchesThisMonth } from '../tasks/fetchJobs.js';

export const settingsRouter = Router();

settingsRouter.get('/settings', async (req, res) => {
  res.json({ settings: await getPublicSettings(req.user) });
});

settingsRouter.put('/settings', async (req, res) => {
  const { values, shared, error } = validateSettings(req.body || {}, { isAdmin: req.user.isAdmin });
  if (error) return res.status(400).json({ error });
  await saveUserSettings(req.user.id, values);
  await saveSettings(shared);
  res.json({ settings: await getPublicSettings(req.user) });
});

const aiStatus = (name, today) => {
  const { model, limits } = config[name];
  return {
    configured: providerConfigured(config[name]),
    model,
    today: today[name] || { requests: 0, tokens: 0 },
    dailyTokens: limits.dailyTokens,
    dailyRequests: limits.dailyRequests,
  };
};

// Health of each source: what is configured, last run, recent errors, SerpApi quota, AI budget.
settingsRouter.get('/system', requireAdmin, async (req, res) => {
  const [recent, searchesUsed, today] = await Promise.all([
    query('SELECT id, source, run_at, jobs_found, jobs_new, requests_used, error FROM fetch_log ORDER BY run_at DESC, id DESC LIMIT 40'),
    localSearchesThisMonth(),
    usageToday(),
  ]);
  res.json({
    configured: {
      serpapi: Boolean(config.serpapi.apiKey),
      freellm: providerConfigured(config.freellm),
      groq: Boolean(config.groq.apiKey),
      gemini: Boolean(config.gemini.apiKey),
      google: Boolean(config.google.clientId && config.google.clientSecret),
      smtp: mailConfigured(),
      scheduler: config.enableScheduler,
      cron: Boolean(config.cronSecret),
    },
    serpapi: { searchesUsedThisMonth: searchesUsed, monthlyLimit: config.serpapi.monthlyLimit, reserve: config.serpapi.reserve },
    groqModel: config.groq.model,
    ai: { freellm: aiStatus('freellm', today), groq: aiStatus('groq', today), gemini: aiStatus('gemini', today) },
    fetchLog: recent,
  });
});

// Manual "Run now" buttons on the Settings screen.
settingsRouter.post('/tasks/:task', requireAdmin, async (req, res) => {
  if (!TASKS[req.params.task]) return res.status(404).json({ error: 'Unknown task.' });
  // "Send now" sends her own digest; the other tasks work on the shared job list.
  res.json(await runTask(req.params.task, { force: true, userId: req.user.id }));
});
