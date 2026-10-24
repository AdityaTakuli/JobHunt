// Labels a job through any OpenAI-style /chat/completions endpoint (Groq, FreeLLMAPI). Throws
// LlmError on anything that should trigger the next provider or the rule-based fallback, and
// reports each call's token use through onUsage. chatJson is the same call for any JSON task
// (lib/mailTriage.js uses it for job emails).

import { LlmError, MAX_OUTPUT_TOKENS, parseLabels, requestError, retryInvalidJsonOnce, SYSTEM_PROMPT, userPrompt } from './llm.js';

const header = (res, name) => {
  const value = res.headers?.get?.(name);
  return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
};

// One call in JSON mode. Returns the reply text (JSON, not yet checked).
export async function chatJson({ url, label, apiKey, model, system, user, reasoningEffort, maxOutputTokens = MAX_OUTPUT_TOKENS, timeoutMs = 10_000, fetchImpl = fetch, onUsage }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: maxOutputTokens,
        // Reasoning models spend tokens thinking before answering; labeling needs little or none.
        ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw requestError(err, label, timeoutMs);
  }

  if (res.status === 429) throw new LlmError(`${label} rate limit (429)`, 'rate_limit', 429);
  // Groq's own count of requests left today, so we stop before the account runs dry.
  const remainingRequests = header(res, 'x-ratelimit-remaining-requests');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Groq returns 400 json_validate_failed when the model emits invalid JSON in JSON mode.
    if (res.status === 400 && /json_validate_failed/.test(body)) {
      await onUsage?.({ tokens: null, remainingRequests }); // tokens were spent; the budget uses its estimate
      throw new LlmError(`${label} returned invalid JSON`, 'invalid_json', 400);
    }
    throw new LlmError(`${label} HTTP ${res.status}: ${body.slice(0, 200)}`, 'http', res.status);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    await onUsage?.({ tokens: null, remainingRequests });
    throw new LlmError(`${label} response was not JSON`, 'invalid_json');
  }
  await onUsage?.({ tokens: data?.usage?.total_tokens ?? null, remainingRequests });
  return data?.choices?.[0]?.message?.content;
}

// Labels one job. Invalid JSON is retried once; any other failure throws immediately.
export async function classifyWithOpenAiChat(job, options) {
  const { extraExclude = [], cities = [], maxDescriptionChars, label } = options;
  const call = async () =>
    parseLabels(await chatJson({ ...options, system: SYSTEM_PROMPT, user: userPrompt(job, { extraExclude, cities, maxDescriptionChars }) }), label);
  return retryInvalidJsonOnce(call);
}
