// "Analyse with AI" on a job: what the posting really asks for and what to put first in the CV,
// cover note and portfolio for this firm. Built from the posting text (read from the job page when
// the job came without one, lib/jobPage.js) and what is known about the firm. One call per job, stored in
// job_analyses so everyone who opens the job reads the same answer without spending tokens again.
//
// Runs on the best model configured, in order: AI_ANALYSIS_MODELS on OmniRoute first (when
// OMNIROUTE_URL is set), then on FreeLLMAPI. Analysis needs a stronger model than labeling, so it
// has its own model list (config.analysis) and a bigger output allowance.

import { config } from '../config.js';
import { freellmChatUrl, freellmModels } from './freellm.js';
import { LlmError, retryInvalidJsonOnce } from './llm.js';
import { chatJson } from './openaiChat.js';

// 2: written from the posting and the firm, never from the title alone; no score of its own (the
// one fit score is lib/fit.js, so a job never shows two different numbers).
export const ANALYSIS_VERSION = 2;

export const ANALYSIS_SYSTEM_PROMPT = `You are a hiring architect in India reading one job posting for an architecture student or fresh
graduate who is deciding whether and how to apply. Everything you write must come from THIS posting
and THIS firm: the text you are given, nothing else.

Hard rules:
- Use only the posting text and the firm details given. Do not add anything they do not say: no
  invented requirements, projects, clients, benefits, office culture or salary.
- No generic advice. A line that would be true of any architecture job ("show your design skills",
  "be confident", "highlight teamwork", "research the company") is not allowed. Each item must name
  something specific from the posting or the firm: a tool, a project type, a task, a sector, a
  phrase they use.
- must_have and nice_to_have: copy the posting's own requirements, shortened, in its words. If the
  posting does not separate them, put the "must", "required", "minimum" ones in must_have.
- If you were told there is NO POSTING TEXT, say so in summary, return [] for must_have,
  nice_to_have, software, highlight, portfolio, gaps and interview, "" for cover_note, and only state
  what the title and the firm details themselves show.
- Say plainly when the role is senior (years of experience) and not one a student can get.

Reply with one JSON object and nothing else, with exactly these keys:
{
  "summary": string,              // 1-2 sentences: what this person would do day to day at this firm, from the posting
  "company": string | null,       // 1-2 sentences on the firm and the work this team does, ONLY from what you were given; null if nothing was given
  "level": "internship" | "fresher" | "junior" | "mid" | "senior",
  "experience": string | null,    // experience asked for, as written ("3-5 years"), else null
  "must_have": string[],          // up to 6, from the posting
  "nice_to_have": string[],       // up to 5, from the posting
  "software": string[],           // tools the posting names
  "highlight": string[],          // up to 5: what to put first in the CV for THIS posting, each tied to a requirement it names
  "portfolio": string[],          // up to 3: which projects or drawings to show, tied to this firm's work or the posting
  "gaps": string[],               // up to 4: requirements a student often lacks here, each with a concrete way to cover it
  "cover_note": string,           // 2-3 sentence opening, first person, naming the firm and one thing from the posting
  "interview": string[],          // up to 4 topics this posting points to (its tools, project types, tasks)
  "red_flags": string[]           // up to 3, from the posting (unpaid, bond, vague role, not architecture, much more experience than a student has); [] if none
}
Keep each list item under 22 words.`;

/**
 * @param job { title, company, city, location_text, salary_text, description }
 * @param options.firm { name, kind, note, about } or null: what is known about the employer
 * @param options.source 'posting' when the description is the real posting, 'none' when it could not be read
 */
export function analysisPrompt(job, { cities = [], maxDescriptionChars = 6000, firm = null, source = null, sourceHost = null } = {}) {
  const description = String(job.description || '').slice(0, maxDescriptionChars).trim();
  const hasPosting = source ? source === 'posting' : description.length >= 300;
  const firmLines = firm
    ? [
        `Firm: ${firm.name}${firm.kind ? ` (${firm.kind})` : ''}`,
        firm.about ? `What the firm says about itself: ${firm.about}` : null,
        firm.note ? `What it has hired architecture students for: ${firm.note}` : null,
      ]
    : [];
  return [
    `Title: ${job.title}`,
    `Company: ${job.company || 'unknown'}`,
    `Location: ${job.location_text || job.city || 'unknown'}`,
    job.salary_text ? `Listed pay: ${job.salary_text}` : null,
    ...firmLines,
    cities.length ? `The student's preferred cities: ${cities.join(', ')}.` : null,
    hasPosting
      ? `Posting text${sourceHost ? ` (from ${sourceHost})` : ''}:\n${description}`
      : `NO POSTING TEXT: the posting could not be read (the job site blocks automated reading). You have only the title, the company${firm ? ' and the firm details' : ''}.${description ? `\nThe listing's short teaser: ${description}` : ''}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const LEVELS = new Set(['internship', 'fresher', 'junior', 'mid', 'senior']);

const text = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, max) =>
  Array.isArray(v)
    ? [...new Set(v.filter((s) => typeof s === 'string').map((s) => s.trim().slice(0, 200)).filter(Boolean))].slice(0, max)
    : null;

// Lines that would fit any job. The model is told not to write them; any that slip through are
// dropped here.
const GENERIC =
  /^(highlight|show(case)?|emphasi[sz]e|demonstrate|mention)\s+(your\s+)?(design|communication|team ?work|creative|problem[- ]solving|soft|interpersonal|passion|enthusiasm|attention to detail)\b|research the (company|firm)|be (confident|punctual|professional)|good communication skills?$|team player$|tailor your (cv|resume)/i;
const specific = (items) => items.filter((s) => !GENERIC.test(s));

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
  for (const k of ['highlight', 'portfolio', 'gaps', 'interview']) lists[k] = specific(lists[k]);
  const summary = text(value.summary, 500);
  if (!summary) return null;
  return {
    summary,
    company: text(value.company, 500) || null,
    level: LEVELS.has(value.level) ? value.level : null,
    experience: text(value.experience, 120) || null,
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
export async function analyseJob(job, { cities = [], firm = null, source = null, sourceHost = null, cfg = config, fetchImpl = fetch, onUsage, now = Date.now } = {}) {
  const gateways = analysisGateways(cfg);
  if (!gateways.length) throw new LlmError('No AI gateway is set up for job analysis', 'not_configured');
  const user = analysisPrompt(job, { cities, firm, source, sourceHost, maxDescriptionChars: cfg.analysis.maxDescriptionChars });
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
