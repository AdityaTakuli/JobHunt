// AI first (Groq, then Gemini), rule-based fallback. One classifier instance is one session: it
// labels one batch, carries that run's token budget (lib/aiBudget.js), and stops calling a
// provider for the rest of the batch once it is down, rate-limited (429) or out of budget.

import { config } from '../config.js';
import { createBudget, dbUsageStore } from './aiBudget.js';
import { classifyWithGemini } from './gemini.js';
import { classifyWithGroq } from './groq.js';
import { LlmError, requestEstimate } from './llm.js';
import { classifyWithRules, SOFTWARE } from './rules.js';
import { parseSalary } from './salary.js';

const CALLERS = { groq: classifyWithGroq, gemini: classifyWithGemini };

/**
 * @param options.groq / options.gemini provider config (see config.js); null leaves it out
 * @param options.usageStore where daily usage is kept (MySQL by default)
 */
export function createClassifier({
  groq = config.groq,
  gemini = config.gemini,
  ai = config.ai,
  extraExclude = [],
  fetchImpl = fetch,
  useRules = true,
  usageStore = dbUsageStore,
  sleep,
} = {}) {
  const providers = Object.entries({ groq, gemini })
    .filter(([, cfg]) => cfg)
    .map(([name, cfg]) => ({
      name,
      cfg,
      budget: createBudget(name, cfg.limits, { store: usageStore, maxWaitMs: ai?.maxWaitMs, ...(sleep && { sleep }) }),
      lastCall: 0,
    }));
  const downReasons = Object.fromEntries(providers.map((p) => [p.name, p.cfg.apiKey ? null : 'not_configured']));
  const stats = { groq: 0, gemini: 0, rules: 0, requests: 0, tokens: 0, failures: {} };
  // What happened to the last job: 'ai', 'rules', 'invalid_json' (an AI answered but not in the
  // expected shape) or 'skipped' (no AI call was possible).
  let lastOutcome = null;
  let sawInvalidJson = false;
  const fail = (p, kind) => {
    const key = `${p.name}:${kind}`;
    stats.failures[key] = (stats.failures[key] || 0) + 1;
  };

  // Space out calls to stay under the provider's requests-per-minute limit.
  async function throttle(p) {
    const wait = p.lastCall + (p.cfg.minIntervalMs || 0) - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    p.lastCall = Date.now();
  }

  async function tryProvider(p, job) {
    const options = { ...p.cfg, extraExclude, maxDescriptionChars: ai?.maxDescriptionChars, fetchImpl };
    const estimate = requestEstimate(job, options);
    let blocked;
    try {
      blocked = await p.budget.reserve(estimate);
    } catch {
      blocked = 'budget_unavailable'; // cannot read today's usage: do not spend blind
    }
    if (blocked) {
      fail(p, `budget:${blocked}`);
      // The minute window clears on its own: skip the provider for this job only. Any other
      // limit holds for the rest of the run.
      if (blocked !== 'minute_tokens') downReasons[p.name] = `budget:${blocked}`;
      return null;
    }

    const onUsage = async (usage) => {
      stats.requests += 1;
      stats.tokens += Number.isFinite(usage.tokens) ? usage.tokens : estimate;
      try {
        await p.budget.record(usage, estimate);
      } catch {
        // Keep this answer, but stop spending tokens that cannot be counted.
        downReasons[p.name] = 'budget:budget_unavailable';
      }
    };
    try {
      await throttle(p);
      const labels = await CALLERS[p.name](job, { ...options, onUsage });
      stats[p.name] += 1;
      return { labels, classifier: p.name };
    } catch (err) {
      const kind = err instanceof LlmError ? err.kind : 'unexpected';
      fail(p, kind);
      if (kind === 'invalid_json') sawInvalidJson = true;
      // Invalid JSON (already retried once) is job-specific; anything else means the provider
      // is unavailable, so skip it for the rest of this batch.
      if (kind !== 'invalid_json') downReasons[p.name] = kind;
      return null;
    }
  }

  async function classify(job) {
    sawInvalidJson = false;
    for (const p of providers) {
      if (downReasons[p.name]) continue;
      const out = await tryProvider(p, job);
      if (out) {
        lastOutcome = 'ai';
        return out;
      }
    }
    if (!useRules) {
      lastOutcome = sawInvalidJson ? 'invalid_json' : 'skipped';
      return null;
    }
    lastOutcome = 'rules';
    stats.rules += 1;
    return { labels: classifyWithRules(job, { extraExclude }), classifier: 'rules' };
  }

  return {
    classify,
    stats,
    downReasons,
    get lastOutcome() {
      return lastOutcome;
    },
    get aiAvailable() {
      return providers.some((p) => !downReasons[p.name]);
    },
    get groqDownReason() {
      return downReasons.groq ?? null;
    },
  };
}

// Groq names tools freely ("Autodesk Revit", "autocad"); map known ones to the filter names.
export function canonicalSoftware(list) {
  const out = [];
  for (const raw of list || []) {
    const known = SOFTWARE.find(([, re]) => re.test(raw));
    const name = known ? known[0] : String(raw).trim();
    if (name && !out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

// Maps classifier labels onto `jobs` columns. Keeps a salary already found at ingest.
export function labelsToColumns(labels, classifier, job) {
  const cols = {
    is_relevant: labels.is_relevant ? 1 : 0,
    role_type: labels.role_type,
    is_bim: labels.is_bim ? 1 : 0,
    software: JSON.stringify(canonicalSoftware(labels.software)),
    match_score: labels.is_relevant ? labels.match_score : Math.min(labels.match_score, 20),
    classifier,
    classify_reason: labels.reason?.slice(0, 300) || null,
  };
  if (!job.salary_text && labels.stipend_or_salary) {
    const parsed = parseSalary(labels.stipend_or_salary);
    cols.salary_text = (parsed?.text || labels.stipend_or_salary).slice(0, 200);
    cols.salary_min = parsed?.min ?? null;
    cols.salary_max = parsed?.max ?? null;
    cols.salary_period = parsed?.period ?? null;
    cols.salary_is_estimate = 0;
  }
  return cols;
}
