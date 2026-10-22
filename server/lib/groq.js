// Groq classifier: Groq's OpenAI-style endpoint through lib/openaiChat.js.

import { LlmError } from './llm.js';
import { classifyWithOpenAiChat } from './openaiChat.js';

export { validateLabels } from './llm.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export async function classifyWithGroq(job, options) {
  if (!options.apiKey) throw new LlmError('GROQ_API_KEY is not set', 'not_configured');
  return classifyWithOpenAiChat(job, { timeoutMs: 10_000, ...options, url: GROQ_URL, label: 'Groq' });
}
