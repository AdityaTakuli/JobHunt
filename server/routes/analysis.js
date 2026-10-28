import { Router } from 'express';
import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';
import { dbUsageStore } from '../lib/aiBudget.js';
import { ANALYSIS_VERSION, analyseJob, analysisGateways } from '../lib/jobAnalysis.js';
import { LlmError } from '../lib/llm.js';
import { getUserSettings } from '../lib/settings.js';
import { istDateString, startOfIstDay } from '../lib/time.js';

// "Analyse with AI" on a job. The answer is stored per job, so opening it again (by anyone) is free.
export const analysisRouter = Router();
// Ids are whole numbers; anything else ("1 OR 1=1") is simply not found.
analysisRouter.param('id', (req, res, next, id) => (/^\d{1,10}$/.test(id) ? next() : res.status(404).json({ error: 'Not found.' })));

const inFlight = new Map(); // job id -> promise, so two clicks make one call

const MODEL_NAMES = {
  'gpt-oss-120b': 'GPT-OSS 120B',
  'openai/gpt-oss-120b': 'GPT-OSS 120B',
  'gpt-oss-20b': 'GPT-OSS 20B',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
};

function serialize(row) {
  if (!row) return null;
  return {
    ...parseJson(row.analysis, {}),
    model: MODEL_NAMES[row.model] || row.model,
    gateway: row.gateway === 'omniroute' ? 'OmniRoute' : 'FreeLLMAPI',
    created_at: row.created_at,
  };
}

async function usedToday(userId) {
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM job_analyses WHERE created_by = ? AND created_at >= ?', [userId, startOfIstDay()]);
  return Number(n);
}

analysisRouter.get('/:id/analysis', async (req, res) => {
  const [row] = await query('SELECT * FROM job_analyses WHERE job_id = ? AND version = ?', [req.params.id, ANALYSIS_VERSION]);
  res.json({ analysis: serialize(row), available: analysisGateways().length > 0 });
});

analysisRouter.post('/:id/analysis', async (req, res) => {
  const id = Number(req.params.id);
  const refresh = Boolean(req.body?.refresh);
  const [job] = await query('SELECT id, title, company, city, location_text, salary_text, description FROM jobs WHERE id = ?', [id]);
  if (!job) return res.status(404).json({ error: 'Job not found.' });

  const [stored] = await query('SELECT * FROM job_analyses WHERE job_id = ? AND version = ?', [id, ANALYSIS_VERSION]);
  if (stored && !refresh) return res.json({ analysis: serialize(stored) });
  if (!analysisGateways().length) return res.status(503).json({ error: 'AI analysis is not set up on this server.' });
  if ((await usedToday(req.user.id)) >= config.analysis.dailyPerPerson) {
    return res.status(429).json({ error: `You have used today's ${config.analysis.dailyPerPerson} AI analyses. More tomorrow.` });
  }

  if (!inFlight.has(id)) {
    const run = (async () => {
      const { cities } = await getUserSettings(req.user.id);
      const result = await analyseJob(job, {
        cities,
        // Counted with the labeling budget, so analyses can't starve the daily job labels.
        onUsage: (provider, tokens) => (provider === 'freellm' && tokens ? dbUsageStore.add('freellm', istDateString(), tokens).catch(() => {}) : null),
      });
      const row = {
        job_id: id,
        analysis: JSON.stringify(result.analysis),
        version: ANALYSIS_VERSION,
        gateway: result.gateway,
        model: result.model.slice(0, 80),
        tokens: result.tokens,
        created_by: req.user.id,
        created_at: new Date(),
      };
      await query('INSERT INTO job_analyses SET ? ON DUPLICATE KEY UPDATE ?', [row, row]);
      return row;
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, run);
  }

  try {
    res.json({ analysis: serialize(await inFlight.get(id)) });
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    console.warn(`Job analysis ${id} failed: ${err.message}`);
    const busy = err.kind === 'rate_limit' || err.status === 429;
    res.status(503).json({ error: busy ? 'The free AI models are busy right now. Try again in a minute.' : 'The AI could not analyse this job right now. Try again in a minute.' });
  }
});
