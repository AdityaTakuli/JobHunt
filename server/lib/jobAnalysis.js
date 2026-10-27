// "Analyse with AI" on a job: what the posting really asks for, how well a B.Arch student fits it,
// and what to put first in the CV, cover note and portfolio. One call per job, stored in
// job_analyses so everyone who opens the job reads the same answer without spending tokens again.
//
// Runs on the best model configured, in order: AI_ANALYSIS_MODELS on OmniRoute first (when
// OMNIROUTE_URL is set), then on FreeLLMAPI. Analysis needs a stronger model than labeling, so it
// has its own model list (config.analysis) and a bigger output allowance.

import { config } from '../config.js';
import { freellmChatUrl, freellmModels } from './freellm.js';
import { LlmError, retryInvalidJsonOnce } from './llm.js';
import { chatJson } from './openaiChat.js';

export const ANALYSIS_VERSION = 1;

export const ANALYSIS_SYSTEM_PROMPT = `You are a careers adviser for architecture students in India. You read one job posting and
advise a final-year B.Arch student (or fresh graduate) who wants architecture, interior or BIM
internships and fresher roles. Be concrete and honest: quote the posting's own requirements, never
invent ones it does not state, and say plainly when a role is too senior.

Reply with one JSON object and nothing else, with exactly these keys:
{
  "summary": string,              // 1-2 plain sentences: what the job is day to day
  "level": "internship" | "fresher" | "junior" | "mid" | "senior",
  "experience": string | null,    // experience asked for, as written ("3-5 years"), else null
  "fit_score": integer 0-100,     // chance a final-year B.Arch student is shortlisted
  "fit_verdict": "good fit" | "stretch" | "long shot",
  "fit_reason": string,           // one line: why that verdict
  "must_have": string[],          // up to 6 hard requirements stated in the posting
  "nice_to_have": string[],       // up to 5 extras the posting mentions as preferred
  "software": string[],           // tools named in the posting
  "highlight": string[],          // up to 5 things to put first in the CV and cover note
  "portfolio": string[],          // up to 3 kinds of project or drawing to show for this role
  "gaps": string[],               // up to 4 likely gaps for a student, each with how to cover it
  "cover_note": string,           // 2-3 sentence opening for a cover note or email, first person
  "interview": string[],          // up to 4 topics to prepare for this interview
  "red_flags": string[]           // up to 3 warnings (unpaid, bond, vague role, not really architecture); [] if none
}
Keep each list item under 20 words.`;

export function analysisPrompt(job, { cities = [], maxDescriptionChars = 6000 } = {}) {
  const description = String(job.description || '').slice(0, maxDescriptionChars);
  return [
    `Title: ${job.title}`,
    `Company: ${job.company || 'unknown'}`,
    `Location: ${job.location_text || job.city || 'unknown'}`,
    job.salary_text ? `Listed pay: ${job.salary_text}` : null,
    cities.length ? `The student's preferred cities: ${cities.join(', ')}.` : null,
    `Description:\n${description || '(no description: judge from the title and company only, and say so in summary)'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const LEVELS = new Set(['internship', 'fresher', 'junior', 'mid', 'senior']);
const VERDICTS = new Set(['good fit', 'stretch', 'long shot']);

const text = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max) =>
  Array.isArray(v)
    ? [...new Set(v.filter((s) => typeof s === 'string').map((s) => s.trim().slice(0, 200)).filter(Boolean))].slice(0, max)
    : null;

// Strict check of the model's answer. Returns the analysis or null when the shape is wrong.
export function validateAnalysis(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lists = {
    must_have: list(value.must_have, 6),
    nice_to_have: list(value.nice_to_have, 5),
    software: list(value.software, 12),
    highlight: list(value.highlight, 5),
    portfolio: list(value.portfolio, 3),
    gaps: list(value.gaps, 4),
    interview: list(value.interview, 4),
    red_flags: list(value.red_flags ?? [], 3),
  };
  if (Object.values(lists).some((l) => l === null)) return null;
  const score = Number(value.fit_score);
  if (!Number.isFinite(score)) return null;
  const verdict = String(value.fit_verdict || '').toLowerCase();
  if (!VERDICTS.has(verdict)) return null;
  const summary = text(value.summary, 500);
  if (!summary || !text(value.fit_reason)) return null;
  return {
    summary,
    level: LEVELS.has(value.level) ? value.level : null,
    experience: text(value.experience, 120) || null,
    fit_score: Math.max(0, Math.min(100, Math.round(score))),
    fit_verdict: verdict,
    fit_reason: text(value.fit_reason, 300),
    ...lists,
    cover_note: text(value.cover_note, 700),
  };
}

export function parseAnalysis(content, label) {
  let parsed;
  try {
    // Some models wrap JSON in a ```json fence even in JSON mode.
    parsed = JSON.parse(String(content || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  } catch {
    throw new LlmError(`${label} returned invalid JSON`, 'invalid_json');
  }
  const analysis = validateAnalysis(parsed);
  if (!analysis) throw new LlmError(`${label} JSON did not match the analysis shape`, 'invalid_json');
  return analysis;
}

// The gateways to try, best first. Each is an OpenAI-style endpoint with a model list.
export function analysisGateways(cfg = config) {
  const models = (list) => freellmModels(list);
  const out = [];
  if (cfg.omniroute?.url && cfg.omniroute?.apiKey) {
    const m = models(cfg.analysis.omnirouteModels);
    if (m.length) out.push({ name: 'omniroute', label: 'OmniRoute', url: freellmChatUrl(cfg.omniroute.url), apiKey: cfg.omniroute.apiKey, models: m });
  }
  if (cfg.freellm?.url && cfg.freellm?.apiKey) {
    const m = models(cfg.analysis.freellmModels);
    if (m.length) out.push({ name: 'freellm', label: 'FreeLLMAPI', url: freellmChatUrl(cfg.freellm.url), apiKey: cfg.freellm.apiKey, models: m });
  }
  return out;
}

/**
 * Analyses one job on the first gateway/model that answers.
 * @returns { analysis, gateway, model, tokens }
 */
export async function analyseJob(job, { cities = [], cfg = config, fetchImpl = fetch, onUsage, now = Date.now } = {}) {
  const gateways = analysisGateways(cfg);
  if (!gateways.length) throw new LlmError('No AI gateway is set up for job analysis', 'not_configured');
  const user = analysisPrompt(job, { cities, maxDescriptionChars: cfg.analysis.maxDescriptionChars });
  const started = now();
  let lastError;
  for (const g of gateways) {
    for (const model of g.models) {
      if (lastError && now() - started > (cfg.analysis.deadlineMs ?? Infinity)) throw lastError;
      const label = `${g.label} ${model}`;
      let tokens = null;
      try {
        const analysis = await retryInvalidJsonOnce(async () =>
          parseAnalysis(
            await chatJson({
              url: g.url,
              apiKey: g.apiKey,
              model,
              label,
              system: ANALYSIS_SYSTEM_PROMPT,
              user,
              reasoningEffort: /gpt-oss/.test(model) ? 'low' : undefined,
              maxOutputTokens: cfg.analysis.maxOutputTokens,
              timeoutMs: cfg.analysis.timeoutMs,
              fetchImpl,
              onUsage: async (u) => {
                tokens = (tokens || 0) + (u.tokens || 0);
                await onUsage?.(g.name, u.tokens);
              },
            }),
            label,
          ),
        );
        return { analysis, gateway: g.name, model, tokens };
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError;
}
