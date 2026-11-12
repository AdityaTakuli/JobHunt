// A person's CV and portfolio: upload, read with AI into a profile, edit, delete. The profile
// feeds the fit score on every job (lib/fit.js). Files are stored outside the web root and only
// their owner can see or delete them.

import express, { Router } from 'express';
import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';
import { dbUsageStore } from '../lib/aiBudget.js';
import { fillFields, FILL_VERSION, sanitizeFields } from '../lib/fill.js';
import { gapSummary, scoreFit } from '../lib/fit.js';
import { factsFor } from '../lib/fitCache.js';
import { LlmError } from '../lib/llm.js';
import { findOtp } from '../lib/otp.js';
import { findUser } from '../lib/users.js';
import { openPdf, PdfError } from '../lib/pdf.js';
import { cleanDetails, DISCIPLINES, GENDERS, hasDetails, missingEssentials, prefillDetails } from '../lib/details.js';
import { applyProfileEdits, PROFILE_VERSION } from '../lib/profile.js';
import { contactOf, GENERAL_KEY, renderPdf } from '../lib/tailor.js';
import { askJson, buildProfile, profileAvailable } from '../lib/profileBuild.js';
import { getRow, invalidate, PROFILE_KINDS, readFile, removeFile, saveFile, upsertRow } from '../lib/profileStore.js';
import { STILL_OPEN } from '../lib/deadline.js';
import { istDateString } from '../lib/time.js';

export const profileRouter = Router();

const building = new Map(); // user id -> { promise, step }

const MB = 1024 * 1024;
const limits = () => ({ resume: config.profile.maxResumeMb * MB, portfolio: config.profile.maxPortfolioMb * MB });

function serialize(row, uid, account = {}) {
  const b = building.get(uid);
  const profileJson = row?.profile ? parseJson(row.profile, null) : null;
  const details = prefillDetails(parseJson(row?.details, null), profileJson, account);
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
    builds_today: countToday(row, 'builds'),
    fills_today: countToday(row, 'fills'),
    fills_per_day: config.profile.dailyFills,
    // "Application details": saved values, else what the CV gave, for the form to start from.
    details,
    details_saved: hasDetails(parseJson(row?.details, null)),
    details_missing: missingEssentials(details),
    details_options: { disciplines: DISCIPLINES, genders: GENDERS },
  };
}

// How many of today's (IST) builds or fills the row has counted.
function countToday(row, kind) {
  const today = istDateString();
  const raw = row?.[`${kind}_on`];
  const on = raw ? (raw instanceof Date ? istDateString(raw) : String(raw).slice(0, 10)) : null;
  return on === today ? Number(row[`${kind}_count`] || 0) : 0;
}
const buildsToday = async (row) => countToday(row, 'builds');
const fillsToday = (row) => countToday(row, 'fills');

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
    // Page notes stored from an earlier read of this same portfolio file (an upload clears them):
    // a re-read only sends the pages that failed last time.
    const knownPages = portfolio ? parseJson(row?.pages, null) : null;
    try {
      const result = await buildProfile(
        { resume, portfolio },
        {
          knownPages: Array.isArray(knownPages) ? knownPages : null,
          onProgress: (step) => (state.step = step),
          onUsage: (provider, tokens) => (provider === 'freellm' && tokens ? dbUsageStore.add('freellm', today, tokens).catch(() => {}) : null),
        },
      );
      await upsertRow(uid, {
        status: 'ready',
        error: null,
        profile: JSON.stringify(result.profile),
        pages: result.pages ? JSON.stringify(result.pages) : null,
        resume_text: result.resumeText || null,
        warnings: JSON.stringify(result.warnings),
        model: result.models.join(', ').slice(0, 120),
        tokens: result.tokens,
        version: PROFILE_VERSION,
        built_at: new Date(),
      });
    } catch (err) {
      const message = err instanceof LlmError || err instanceof PdfError ? err.message : 'The profile could not be built. Try again in a few minutes.';
      if (!(err instanceof LlmError) && !(err instanceof PdfError)) console.error(`Profile build for user ${uid} failed:`, err);
      // Pages that were read before the failure are kept for the next try.
      await upsertRow(uid, { status: 'error', error: message.slice(0, 300), ...(Array.isArray(err.pages) && err.pages.length ? { pages: JSON.stringify(err.pages) } : {}) });
    } finally {
      building.delete(uid);
      invalidate(uid);
    }
  })();
  building.set(uid, state);
  return state.promise;
}

const acct = (req) => ({ name: req.user.name, email: req.user.email });

profileRouter.get('/', async (req, res) => {
  res.json(serialize(await getRow(req.user.id), req.user.id, acct(req)));
});

// "Application details" (the popup form): what ARCH in Chrome fills forms with. Saved apart from
// the AI-read profile, so it works before any CV is uploaded and survives a re-read.
profileRouter.put('/details', async (req, res) => {
  const uid = req.user.id;
  const details = cleanDetails(req.body || {});
  await upsertRow(uid, { details: JSON.stringify(details) });
  const row = await getRow(uid);
  // Name and contact also correct the profile, so the fit score and old screens agree.
  if (row?.status === 'ready' && row.profile) {
    const p = parseJson(row.profile, {});
    const edited = applyProfileEdits(p, { ...(details.name ? { name: details.name } : {}), contact: Object.fromEntries(['email', 'phone', 'linkedin', 'website', 'city', 'address', 'date_of_birth'].filter((k) => details[k]).map((k) => [k, details[k]])) });
    await upsertRow(uid, { profile: JSON.stringify(edited) });
  }
  const sent = req.body && typeof req.body === 'object' ? req.body : {};
  const rejected = Object.keys(details).filter((k) => typeof sent[k] === 'string' && sent[k].trim() && !details[k]);
  res.json({ ...serialize(await getRow(uid), uid, acct(req)), rejected });
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
    const pdf = await openPdf(buffer);
    pages = pdf.pages;
    pdf.close();
  } catch (err) {
    return res.status(400).json({ error: err instanceof PdfError ? err.message : 'This file could not be read as a PDF.' });
  }
  const row = await getRow(uid);
  if ((await buildsToday(row)) >= config.profile.dailyBuilds) {
    return res.status(429).json({ error: `You have used today's ${config.profile.dailyBuilds} profile reads. More tomorrow.` });
  }
  // The browser sends the name URI-encoded (headers are ASCII); decode it, then keep it plain.
  let rawName = String(req.get('x-file-name') || `${kind}.pdf`);
  try {
    rawName = decodeURIComponent(rawName);
  } catch {
    // not encoded, or a stray %: keep as sent
  }
  const name = rawName.replace(/[^\p{L}\p{N} .()_-]+/gu, '_').slice(0, 200) || `${kind}.pdf`;
  await saveFile(uid, kind, buffer);
  await upsertRow(uid, {
    [`${kind}_name`]: name,
    [`${kind}_size`]: buffer.length,
    [`${kind}_pages`]: Math.min(pages, 65_000),
    [`${kind}_uploaded_at`]: new Date(),
    // Page notes belong to the old file.
    ...(kind === 'portfolio' ? { pages: null } : {}),
  });
  startBuild(uid).catch(() => {});
  res.status(202).json(serialize(await getRow(uid), uid, acct(req)));
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
  res.status(202).json(serialize(await getRow(uid), uid, acct(req)));
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
    ...(kind === 'resume' ? { resume_text: null } : {}),
    ...(other ? {} : { status: 'empty', profile: null, pages: null, warnings: null, error: null, built_at: null }),
  });
  // What is left is read again so the profile matches the files.
  if (other && profileAvailable() && (await buildsToday(await getRow(uid))) < config.profile.dailyBuilds) startBuild(uid).catch(() => {});
  res.json(serialize(await getRow(uid), uid, acct(req)));
});

// Corrections to the extracted profile (software, skills, cities, stage...).
profileRouter.patch('/', async (req, res) => {
  const uid = req.user.id;
  const row = await getRow(uid);
  if (row?.status !== 'ready') return res.status(400).json({ error: 'No profile to edit yet.' });
  const profile = applyProfileEdits(parseJson(row.profile, {}), req.body || {});
  await upsertRow(uid, { profile: JSON.stringify(profile) });
  res.json(serialize(await getRow(uid), uid, acct(req)));
});

// ---- ARCH in Chrome (extension/) ----

const fileLabel = (kind) => (kind === 'resume' ? 'CV' : 'portfolio');

function sendPdf(res, name, buffer) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
}

// The latest general CV ArchJobs wrote ("My CV" on the Profile page) as a PDF, or null.
async function generalCvPdf(req, row) {
  const [doc] = await query('SELECT resume FROM tailored_docs WHERE user_id = ? AND page_key = ? ORDER BY id DESC LIMIT 1', [req.user.id, GENERAL_KEY]);
  const resume = doc ? parseJson(doc.resume, null) : null;
  if (!resume) return null;
  const profile = parseJson(row?.profile, {}) || {};
  const buffer = await renderPdf('resume', { resume, contact: contactOf(profile, acct(req), parseJson(row?.details, null)) });
  const who = String(resume.name || 'CV').replace(/[^\p{L}\p{N} ]+/gu, '').trim().replace(/\s+/g, '_') || 'CV';
  return { name: `${who}_CV.pdf`, buffer };
}

// What the extension shows in its popup: who is signed in and whether there is a profile to fill from.
profileRouter.get('/extension', async (req, res) => {
  const row = await getRow(req.user.id);
  const details = parseJson(row?.details, null);
  // Saved details alone are enough to fill the usual fields (name, email, college...).
  const ready = (row?.status === 'ready' && Boolean(row.profile)) || hasDetails(details);
  const [general] = await query('SELECT id FROM tailored_docs WHERE user_id = ? AND page_key = ? ORDER BY id DESC LIMIT 1', [req.user.id, GENERAL_KEY]);
  res.json({
    version: FILL_VERSION,
    user: { name: req.user.name, email: req.user.email },
    ready,
    details: hasDetails(details),
    details_missing: missingEssentials(prefillDetails(details, parseJson(row?.profile, null), acct(req))),
    general_cv: Boolean(general),
    status: building.has(req.user.id) ? 'building' : row?.status || 'empty',
    resume: Boolean(row?.resume_uploaded_at),
    portfolio: Boolean(row?.portfolio_uploaded_at),
    ai: profileAvailable(),
    fills: { today: fillsToday(row), limit: config.profile.dailyFills },
  });
});

// The stored PDF, so the extension can drop it into a form's upload box.
profileRouter.get('/file/:kind', async (req, res) => {
  const { kind } = req.params;
  if (!PROFILE_KINDS.includes(kind)) return res.status(404).json({ error: 'Not found.' });
  const row = await getRow(req.user.id);
  const buffer = row?.[`${kind}_uploaded_at`] ? await readFile(req.user.id, kind) : null;
  // No CV uploaded (a student with only a portfolio): the CV ArchJobs wrote for them.
  if (!buffer && kind === 'resume') {
    const pdf = await generalCvPdf(req, row);
    if (pdf) return sendPdf(res, pdf.name, pdf.buffer);
  }
  if (!buffer) return res.status(404).json({ error: `No ${fileLabel(kind)} uploaded.` });
  const name = String(row[`${kind}_name`] || `${kind}.pdf`).replace(/["\r\n]/g, '');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(buffer);
});

// Answers for the fields of an application form. Body: { page: { url, title, text }, fields: [...],
// ai: bool }. Rule answers are free; the AI call counts against the daily limit.
profileRouter.post('/fill', async (req, res) => {
  const uid = req.user.id;
  const row = await getRow(uid);
  const profile = row?.status === 'ready' ? parseJson(row.profile, null) : null;
  const details = parseJson(row?.details, null);
  if (!profile && !hasDetails(details)) return res.status(400).json({ error: 'Fill in your application details (or upload your CV) in ArchJobs first, so there is something to fill from.' });
  const fields = sanitizeFields(req.body?.fields);
  if (!fields.length) return res.status(400).json({ error: 'No fields to fill.' });
  const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const page = { url: str(req.body?.page?.url, 500), title: str(req.body?.page?.title, 200), text: str(req.body?.page?.text, 4_000) };
  const wantAi = req.body?.ai !== false && profileAvailable();
  const used = fillsToday(row);
  const aiAllowed = wantAi && used < config.profile.dailyFills;
  const today = istDateString();
  let aiUsed = false;
  // A CV tailored to this posting (ARCH's "Tailor" button) is attached instead of the stored one.
  let tailored = null;
  if (/^\d{1,10}$/.test(String(req.body?.tailoredId ?? ''))) {
    const [t] = await query('SELECT id, cover_letter FROM tailored_docs WHERE id = ? AND user_id = ?', [Number(req.body.tailoredId), uid]);
    if (t) tailored = { id: t.id, cover_letter: parseJson(t.cover_letter, null) };
  }
  const [general] = await query('SELECT id FROM tailored_docs WHERE user_id = ? AND page_key = ? LIMIT 1', [uid, GENERAL_KEY]);
  const result = await fillFields({
    profile,
    details,
    account: { name: req.user.name, email: req.user.email },
    resumeText: row?.resume_text ? String(row.resume_text).slice(0, 8_000) : null,
    page,
    fields,
    files: {
      resume: Boolean(row.resume_uploaded_at) || Boolean(tailored) || Boolean(general),
      portfolio: Boolean(row?.portfolio_uploaded_at),
      letter: Boolean(tailored?.cover_letter),
      library: await query('SELECT id, kind FROM user_documents WHERE user_id = ? ORDER BY uploaded_at DESC', [uid]),
    },
    coverLetter: tailored?.cover_letter ? [tailored.cover_letter.greeting, ...tailored.cover_letter.paragraphs, tailored.cover_letter.sign_off].join('\n\n') : null,
    useAi: aiAllowed,
    ask: async (call) => {
      aiUsed = true;
      return askJson({
        ...call,
        cfg: { ...config, profile: { ...config.profile, timeoutMs: config.profile.fillTimeoutMs } },
        onUsage: (provider, tokens) => (provider === 'freellm' && tokens ? dbUsageStore.add('freellm', today, tokens).catch(() => {}) : null),
      });
    },
  });
  if (aiUsed) await upsertRow(uid, { fills_on: today, fills_count: used + 1 });
  res.json({
    ...result,
    ai: { ...result.ai, used: aiUsed, limited: wantAi && !aiAllowed, today: used + (aiUsed ? 1 : 0), limit: config.profile.dailyFills },
    files: { resume: Boolean(row?.resume_uploaded_at) || Boolean(general), portfolio: Boolean(row?.portfolio_uploaded_at) },
    tailoredId: tailored?.id || null,
  });
});

// "Get code from Gmail" in ARCH in Chrome: the one-time code a site just emailed (?host=the site).
// Pressed by hand, mail from the last 15 minutes only, a few times an hour at most.
const otpAsks = new Map(); // user id -> times asked in the last hour
profileRouter.get('/otp', async (req, res) => {
  const uid = req.user.id;
  const recent = (otpAsks.get(uid) || []).filter((t) => Date.now() - t < 3_600_000);
  if (recent.length >= 20) return res.status(429).json({ error: 'Too many code look-ups this hour. Open Gmail instead.' });
  otpAsks.set(uid, [...recent, Date.now()]);
  const host = typeof req.query.host === 'string' ? req.query.host.slice(0, 200) : '';
  try {
    const found = await findOtp(await findUser(uid), host);
    if (found.error) return res.status(404).json({ error: found.error });
    res.json(found);
  } catch (err) {
    console.warn(`Code look-up for user ${uid} failed: ${err.message}`);
    res.status(502).json({ error: 'Gmail could not be read just now. Open Gmail instead.' });
  }
});

// What the open roles most often ask for that the profile lacks: what to fix first.
profileRouter.get('/gaps', async (req, res) => {
  const uid = req.user.id;
  const row = await getRow(uid);
  const profile = row?.status === 'ready' ? parseJson(row.profile, null) : null;
  if (!profile) return res.json({ gaps: [], jobs: 0 });
  const jobs = await query(
    `SELECT j.id, j.title, j.company, j.city, j.software, j.role_type, j.is_bim, j.exp_min, j.exp_max, j.updated_at FROM jobs j
      WHERE j.is_archived = 0 AND ${STILL_OPEN} AND j.is_relevant = 1 AND (j.role_type IS NULL OR j.role_type <> 'experienced')
        AND NOT EXISTS (SELECT 1 FROM job_hides h WHERE h.job_id = j.id AND h.user_id = ?)
      ORDER BY COALESCE(j.posted_at, j.created_at) DESC LIMIT 300`,
    [uid],
  );
  const rows = jobs.map((j) => ({ ...j, software: parseJson(j.software, []) }));
  const facts = await factsFor(rows);
  const fits = rows.map((j) => scoreFit(profile, j, null, facts.get(j.id)));
  const verdicts = { strong: 0, possible: 0, stretch: 0 };
  for (const f of fits) verdicts[f.verdict] += 1;
  res.json({ jobs: rows.length, verdicts, gaps: gapSummary(fits, rows) });
});
