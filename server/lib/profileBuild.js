// Builds a person's profile from their CV and/or portfolio PDFs with the AI gateways: the CV as
// text, the portfolio as page images read by a vision model a few pages at a time, then one
// text call for the hiring architect's review. Everything is checked (profile.js) before it is
// kept; a batch of pages the models cannot read is skipped rather than failing the whole build.

import { config } from '../config.js';
import { freellmChatUrl, freellmModels } from './freellm.js';
import { LlmError, retryInvalidJsonOnce } from './llm.js';
import { chatJson } from './openaiChat.js';
import { openPdf, pdfText } from './pdf.js';
import {
  mergeProfile,
  PORTFOLIO_PAGES_SYSTEM_PROMPT,
  PORTFOLIO_SUMMARY_SYSTEM_PROMPT,
  RESUME_SYSTEM_PROMPT,
  validatePortfolioPages,
  validatePortfolioSummary,
  validateResumeProfile,
} from './profile.js';

// The gateways for one kind of call (text or vision), best first.
export function profileGateways(kind, cfg = config) {
  const list = kind === 'vision' ? cfg.profile.visionModels : cfg.profile.textModels;
  const out = [];
  if (cfg.omniroute?.url && cfg.omniroute?.apiKey && cfg.profile.omnirouteModels) {
    const m = freellmModels(cfg.profile.omnirouteModels);
    if (m.length && kind === 'text') out.push({ name: 'omniroute', label: 'OmniRoute', url: freellmChatUrl(cfg.omniroute.url), apiKey: cfg.omniroute.apiKey, models: m });
  }
  if (cfg.freellm?.url && cfg.freellm?.apiKey) {
    const m = freellmModels(list);
    if (m.length) out.push({ name: 'freellm', label: 'FreeLLMAPI', url: freellmChatUrl(cfg.freellm.url), apiKey: cfg.freellm.apiKey, models: m });
  }
  return out;
}

export const profileAvailable = (cfg = config) => profileGateways('text', cfg).length > 0;

function parseJsonReply(content, label) {
  try {
    return JSON.parse(String(content || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  } catch {
    throw new LlmError(`${label} returned invalid JSON`, 'invalid_json');
  }
}

// One JSON call tried on each gateway and model in turn. `validate` turns the parsed reply into
// the value to keep, or null when the shape is wrong (which counts as invalid JSON: retried once,
// then the next model).
export async function askJson({ kind = 'text', system, user, validate, maxOutputTokens, cfg = config, fetchImpl = fetch, onUsage, used = { tokens: 0, models: new Set() } }) {
  const gateways = profileGateways(kind, cfg);
  if (!gateways.length) throw new LlmError('No AI gateway is set up for profile reading', 'not_configured');
  let lastError;
  for (const g of gateways) {
    for (const model of g.models) {
      const label = `${g.label} ${model}`;
      try {
        const value = await retryInvalidJsonOnce(async () => {
          const reply = await chatJson({
            url: g.url,
            apiKey: g.apiKey,
            model,
            label,
            system,
            user,
            reasoningEffort: /gpt-oss/.test(model) ? 'low' : undefined,
            maxOutputTokens,
            timeoutMs: cfg.profile.timeoutMs,
            fetchImpl,
            onUsage: async (u) => {
              if (u.tokens) used.tokens += u.tokens;
              await onUsage?.(g.name, u.tokens);
            },
          });
          const v = validate(parseJsonReply(reply, label));
          if (!v) throw new LlmError(`${label} JSON did not match the expected shape`, 'invalid_json');
          return v;
        });
        used.models.add(model);
        return value;
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pageImage = (jpeg) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } });

/**
 * @param {object} files { resume?: Buffer, portfolio?: Buffer }
 * @param knownPages page notes from an earlier read of the same portfolio file, reused as they are
 * @returns {{ profile, pages, resume, resumeText, warnings: string[], tokens: number, models: string[] }}
 */
export async function buildProfile(files, { cfg = config, fetchImpl = fetch, onUsage, onProgress, knownPages = null } = {}) {
  const used = { tokens: 0, models: new Set() };
  const warnings = [];
  const common = { cfg, fetchImpl, onUsage, used };
  let resume = null;
  let resumeText = null;
  let pages = null;
  let review = null;
  let totalPages = 0;

  if (files.resume) {
    onProgress?.('Reading the CV');
    const { text, pages: n } = await pdfText(files.resume, { maxPages: cfg.profile.maxResumePages });
    resumeText = text.slice(0, cfg.profile.maxResumeChars);
    if (text.length < 80) throw new LlmError('The CV has no readable text (a scanned image?). Export it as a text PDF.', 'invalid_input');
    resume = await askJson({
      ...common,
      kind: 'text',
      system: RESUME_SYSTEM_PROMPT,
      user: `CV (${n} page${n === 1 ? '' : 's'}):\n\n${text.slice(0, cfg.profile.maxResumeChars)}`,
      validate: validateResumeProfile,
      maxOutputTokens: 2_500,
    });
  }

  if (files.portfolio) {
    const pdf = await openPdf(files.portfolio);
    try {
      totalPages = pdf.pages;
      const toRead = Math.min(pdf.pages, cfg.profile.maxPortfolioPages);
      if (toRead < pdf.pages) warnings.push(`Only the first ${toRead} of ${pdf.pages} pages were read.`);
      // Pages read in an earlier run of the same file are kept; only the rest are sent.
      const read = (knownPages || []).filter((p) => p.page >= 1 && p.page <= toRead);
      const known = new Set(read.map((p) => p.page));
      const pending = [];
      for (let i = 0; i < toRead; i++) if (!known.has(i + 1)) pending.push(i);
      const batches = [];
      for (let at = 0; at < pending.length; at += cfg.profile.pagesPerCall) batches.push(pending.slice(at, at + cfg.profile.pagesPerCall));
      if (known.size && pending.length) onProgress?.(`${known.size} pages already read; reading the other ${pending.length}`);

      const readBatch = async (indices) => {
        const numbers = indices.map((i) => i + 1);
        const content = [{ type: 'text', text: `Portfolio pages ${numbers[0]} to ${numbers.at(-1)} of ${pdf.pages}. Describe each page in the JSON shape requested.` }];
        for (const i of indices) content.push({ type: 'text', text: `Page ${i + 1}` }, pageImage(pdf.render(i, { maxPx: cfg.profile.renderPx, quality: cfg.profile.jpegQuality })));
        return askJson({
          ...common,
          kind: 'vision',
          system: PORTFOLIO_PAGES_SYSTEM_PROMPT,
          user: content,
          validate: (v) => validatePortfolioPages(v, numbers),
          maxOutputTokens: 400 * numbers.length + 200,
        });
      };
      // Upstream trouble (rate limits, 5xx, timeouts) passes; a bad request or no gateway does not.
      const transient = (err) => err.kind === 'rate_limit' || err.kind === 'timeout' || err.kind === 'network' || err.status === 429 || (err.status >= 500 && err.status < 600);
      const label = (indices) => `${indices[0] + 1}-${indices.at(-1) + 1}`;

      // Each batch gets a few tries with a growing wait, then the failed ones get one more go at
      // the end, when the gateway's burst limits have usually cleared.
      const failed = new Map(); // batch -> last error
      let calls = 0;
      const attempt = async (indices, tries) => {
        for (let t = 1; t <= tries; t++) {
          try {
            if (calls++ > 0) await sleep(cfg.profile.pauseMs);
            onProgress?.(`Reading portfolio pages ${label(indices)} of ${pdf.pages}${t > 1 ? ` (try ${t})` : ''}`);
            read.push(...(await readBatch(indices)));
            failed.delete(indices);
            return;
          } catch (err) {
            if (err.kind === 'not_configured') throw err;
            failed.set(indices, err);
            if (!transient(err) || t === tries) return;
            onProgress?.(`The AI is busy; waiting before pages ${label(indices)}`);
            await sleep(cfg.profile.retryWaitMs * t);
          }
        }
      };
      for (const b of batches) await attempt(b, cfg.profile.batchTries);
      if (failed.size && failed.size < batches.length) {
        onProgress?.(`Trying the ${failed.size} unread batch${failed.size === 1 ? '' : 'es'} once more`);
        await sleep(cfg.profile.retryWaitMs);
        for (const b of [...failed.keys()]) if (transient(failed.get(b))) await attempt(b, 1);
      }
      for (const [b, err] of failed) warnings.push(`Pages ${label(b)} could not be read (${err.message}).`);
      read.sort((a, b) => a.page - b.page);
      if (read.length < Math.ceil(toRead / 2)) {
        // What was read is handed back so the next try starts from here.
        throw Object.assign(new LlmError(`Only ${read.length} of ${toRead} portfolio pages could be read. Read again in a few minutes: the pages already read are kept.`, 'http'), { pages: read });
      }
      pages = read;
      onProgress?.('Writing the portfolio review');
      try {
        review = await askJson({
          ...common,
          kind: 'text',
          system: PORTFOLIO_SUMMARY_SYSTEM_PROMPT,
          user: `Portfolio of ${pdf.pages} pages (${pages.length} read). Page notes:\n${JSON.stringify(pages)}`,
          validate: validatePortfolioSummary,
          maxOutputTokens: 900,
        });
      } catch (err) {
        warnings.push(`The portfolio review could not be written (${err.message}).`);
      }
    } finally {
      pdf.close();
    }
  }

  if (!resume && !pages) throw new LlmError('Nothing to read: upload a CV or a portfolio.', 'invalid_input');
  const profile = mergeProfile({ resume, pages, review, totalPages });
  return { profile, pages, resume, resumeText, warnings, tokens: used.tokens, models: [...used.models] };
}
