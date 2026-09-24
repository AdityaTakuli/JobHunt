// Shared by the Groq and Gemini classifiers: the prompt, the strict output check, token
// estimates and the error that sends a job on to the next provider or the rule fallback.

const ROLE_TYPES = new Set(['internship', 'fresher', 'experienced']);

// Output cap per call. The JSON answer is ~80-120 tokens; this only stops runaway replies.
export const MAX_OUTPUT_TOKENS = 300;

export class LlmError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind; // timeout | rate_limit | http | network | invalid_json | not_configured
    this.status = status;
  }
}

export const SYSTEM_PROMPT = `You label job postings for a final-year B.Arch (architecture) student in India who wants
BIM or architecture internships and fresher roles, preferably in her chosen cities (listed with each posting).

Relevant = the work is architecture, architectural design, interior/landscape architecture, or BIM
(Revit, Navisworks, BIM modelling/coordination) in the building/construction industry.
NOT relevant = IT roles that use the word "architect" (software, solution, cloud, data, enterprise,
network, security, Salesforce, AWS, Java architect), sales, or unrelated fields.

Reply with one JSON object and nothing else, with exactly these keys:
{
  "is_relevant": boolean,
  "role_type": "internship" | "fresher" | "experienced",
  "is_bim": boolean,
  "software": string[],            // tools named in the posting, e.g. "Revit", "AutoCAD", "SketchUp"
  "stipend_or_salary": string | null, // pay exactly as written in the posting, else null
  "match_score": integer 0-100,    // fit for this student: BIM/Revit, internship/fresher, her cities score higher
  "reason": string                 // one short line
}
role_type: internship for intern/trainee roles, fresher for 0-1 year or graduate roles,
experienced when 3+ years of experience are required.`;

// Long descriptions are cut: the role, skills and pay are almost always in the first part, and
// input tokens are what the free tiers run out of first.
export function userPrompt(job, { extraExclude = [], cities = [], maxDescriptionChars = 2500 } = {}) {
  const description = String(job.description || '').slice(0, maxDescriptionChars);
  const lines = [
    `Title: ${job.title}`,
    `Company: ${job.company || 'unknown'}`,
    `Location: ${job.location_text || job.city || 'unknown'}`,
    job.salary_text ? `Listed pay: ${job.salary_text}` : null,
    `Description:\n${description || '(none)'}`,
  ];
  if (cities?.length) lines.push(`\nThe student's cities: ${cities.join(', ')}.`);
  if (extraExclude?.length) {
    lines.push(`\nThe student has also marked these kinds of roles as not relevant: ${extraExclude.join(', ')}.`);
  }
  return lines.filter(Boolean).join('\n');
}

// Rough token count (~3.5 characters per token for English), rounded up so budgets err safe.
export const estimateTokens = (text) => Math.ceil(String(text || '').length / 3.5);

// Worst case for one call: the whole prompt plus the full output cap.
export function requestEstimate(job, options) {
  return estimateTokens(SYSTEM_PROMPT) + estimateTokens(userPrompt(job, options)) + MAX_OUTPUT_TOKENS;
}

// Strict validation of the model output. Returns the labels or null when the shape is wrong.
export function validateLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { is_relevant, role_type, is_bim, software, stipend_or_salary, match_score, reason } = value;
  if (typeof is_relevant !== 'boolean' || typeof is_bim !== 'boolean') return null;
  if (!ROLE_TYPES.has(role_type)) return null;
  if (!Array.isArray(software) || !software.every((s) => typeof s === 'string')) return null;
  if (stipend_or_salary !== null && typeof stipend_or_salary !== 'string') return null;
  if (typeof match_score !== 'number' || !Number.isFinite(match_score)) return null;
  if (typeof reason !== 'string') return null;
  return {
    is_relevant,
    role_type,
    is_bim,
    software: [...new Set(software.map((s) => s.trim()).filter(Boolean))].slice(0, 12),
    stipend_or_salary: stipend_or_salary?.trim() ? stipend_or_salary.trim().slice(0, 200) : null,
    match_score: Math.max(0, Math.min(100, Math.round(match_score))),
    reason: reason.trim().slice(0, 300),
  };
}

// Parses and validates the model's JSON text.
export function parseLabels(content, provider) {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new LlmError(`${provider} returned invalid JSON`, 'invalid_json');
  }
  const labels = validateLabels(parsed);
  if (!labels) throw new LlmError(`${provider} JSON did not match the expected shape`, 'invalid_json');
  return labels;
}

// Turns a fetch() failure into an LlmError.
export function requestError(err, provider, timeoutMs) {
  if (err.name === 'TimeoutError' || err.name === 'AbortError') {
    return new LlmError(`${provider} timed out after ${timeoutMs / 1000}s`, 'timeout');
  }
  return new LlmError(`${provider} request failed: ${err.message}`, 'network');
}

// Invalid JSON is retried once; any other failure throws immediately.
export async function retryInvalidJsonOnce(call) {
  try {
    return await call();
  } catch (err) {
    if (err.kind !== 'invalid_json') throw err;
    return call();
  }
}
