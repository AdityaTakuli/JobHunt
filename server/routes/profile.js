// A person's CV and portfolio: upload, read with AI into a profile, edit, delete. The profile
// feeds the fit score on every job (lib/fit.js). Files are stored outside the web root and only
// their owner can see or delete them.

import express, { Router } from 'express';
import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';
import { dbUsageStore } from '../lib/aiBudget.js';
import { gapSummary, scoreFit } from '../lib/fit.js';
import { LlmError } from '../lib/llm.js';
import { openPdf, PdfError } from '../lib/pdf.js';
import { applyProfileEdits, PROFILE_VERSION } from '../lib/profile.js';
import { buildProfile, profileAvailable } from '../lib/profileBuild.js';
import { getRow, invalidate, PROFILE_KINDS, readFile, removeFile, saveFile, upsertRow } from '../lib/profileStore.js';
import { STILL_OPEN } from '../lib/deadline.js';
import { istDateString } from '../lib/time.js';

export const profileRouter = Router();

const building = new Map(); // user id -> { promise, step }

const MB = 1024 * 1024;
const limits = () => ({ resume: config.profile.maxResumeMb * MB, portfolio: config.profile.maxPortfolioMb * MB });

function serialize(row, uid) {
  const b = building.get(uid);
  return {
    available: profileAvailable(),
    status: b ? 'building' : row?.status || 'empty',
    step: b?.step || null,
    error: row?.error || null,
    // The last good profile stays visible while a new read runs or after one fails.
    profile: row?.profile ? parseJson(row.profile, null) : null,
    resume: row?.resume_uploaded_at ? { name: row.resume_name, size: row.resume_size, pages: row.resume_pages, uploaded_at: row.resume_uploaded_at } : null,
    portfolio: row?.portfolio_uploaded_at ? { name: row.portfolio_name, size: row.portfolio_size, pages: row.portfolio_pages, uploaded_at: row.portfolio_uploaded_at } : null,
    built_at: row?.built_at || null,
    model: row?.model || null,
    warnings: parseJson(row?.warnings, []),
    limits: { resumeMb: config.profile.maxResumeMb, portfolioMb: config.profile.maxPortfolioMb, portfolioPages: config.profile.maxPortfolioPages, buildsPerDay: config.profile.dailyBuilds },
    builds_today: row?.builds_on === istDateString() || (row?.builds_on instanceof Date && istDateString(row.builds_on) === istDateString()) ? Number(row.builds_count || 0) : 0,
  };
}

async function buildsToday(row) {
  const today = istDateString();
  const on = row?.builds_on ? (row.builds_on instanceof Date ? istDateString(row.builds_on) : String(row.builds_on).slice(0, 10)) : null;
  return on === today ? Number(row.builds_count || 0) : 0;
}

// Reads whatever files are stored and replaces the profile. Runs in the background; GET /profile
// reports the step while it runs.
function startBuild(uid) {
  if (building.has(uid)) return building.get(uid).promise;
  const state = { step: 'Starting', promise: null };
  state.promise = (async () => {
    const [resume, portfolio] = await Promise.all([readFile(uid, 'resume'), readFile(uid, 'portfolio')]);
    const row = await getRow(uid);
    const today = istDateString();
    const count = (await buildsToday(row)) + 1;
    await upsertRow(uid, { status: 'building', error: null, builds_on: today, builds_count: count });
    try {
      const result = await buildProfile(
        { resume, portfolio },
        {
          onProgress: (step) => (state.step = step),
          onUsage: (provider, tokens) => (provider === 'freellm' && tokens ? dbUsageStore.add('freellm', today, tokens).catch(() => {}) : null),
        },
      );
      await upsertRow(uid, {
        status: 'ready',
        error: null,
        profile: JSON.stringify(result.profile),
        pages: result.pages ? JSON.stringify(result.pages) : null,
        warnings: JSON.stringify(result.warnings),
        model: result.models.join(', ').slice(0, 120),
        tokens: result.tokens,
        version: PROFILE_VERSION,
        built_at: new Date(),
      });
    } catch (err) {
      const message = err instanceof LlmError || err instanceof PdfError ? err.message : 'The profile could not be built. Try again in a few minutes.';
      if (!(err instanceof LlmError) && !(err instanceof PdfError)) console.error(`Profile build for user ${uid} failed:`, err);
      await upsertRow(uid, { status: 'error', error: message.slice(0, 300) });
    } finally {
      building.delete(uid);
      invalidate(uid);
    }
  })();
  building.set(uid, state);
  return state.promise;
}

profileRouter.get('/', async (req, res) => {
  res.json(serialize(await getRow(req.user.id), req.user.id));
});

// The PDF itself is the request body (Content-Type: application/pdf); the name comes in a header.
profileRouter.put('/:kind', express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: `${config.profile.maxPortfolioMb + 1}mb` }), async (req, res) => {
  const { kind } = req.params;
  const uid = req.user.id;
  if (!PROFILE_KINDS.includes(kind)) return res.status(404).json({ error: 'Not found.' });
  if (!profileAvailable()) return res.status(503).json({ error: 'Profile reading is not set up on this server (no AI gateway).' });
  if (building.has(uid)) return res.status(409).json({ error: 'Your profile is being built right now. Wait for it to finish.' });
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || !buffer.length) return res.status(400).json({ error: 'Send the PDF as the request body.' });
  if (buffer.length > limits()[kind]) return res.status(413).json({ error: `The ${kind === 'resume' ? 'CV' : 'portfolio'} must be under ${config.profile[kind === 'resume' ? 'maxResumeMb' : 'maxPortfolioMb']} MB. Export a smaller PDF.` });
  let pages;
  try {
    const pdf = openPdf(buffer);
    pages = pdf.pages;
    pdf.close();
  } catch (err) {
    return res.status(400).json({ error: err instanceof PdfError ? err.message : 'This file could not be read as a PDF.' });
  }
  const row = await getRow(uid);
  if ((await buildsToday(row)) >= config.profile.dailyBuilds) {
    return res.status(429).json({ error: `You have used today's ${config.profile.dailyBuilds} profile reads. More tomorrow.` });
  }
  const name = String(req.get('x-file-name') || `${kind}.pdf`)
    .replace(/[^\w .()-]+/g, '_')
    .slice(0, 200);
  await saveFile(uid, kind, buffer);
  await upsertRow(uid, { [`${kind}_name`]: name, [`${kind}_size`]: buffer.length, [`${kind}_pages`]: Math.min(pages, 65_000), [`${kind}_uploaded_at`]: new Date() });
  startBuild(uid).catch(() => {});
  res.status(202).json(serialize(await getRow(uid), uid));
});

// Read the stored files again (after the models were down, or to apply a newer reader).
profileRouter.post('/build', async (req, res) => {
  const uid = req.user.id;
  const row = await getRow(uid);
  if (!row?.resume_uploaded_at && !row?.portfolio_uploaded_at) return res.status(400).json({ error: 'Upload a CV or a portfolio first.' });
  if (!profileAvailable()) return res.status(503).json({ error: 'Profile reading is not set up on this server (no AI gateway).' });
  if (building.has(uid)) return res.status(409).json({ error: 'Your profile is being built right now.' });
  if ((await buildsToday(row)) >= config.profile.dailyBuilds) return res.status(429).json({ error: `You have used today's ${config.profile.dailyBuilds} profile reads. More tomorrow.` });
  startBuild(uid).catch(() => {});
  res.status(202).json(serialize(await getRow(uid), uid));
});

profileRouter.delete('/:kind', async (req, res) => {
  const { kind } = req.params;
  const uid = req.user.id;
  if (!PROFILE_KINDS.includes(kind)) return res.status(404).json({ error: 'Not found.' });
  if (building.has(uid)) return res.status(409).json({ error: 'Your profile is being built right now. Wait for it to finish.' });
  await removeFile(uid, kind);
  const row = await getRow(uid);
  const other = kind === 'resume' ? row?.portfolio_uploaded_at : row?.resume_uploaded_at;
  await upsertRow(uid, {
    [`${kind}_name`]: null,
    [`${kind}_size`]: null,
    [`${kind}_pages`]: null,
    [`${kind}_uploaded_at`]: null,
    ...(other ? {} : { status: 'empty', profile: null, pages: null, warnings: null, error: null, built_at: null }),
  });
  // What is left is read again so the profile matches the files.
  if (other && profileAvailable() && (await buildsToday(await getRow(uid))) < config.profile.dailyBuilds) startBuild(uid).catch(() => {});
  res.json(serialize(await getRow(uid), uid));
});

// Corrections to the extracted profile (software, skills, cities, stage...).
profileRouter.patch('/', async (req, res) => {
  const uid = req.user.id;
  const row = await getRow(uid);
  if (row?.status !== 'ready') return res.status(400).json({ error: 'No profile to edit yet.' });
  const profile = applyProfileEdits(parseJson(row.profile, {}), req.body || {});
  await upsertRow(uid, { profile: JSON.stringify(profile) });
  res.json(serialize(await getRow(uid), uid));
});

// What the open roles most often ask for that the profile lacks: what to fix first.
profileRouter.get('/gaps', async (req, res) => {
  const uid = req.user.id;
  const row = await getRow(uid);
  const profile = row?.status === 'ready' ? parseJson(row.profile, null) : null;
  if (!profile) return res.json({ gaps: [], jobs: 0 });
  const jobs = await query(
    `SELECT j.id, j.title, j.company, j.city, j.description, j.software, j.role_type, j.is_bim, j.exp_min, j.exp_max FROM jobs j
      WHERE j.is_archived = 0 AND ${STILL_OPEN} AND j.is_relevant = 1 AND (j.role_type IS NULL OR j.role_type <> 'experienced')
        AND NOT EXISTS (SELECT 1 FROM job_hides h WHERE h.job_id = j.id AND h.user_id = ?)
      ORDER BY COALESCE(j.posted_at, j.created_at) DESC LIMIT 300`,
    [uid],
  );
  const rows = jobs.map((j) => ({ ...j, software: parseJson(j.software, []) }));
  const fits = rows.map((j) => scoreFit(profile, j));
  const verdicts = { strong: 0, possible: 0, stretch: 0 };
  for (const f of fits) verdicts[f.verdict] += 1;
  res.json({ jobs: rows.length, verdicts, gaps: gapSummary(fits, rows) });
});
