// FreeLLMAPI classifier, the main AI. FreeLLMAPI is the user's own gateway
// (llm.velocitytechnologies.in) that holds the Groq and Gemini keys and speaks the OpenAI API.
//
// `model` may list several models, comma-separated (e.g. "openai/gpt-oss-120b,gemini-3.5-flash").
// A pinned model only ever runs on that model's providers, so the list is what lets a Groq
// outage fall through to Gemini. A model that is down (rate limit, outage, timeout) is skipped
// for the rest of the batch; when every model has failed, the job goes to the next provider or
// the keyword rules.

import { LlmError } from './llm.js';
import { classifyWithOpenAiChat } from './openaiChat.js';

// Accepts the base URL with or without a trailing /v1.
export const freellmChatUrl = (base) => `${String(base || '').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;

export const freellmModels = (model) =>
  String(model || '')
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

/**
 * @param options.state per-batch object; remembers models that are down (set by createClassifier)
 */
export async function classifyWithFreeLlm(job, options) {
  if (!options.url || !options.apiKey) throw new LlmError('FREELLM_URL / FREELLM_API_KEY is not set', 'not_configured');
  const state = options.state || {};
  state.downModels ??= new Set();
  const models = freellmModels(options.model).filter((m) => !state.downModels.has(m));
  if (!models.length) throw new LlmError('Every FreeLLMAPI model is down for this batch', 'http');

  let lastError;
  for (const model of models) {
    try {
      return await classifyWithOpenAiChat(job, { timeoutMs: 30_000, ...options, model, url: freellmChatUrl(options.url), label: `FreeLLMAPI ${model}` });
    } catch (err) {
      // Invalid JSON (already retried) is about this job, not the model: try the next model
      // without writing this one off.
      if (err.kind !== 'invalid_json') state.downModels.add(model);
      lastError = err;
    }
  }
  throw lastError;
}
