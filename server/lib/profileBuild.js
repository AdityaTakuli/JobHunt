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
async function ask({ kind, system, user, validate, maxOutputTokens, cfg, fetchImpl, onUsage, used }) {
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
 * @returns {{ profile, pages, resume, warnings: string[], tokens: number, models: string[] }}
 */
export async function buildProfile(files, { cfg = config, fetchImpl = fetch, onUsage, onProgress } = {}) {
  const used = { tokens: 0, models: new Set() };
  const warnings = [];
  const common = { cfg, fetchImpl, onUsage, used };
  let resume = null;
  let pages = null;
  let review = null;
  let totalPages = 0;

  if (files.resume) {
    onProgress?.('Reading the CV');
    const { text, pages: n } = await pdfText(files.resume, { maxPages: cfg.profile.maxResumePages });
    if (text.length < 80) throw new LlmError('The CV has no readable text (a scanned image?). Export it as a text PDF.', 'invalid_input');
    resume = await ask({
      ...common,
      kind: 'text',
      system: RESUME_SYSTEM_PROMPT,
      user: `CV (${n} page${n === 1 ? '' : 's'}):\n\n${text.slice(0, cfg.profile.maxResumeChars)}`,
      validate: validateResumeProfile,
      maxOutputTokens: 1_500,
    });
  }

  if (files.portfolio) {
    const pdf = await openPdf(files.portfolio);
    try {
      totalPages = pdf.pages;
      const toRead = Math.min(pdf.pages, cfg.profile.maxPortfolioPages);
      if (toRead < pdf.pages) warnings.push(`Only the first ${toRead} of ${pdf.pages} pages were read.`);
      const read = [];
      for (let start = 0; start < toRead; start += cfg.profile.pagesPerCall) {
        const numbers = [];
        const content = [];
        for (let i = start; i < Math.min(toRead, start + cfg.profile.pagesPerCall); i++) {
          numbers.push(i + 1);
          content.push({ type: 'text', text: `Page ${i + 1}` }, pageImage(pdf.render(i, { maxPx: cfg.profile.renderPx, quality: cfg.profile.jpegQuality })));
        }
        onProgress?.(`Reading portfolio pages ${numbers[0]}-${numbers.at(-1)} of ${pdf.pages}`);
        content.unshift({ type: 'text', text: `Portfolio pages ${numbers[0]} to ${numbers.at(-1)} of ${pdf.pages}. Describe each page in the JSON shape requested.` });
        const batch = () =>
          ask({
            ...common,
            kind: 'vision',
            system: PORTFOLIO_PAGES_SYSTEM_PROMPT,
            user: content,
            validate: (v) => validatePortfolioPages(v, numbers),
            maxOutputTokens: 400 * numbers.length + 200,
          });
        try {
          if (start > 0) await sleep(cfg.profile.pauseMs);
          read.push(...(await batch().catch(async (err) => {
            // The free Gemini tiers rate-limit in bursts: wait once, then try the batch again.
            if (err.kind !== 'rate_limit' && err.status !== 429 && err.status !== 502) throw err;
            onProgress?.(`The AI is busy; waiting before pages ${numbers[0]}-${numbers.at(-1)}`);
            await sleep(cfg.profile.retryWaitMs);
            return batch();
          })));
        } catch (err) {
          if (err.kind === 'not_configured') throw err;
          warnings.push(`Pages ${numbers[0]}-${numbers.at(-1)} could not be read (${err.message}).`);
        }
      }
      if (read.length < Math.ceil(toRead / 2)) throw new LlmError(`Only ${read.length} of ${toRead} portfolio pages could be read. Try again in a few minutes.`, 'http');
      pages = read.sort((a, b) => a.page - b.page);
      onProgress?.('Writing the portfolio review');
      try {
        review = await ask({
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
  return { profile, pages, resume, warnings, tokens: used.tokens, models: [...used.models] };
}
