// FreeLLMAPI classifier, the first provider tried. FreeLLMAPI is the user's own gateway
// (llm.velocitytechnologies.in) that spreads requests over the free AI keys added to it and
// speaks the OpenAI API. Any failure sends the job on to Groq, then Gemini, then the rules.

import { LlmError } from './llm.js';
import { classifyWithOpenAiChat } from './openaiChat.js';

// Accepts the base URL with or without a trailing /v1.
export const freellmChatUrl = (base) => `${String(base || '').replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/chat/completions`;

export async function classifyWithFreeLlm(job, options) {
  if (!options.url || !options.apiKey) throw new LlmError('FREELLM_URL / FREELLM_API_KEY is not set', 'not_configured');
  return classifyWithOpenAiChat(job, { timeoutMs: 30_000, ...options, url: freellmChatUrl(options.url), label: 'FreeLLMAPI' });
}
