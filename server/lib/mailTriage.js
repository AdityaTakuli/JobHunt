// Reads one email about a job application and says what it means for the tracker: she applied,
// got an interview or a test, an offer, a rejection, or nothing to do with her applications.
// FreeLLMAPI first (models tried in order, FREELLM_MAIL_MODEL), keyword rules when it is out.
// Shares the FreeLLMAPI daily budget with job labeling (lib/aiBudget.js).

import { config } from '../config.js';
import { createBudget, dbUsageStore } from './aiBudget.js';
import { withFreeLlmModels } from './freellm.js';
import { estimateTokens, LlmError, retryInvalidJsonOnce } from './llm.js';
import { chatJson } from './openaiChat.js';

export const MAIL_KINDS = ['applied', 'interview', 'assessment', 'offer', 'rejected', 'other'];
const KINDS = new Set(MAIL_KINDS);
const MAX_BODY_CHARS = 1800;
const MAX_OUTPUT_TOKENS = 800;

export const MAIL_PROMPT = `You read one email from a job seeker's inbox and tell her job tracker what it means.

Reply with one JSON object and nothing else, with exactly these keys:
{
  "kind": "applied" | "interview" | "assessment" | "offer" | "rejected" | "other",
  "company": string | null,   // the employer she applied to (not LinkedIn, Naukri, Workday or another job site)
  "role": string | null,      // the job title, as written
  "reason": string            // one short line
}
applied    = confirms she sent or submitted an application ("your application was sent", "thank you for applying").
interview  = invites her to, or schedules, an interview, call or meeting about a role.
assessment = asks her to do a test, design task, assignment or send a portfolio for a role.
offer      = offers her the job or internship.
rejected   = says the employer is not moving forward with her.
other      = anything else: job alerts and recommendations, newsletters, OTPs, marketing, receipts,
             and job-site emails that are not about one of her own applications.`;

// The text sent to the AI: who sent it, the subject and the start of the body. Quoted replies
// are dropped; they repeat older mail and cost tokens.
export function mailPrompt(mail) {
  const body = String(mail.text || '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, MAX_BODY_CHARS);
  return [`From: ${mail.from || 'unknown'}`, `Subject: ${mail.subject || '(no subject)'}`, '', body || '(empty)'].join('\n');
}

const clean = (value, max) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && !/^(null|unknown|n\/a)$/i.test(text) ? text.slice(0, max) : null;
};

export function validateTriage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!KINDS.has(value.kind)) return null;
  if (value.company != null && typeof value.company !== 'string') return null;
  if (value.role != null && typeof value.role !== 'string') return null;
  return {
    kind: value.kind,
    company: clean(value.company, 200),
    role: clean(value.role, 300),
    reason: clean(value.reason, 300) || '',
  };
}

function parseTriage(content, label) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LlmError(`${label} returned invalid JSON`, 'invalid_json');
  }
  const out = validateTriage(parsed);
  if (!out) throw new LlmError(`${label} JSON did not match the expected shape`, 'invalid_json');
  return out;
}

// Keyword fallback. Careful on purpose: an email it is unsure about counts as "other".
const RULES = [
  ['offer', /\b(offer letter|pleased to offer|offer of (employment|internship)|we would like to offer you)\b/i],
  ['rejected', /\b(unfortunately|regret to inform|not (be )?moving forward|decided (not )?to (move|proceed) forward with other|not been (shortlisted|selected)|position has been filled|other candidates)\b/i],
  ['assessment', /\b(assessment|assignment|design (task|exercise|test)|aptitude test|take-home)\b/i],
  ['interview', /\b(interview|shortlisted|schedule (a|an) (call|meeting|discussion))\b/i],
  ['applied', /\b(your application was sent to|thank you for (applying|your application)|application (has been |was )?(received|submitted)|successfully applied|we (have )?received your application)\b/i],
];
const NOT_ABOUT_HER = /\b(job alert|jobs? (for you|matching|similar)|new jobs?|recommended jobs|unsubscribe from (these|job) alerts)\b/i;

export function triageWithRules(mail) {
  const text = `${mail.subject || ''}\n${String(mail.text || '').slice(0, MAX_BODY_CHARS)}`;
  if (NOT_ABOUT_HER.test(mail.subject || '')) return { kind: 'other', company: null, role: null, reason: 'Looks like a job alert.' };
  const hit = RULES.find(([, re]) => re.test(text));
  if (!hit) return { kind: 'other', company: null, role: null, reason: 'No application words found.' };
  // LinkedIn: "Aditi, your application was sent to Morphogenesis"
  const sentTo = String(mail.subject || '').match(/application was sent to (.+)$/i);
  const at = text.match(/\b(?:position|role) of (.+?) at ([A-Z][\w&.' -]{1,60}?)[.,\n]/);
  return {
    kind: hit[0],
    company: clean(sentTo?.[1] || at?.[2], 200),
    role: clean(at?.[1], 300),
    reason: 'Matched keywords (AI unavailable).',
  };
}

/**
 * One triage session: carries the run's FreeLLMAPI budget and the models that went down.
 * @returns { triage(mail) -> { kind, company, role, reason, classifier } , stats }
 */
export function createMailTriage({ freellm = config.freellm, fetchImpl = fetch, usageStore = dbUsageStore, sleep } = {}) {
  const cfg = freellm && { ...freellm, model: freellm.mailModel || freellm.model };
  const budget = cfg && createBudget('freellm', cfg.limits, { store: usageStore, maxWaitMs: config.ai.maxWaitMs, ...(sleep && { sleep }) });
  const state = {};
  const stats = { ai: 0, rules: 0, tokens: 0, failures: {} };
  let down = !cfg?.url || !cfg?.apiKey ? 'not_configured' : null;
  let lastCall = 0;

  async function askAi(mail) {
    const user = mailPrompt(mail);
    const estimate = estimateTokens(MAIL_PROMPT) + estimateTokens(user) + MAX_OUTPUT_TOKENS;
    const blocked = await budget.reserve(estimate).catch(() => 'budget_unavailable');
    if (blocked) {
      if (blocked !== 'minute_tokens') down = `budget:${blocked}`;
      throw new LlmError(`budget: ${blocked}`, 'budget');
    }
    const wait = lastCall + (cfg.minIntervalMs || 0) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCall = Date.now();
    const onUsage = async (usage) => {
      stats.tokens += Number.isFinite(usage.tokens) ? usage.tokens : estimate;
      await budget.record(usage, estimate).catch(() => {
        down = 'budget:budget_unavailable';
      });
    };
    return withFreeLlmModels({ ...cfg, state, fetchImpl }, (o) =>
      retryInvalidJsonOnce(async () =>
        parseTriage(await chatJson({ ...o, system: MAIL_PROMPT, user, maxOutputTokens: MAX_OUTPUT_TOKENS, onUsage }), o.label),
      ),
    );
  }

  async function triage(mail) {
    if (!down) {
      try {
        const out = await askAi(mail);
        stats.ai += 1;
        return { ...out, classifier: 'freellm' };
      } catch (err) {
        const kind = err instanceof LlmError ? err.kind : 'unexpected';
        stats.failures[kind] = (stats.failures[kind] || 0) + 1;
        if (!['invalid_json', 'budget'].includes(kind)) down = kind;
      }
    }
    stats.rules += 1;
    return { ...triageWithRules(mail), classifier: 'rules' };
  }

  return {
    triage,
    stats,
    get down() {
      return down;
    },
  };
}
