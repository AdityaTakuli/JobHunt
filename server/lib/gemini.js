// Gemini classifier, the second provider after Groq. Same prompt, same output check, same
// LlmError kinds, and token use reported through onUsage.

import { LlmError, MAX_OUTPUT_TOKENS, parseLabels, requestError, retryInvalidJsonOnce, SYSTEM_PROMPT, userPrompt } from './llm.js';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

async function callGemini(job, { apiKey, model, thinkingLevel, timeoutMs, extraExclude, maxDescriptionChars, fetchImpl, onUsage }) {
  let res;
  try {
    res = await fetchImpl(`${GEMINI_URL}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt(job, { extraExclude, maxDescriptionChars }) }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          responseMimeType: 'application/json',
          // Thinking tokens are billed against the quota; labeling does not need them.
          ...(thinkingLevel && { thinkingConfig: { thinkingLevel } }),
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw requestError(err, 'Gemini', timeoutMs);
  }

  if (res.status === 429) throw new LlmError('Gemini rate limit (429)', 'rate_limit', 429);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new LlmError(`Gemini HTTP ${res.status}: ${body.slice(0, 200)}`, 'http', res.status);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    await onUsage?.({ tokens: null });
    throw new LlmError('Gemini response was not JSON', 'invalid_json');
  }
  await onUsage?.({ tokens: data?.usageMetadata?.totalTokenCount ?? null });
  const content = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  return parseLabels(content, 'Gemini');
}

// Labels one job. Invalid JSON is retried once; any other failure throws immediately.
export async function classifyWithGemini(job, options) {
  const { apiKey, model, thinkingLevel = '', timeoutMs = 15_000, extraExclude = [], maxDescriptionChars, fetchImpl = fetch, onUsage } = options;
  if (!apiKey) throw new LlmError('GEMINI_API_KEY is not set', 'not_configured');
  const args = { apiKey, model, thinkingLevel, timeoutMs, extraExclude, maxDescriptionChars, fetchImpl, onUsage };
  return retryInvalidJsonOnce(() => callGemini(job, args));
}
