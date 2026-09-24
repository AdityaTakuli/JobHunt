// Groq classifier. Throws LlmError on anything that should trigger the next provider or the
// rule-based fallback, and reports each call's token use through onUsage.

import { LlmError, MAX_OUTPUT_TOKENS, parseLabels, requestError, retryInvalidJsonOnce, SYSTEM_PROMPT, userPrompt } from './llm.js';

export { validateLabels } from './llm.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const header = (res, name) => {
  const value = res.headers?.get?.(name);
  return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
};

async function callGroq(job, { apiKey, model, reasoningEffort, timeoutMs, extraExclude, maxDescriptionChars, fetchImpl, onUsage }) {
  let res;
  try {
    res = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Reasoning models spend tokens thinking before answering; labeling does not need it.
        ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt(job, { extraExclude, maxDescriptionChars }) },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw requestError(err, 'Groq', timeoutMs);
  }

  if (res.status === 429) throw new LlmError('Groq rate limit (429)', 'rate_limit', 429);
  // Groq's own count of requests left today, so we stop before the account runs dry.
  const remainingRequests = header(res, 'x-ratelimit-remaining-requests');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Groq returns 400 json_validate_failed when the model emits invalid JSON in JSON mode.
    if (res.status === 400 && /json_validate_failed/.test(body)) {
      await onUsage?.({ tokens: null, remainingRequests }); // tokens were spent; the budget uses its estimate
      throw new LlmError('Groq returned invalid JSON', 'invalid_json', 400);
    }
    throw new LlmError(`Groq HTTP ${res.status}: ${body.slice(0, 200)}`, 'http', res.status);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    await onUsage?.({ tokens: null, remainingRequests });
    throw new LlmError('Groq response was not JSON', 'invalid_json');
  }
  await onUsage?.({ tokens: data?.usage?.total_tokens ?? null, remainingRequests });
  return parseLabels(data?.choices?.[0]?.message?.content, 'Groq');
}

// Labels one job. Invalid JSON is retried once; any other failure throws immediately.
export async function classifyWithGroq(job, options) {
  const { apiKey, model, reasoningEffort = '', timeoutMs = 10_000, extraExclude = [], maxDescriptionChars, fetchImpl = fetch, onUsage } = options;
  if (!apiKey) throw new LlmError('GROQ_API_KEY is not set', 'not_configured');
  const args = { apiKey, model, reasoningEffort, timeoutMs, extraExclude, maxDescriptionChars, fetchImpl, onUsage };
  return retryInvalidJsonOnce(() => callGroq(job, args));
}
