import { Router } from 'express';
import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';
import { dbUsageStore } from '../lib/aiBudget.js';
import { forgetJob } from '../lib/fitCache.js';
import { ANALYSIS_VERSION, analyseJob, analysisGateways } from '../lib/jobAnalysis.js';
import { COMPANIES } from '../lib/companies.js';
import { findPosting, MIN_USEFUL } from '../lib/jobPage.js';
import { LlmError } from '../lib/llm.js';
import { hostOf } from '../lib/normalize.js';
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

// Known firms (lib/companies.js) by the names they hire under.
const FIRMS = COMPANIES.flatMap((c) => c.match.map((m) => [m.toLowerCase(), c]));
function knownFirm(company) {
  const name = String(company || '').toLowerCase();
  if (!name) return null;
  const hit = FIRMS.find(([m]) => name === m || name.startsWith(`${m} `) || name.includes(m));
  return hit ? hit[1] : null;
}

/**
 * The posting and the firm, for the analysis. Jobs from alert emails come with no description:
 * the job page is read (apply link first, then the other places it is listed) and what it says is
 * saved on the job, so the fit score and the next person get it too.
 */
async function postingContext(job) {
  let description = String(job.description || '');
  let sourceHost = null;
  let about = null;
  if (description.length < MIN_USEFUL) {
    const urls = [job.apply_url, ...parseJson(job.apply_options, []).map((o) => o?.url)];
    const posting = await findPosting(urls);
    if (posting && posting.description.length > description.length) {
      description = posting.description.slice(0, 20_000);
      sourceHost = hostOf(posting.url);
      about = posting.companyAbout;
      await query('UPDATE jobs SET description = ?, updated_at = ? WHERE id = ?', [description, new Date(), job.id]).catch((err) =>
        console.warn(`Could not save the posting for job ${job.id}: ${err.message}`),
      );
    }
  } else {
    sourceHost = hostOf(job.apply_url) || null;
  }
  const known = knownFirm(job.company);
  const firm = known || about ? { name: known?.name || job.company, kind: known?.kind || null, note: known?.note || null, about } : null;
  return { job: { ...job, description }, firm, source: description.length >= MIN_USEFUL ? 'posting' : 'none', sourceHost };
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
  const [job] = await query('SELECT id, title, company, city, location_text, salary_text, description, apply_url, apply_options FROM jobs WHERE id = ?', [id]);
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
      const context = await postingContext(job);
      const result = await analyseJob(context.job, {
        cities,
        firm: context.firm,
        source: context.source,
        sourceHost: context.sourceHost,
        // Counted with the labeling budget, so analyses can't starve the daily job labels.
        onUsage: (provider, tokens) => (provider === 'freellm' && tokens ? dbUsageStore.add('freellm', istDateString(), tokens).catch(() => {}) : null),
      });
      const row = {
        job_id: id,
        // Where the posting text came from, so the page can say what the analysis is based on.
        analysis: JSON.stringify({ ...result.analysis, based_on: { posting: context.source === 'posting', host: context.sourceHost, firm: Boolean(context.firm) } }),
        version: ANALYSIS_VERSION,
        gateway: result.gateway,
        model: result.model.slice(0, 80),
        tokens: result.tokens,
        created_by: req.user.id,
        created_at: new Date(),
      };
      await query('INSERT INTO job_analyses SET ? ON DUPLICATE KEY UPDATE ?', [row, row]);
      // The analysis says which requirements are must-haves: the job's fit score is worked out again.
      forgetJob(id);
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
