// A CV and cover letter tailored to one posting (lib/tailor.js), for the job details page and for
// ARCH in Chrome. Each one is stored, so the PDFs can be downloaded again and the extension can
// attach the same CV on every page of a form. Only its owner can see it.

import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';
import { logUsage } from '../lib/aiBudget.js';
import { jobUrlPatterns, MIN_POSTING, postingFromJsonLd } from '../lib/jobPage.js';
import { LlmError } from '../lib/llm.js';
import { askJson, profileAvailable } from '../lib/profileBuild.js';
import { getRow } from '../lib/profileStore.js';
import { loadAtsData } from '../lib/atsKeywords.js';
import { contactOf, GENERAL_KEY, renderPdf, tailor, TAILOR_VERSION } from '../lib/tailor.js';
import { istDateString, startOfIstDay } from '../lib/time.js';

export const tailorRouter = Router();
tailorRouter.param('id', (req, res, next, id) => (/^\d{1,10}$/.test(id) ? next() : res.status(404).json({ error: 'Not found.' })));

const inFlight = new Map(); // `${user}:${key}` -> promise

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

// A page with no job in ArchJobs is keyed by its address (host and path, no tracking).
function pageKey(url) {
  try {
    const u = new URL(url);
    return crypto.createHash('sha1').update(`${u.host}${u.pathname.replace(/\/+$/, '')}`).digest('hex');
  } catch {
    return null;
  }
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    title: row.title,
    company: row.company,
    general: row.page_key === GENERAL_KEY,
    resume: parseJson(row.resume, null),
    cover_letter: parseJson(row.cover_letter, null),
    match: parseJson(row.match_info, null),
    dropped: parseJson(row.dropped, []),
    created_at: row.created_at,
    cv_url: `/api/tailor/${row.id}/cv.pdf`,
    letter_url: row.cover_letter ? `/api/tailor/${row.id}/letter.pdf` : null,
  };
}

async function usedToday(uid) {
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM tailored_docs WHERE user_id = ? AND created_at >= ?', [uid, startOfIstDay()]);
  return Number(n);
}

// Which job a request is about, and the posting to tailor to.
async function resolvePosting(body) {
  let job = null;
  if (body.jobId != null && /^\d{1,10}$/.test(String(body.jobId))) {
    [job] = await query('SELECT id, title, company, location_text, city, description FROM jobs WHERE id = ?', [Number(body.jobId)]);
  } else if (body.url) {
    const patterns = jobUrlPatterns(String(body.url));
    if (patterns.length) {
      const where = patterns.map(() => "(apply_url LIKE ? OR JSON_SEARCH(apply_options, 'one', ?, NULL, '$[*].url') IS NOT NULL)").join(' OR ');
      [job] = await query(`SELECT id, title, company, location_text, city, description FROM jobs WHERE ${where} ORDER BY id DESC LIMIT 1`, patterns.flatMap((p) => [p, p]));
    }
  }
  // What the extension read on the page wins when it is longer than what is stored.
  const sent = body.posting && typeof body.posting === 'object' ? body.posting : {};
  const blocks = Array.isArray(sent.jsonld) ? sent.jsonld.filter((b) => typeof b === 'string').slice(0, 10).map((b) => b.slice(0, 200_000)) : [];
  const fromData = postingFromJsonLd(blocks);
  const pageText = typeof sent.text === 'string' ? sent.text.slice(0, 20_000) : '';
  const fromPage = fromData?.description || (pageText.trim().length >= MIN_POSTING ? pageText : '');
  const description = fromPage.length > String(job?.description || '').length ? fromPage : String(job?.description || '');
  return {
    job,
    key: job ? null : pageKey(body.url),
    posting: {
      title: str(job?.title || fromData?.title || sent.title, 200),
      company: str(job?.company || fromData?.company || sent.company, 200),
      location: str(job?.location_text || job?.city || '', 120),
      description,
    },
  };
}

// The latest tailored CV for a job (?jobId=) or a page (?url=), or null.
tailorRouter.get('/', async (req, res) => {
  const uid = req.user.id;
  let row = null;
  if (req.query.jobId && /^\d{1,10}$/.test(String(req.query.jobId))) {
    [row] = await query('SELECT * FROM tailored_docs WHERE user_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1', [uid, Number(req.query.jobId)]);
  } else if (req.query.general) {
    [row] = await query('SELECT * FROM tailored_docs WHERE user_id = ? AND page_key = ? ORDER BY id DESC LIMIT 1', [uid, GENERAL_KEY]);
  } else if (req.query.url) {
    const { job, key } = await resolvePosting({ url: String(req.query.url) });
    if (job) [row] = await query('SELECT * FROM tailored_docs WHERE user_id = ? AND job_id = ? ORDER BY id DESC LIMIT 1', [uid, job.id]);
    else if (key) [row] = await query('SELECT * FROM tailored_docs WHERE user_id = ? AND page_key = ? ORDER BY id DESC LIMIT 1', [uid, key]);
  }
  const used = await usedToday(uid);
  res.json({ tailored: serialize(row), available: profileAvailable(), today: used, limit: config.profile.dailyTailors });
});

// Body: { jobId } or { url, posting: { jsonld, text, title, company } }, and refresh: true for a new one.
tailorRouter.post('/', async (req, res) => {
  const uid = req.user.id;
  const profileRow = await getRow(uid);
  const profile = profileRow?.status === 'ready' ? parseJson(profileRow.profile, null) : null;
  if (!profile) return res.status(400).json({ error: 'Upload your CV or portfolio on the Profile page first: your CV is made from them.' });
  if (!profileAvailable()) return res.status(503).json({ error: 'AI is not set up on this server.' });
  const general = req.body?.general === true;
  const { job, key, posting } = general ? { job: null, key: GENERAL_KEY, posting: null } : await resolvePosting(req.body || {});
  if (!job && !key) return res.status(400).json({ error: 'Say which job: a job in ArchJobs or the page of a posting.' });
  if (!general && !posting.title && posting.description.length < MIN_POSTING) return res.status(400).json({ error: 'There is no posting on this page to tailor to.' });

  if (!req.body?.refresh) {
    const [existing] = job
      ? await query('SELECT * FROM tailored_docs WHERE user_id = ? AND job_id = ? AND version = ? ORDER BY id DESC LIMIT 1', [uid, job.id, TAILOR_VERSION])
      : await query('SELECT * FROM tailored_docs WHERE user_id = ? AND page_key = ? AND version = ? ORDER BY id DESC LIMIT 1', [uid, key, TAILOR_VERSION]);
    if (existing) return res.json({ tailored: serialize(existing), reused: true });
  }
  if ((await usedToday(uid)) >= config.profile.dailyTailors) {
    return res.status(429).json({ error: `You have made today's ${config.profile.dailyTailors} tailored CVs. More tomorrow.` });
  }

  const flightKey = `${uid}:${job ? `j${job.id}` : key}`;
  if (!inFlight.has(flightKey)) {
    const today = istDateString();
    const run = (async () => {
      await loadAtsData(query);
      const result = await tailor({
        profile,
        resumeText: profileRow.resume_text ? String(profileRow.resume_text) : '',
        posting,
        pages: parseJson(profileRow.pages, null),
        details: parseJson(profileRow.details, null),
        account: { name: req.user.name, email: req.user.email },
        ask: (call) =>
          askJson({
            ...call,
            cfg: { ...config, profile: { ...config.profile, timeoutMs: config.profile.tailorTimeoutMs } },
            onUsage: (provider, tokens) => logUsage('tailor', provider, today, tokens),
          }),
      });
      const row = {
        user_id: uid,
        job_id: job?.id || null,
        page_key: key,
        title: posting?.title.slice(0, 200) || null,
        company: posting?.company.slice(0, 200) || null,
        resume: JSON.stringify(result.resume),
        cover_letter: result.cover_letter ? JSON.stringify(result.cover_letter) : null,
        match_info: result.match ? JSON.stringify(result.match) : null,
        dropped: JSON.stringify(result.dropped),
        version: TAILOR_VERSION,
        created_at: new Date(),
      };
      const saved = await query('INSERT INTO tailored_docs SET ?', [row]);
      return { ...row, id: saved.insertId };
    })().finally(() => inFlight.delete(flightKey));
    inFlight.set(flightKey, run);
  }
  try {
    res.json({ tailored: serialize(await inFlight.get(flightKey)) });
  } catch (err) {
    if (!(err instanceof LlmError)) throw err;
    console.warn(`Tailoring for user ${uid} failed: ${err.message}`);
    res.status(503).json({ error: err.kind === 'rate_limit' || err.status === 429 ? 'The free AI models are busy. Try again in a minute.' : 'The AI could not tailor your CV just now. Try again in a minute.' });
  }
});

// The PDFs, drawn on request (a page of text takes a few milliseconds).
tailorRouter.get('/:id/:file', async (req, res) => {
  const kind = { 'cv.pdf': 'resume', 'letter.pdf': 'letter' }[req.params.file];
  if (!kind) return res.status(404).json({ error: 'Not found.' });
  const [row] = await query('SELECT * FROM tailored_docs WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const resume = parseJson(row.resume, null);
  const letter = parseJson(row.cover_letter, null);
  if (!resume || (kind === 'letter' && !letter)) return res.status(404).json({ error: 'Not found.' });
  const profileRow = await getRow(req.user.id);
  const profile = parseJson(profileRow?.profile, {}) || {};
  const pdf = await renderPdf(kind, { resume, letter, contact: contactOf(profile, { name: req.user.name, email: req.user.email }, parseJson(profileRow?.details, null)), posting: { title: row.title, company: row.company } });
  const who = String(resume.name || 'CV').replace(/[^\p{L}\p{N} ]+/gu, '').trim().replace(/\s+/g, '_') || 'CV';
  const firm = String(row.company || '').replace(/[^\p{L}\p{N} ]+/gu, '').trim().replace(/\s+/g, '_');
  const name = `${who}_${kind === 'resume' ? 'CV' : 'Cover_Letter'}${firm ? `_${firm}` : ''}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(pdf);
});
