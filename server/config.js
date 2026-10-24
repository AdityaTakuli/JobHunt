import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const env = process.env;

const emailList = (value) =>
  String(value || '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && value !== '' && value != null ? n : fallback;
};

export const config = {
  port: num(env.PORT, 3000),
  isProduction: env.NODE_ENV === 'production',
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),

  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: num(env.DB_PORT, 3306),
    user: env.DB_USER || 'archjobs',
    password: env.DB_PASSWORD || '',
    database: env.DB_NAME || 'archjobs',
  },

  auth: {
    // The owner's password (signs in as the owner account). Empty = auth disabled (local dev only).
    password: env.APP_PASSWORD || '',
    sessionSecret: env.SESSION_SECRET || '',
    sessionDays: 30,
    // The owner's Google account: signing in with it opens the owner account (user 1).
    ownerEmail: emailList(env.OWNER_EMAIL)[0] || '',
    // Extra people who can manage access and see the Activity tab.
    adminEmails: emailList(env.ADMIN_EMAILS),
    // Who may sign in with Google besides the owner and admins: a list of emails, or * for anyone.
    // Admins can also add people in Settings > People.
    allowedEmails: emailList(env.ALLOWED_EMAILS),
    // Encrypts stored Gmail tokens. Falls back to SESSION_SECRET.
    tokenSecret: env.TOKEN_SECRET || '',
  },

  // "Sign in with Google" and Gmail job alerts. OAuth client from Google Cloud console, with
  // redirect URI <PUBLIC_URL>/api/auth/google/callback.
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    // Gmail messages read per person per sync.
    gmailMaxMessages: num(env.GMAIL_MAX_MESSAGES, 30),
    // Application emails (applied / interview / offer / rejected) read per person per sync.
    gmailApplicationMessages: num(env.GMAIL_APPLICATION_MESSAGES, 40),
  },

  // Protects /api/cron/* endpoints called by Hostinger cron.
  cronSecret: env.CRON_SECRET || '',
  // Run node-cron inside the app process. Turn off if Hostinger cron calls the endpoints instead.
  enableScheduler: env.ENABLE_SCHEDULER === 'true',

  // SerpApi Google Jobs engine (Google Jobs results incl. LinkedIn, Naukri, Indeed listings).
  serpapi: {
    apiKey: env.SERPAPI_KEY || env.SERPAPI_API_KEY || env.SERPI_API || '',
    monthlyLimit: num(env.SERPAPI_MONTHLY_LIMIT, 250), // Free plan: 250 searches/month
    reserve: num(env.SERPAPI_RESERVE, 10), // stop fetching when this many searches are left
    queriesPerRun: num(env.SERPAPI_QUERIES_PER_RUN, 3),
    // Searches typed on the Jobs page, per IST day (repeats within a few hours are free).
    manualDailyLimit: num(env.SERPAPI_MANUAL_DAILY_LIMIT, 10),
    runsPerDay: 2,
  },

  // Token guardrails shared by the AI classifiers (lib/aiBudget.js).
  ai: {
    // Job descriptions are cut to this many characters before they are sent.
    maxDescriptionChars: num(env.AI_MAX_DESCRIPTION_CHARS, 2500),
    // Longest a call waits for the per-minute token window before the job falls back.
    maxWaitMs: num(env.AI_MAX_WAIT_MS, 30_000),
  },

  // Main AI: the user's FreeLLMAPI gateway (OpenAI-style), which holds the Groq and Gemini keys.
  // Groq and Gemini below are only called directly when their own keys are set here too.
  freellm: {
    url: env.FREELLM_URL || '',
    apiKey: env.FREELLM_API_KEY || '',
    // Models tried in order, comma-separated: gpt-oss-120b and qwen3.8-27b run on Groq (each with
    // its own daily quota), gemini-3.5-flash-lite on Gemini (steadier than flash on the free
    // tier). "auto" lets FreeLLMAPI pick (auto:smart once picked a weak 7B model).
    model: env.FREELLM_MODEL || 'openai/gpt-oss-120b,qwen3.8-27b,gemini-3.5-flash-lite',
    // Models for reading application emails (lib/mailTriage.js). Groq first: it does not train on
    // what it is sent, which matters for people's mail. Empty = the same as FREELLM_MODEL.
    mailModel: env.FREELLM_MAIL_MODEL ?? 'openai/gpt-oss-120b,qwen3.8-27b',
    // gpt-oss always reasons a little; "low" keeps it short. Empty = omit.
    reasoningEffort: env.FREELLM_REASONING_EFFORT ?? 'low',
    // Room for the reasoning plus the ~100-token JSON answer.
    maxOutputTokens: num(env.FREELLM_MAX_OUTPUT_TOKENS, 1_000),
    // FreeLLMAPI may try several of its keys before answering.
    timeoutMs: num(env.FREELLM_TIMEOUT_MS, 30_000),
    minIntervalMs: num(env.FREELLM_MIN_INTERVAL_MS, 2_100),
    limits: {
      dailyTokens: num(env.FREELLM_DAILY_TOKEN_LIMIT, 300_000),
      dailyRequests: num(env.FREELLM_DAILY_REQUEST_LIMIT, 1_000),
      minuteTokens: num(env.FREELLM_MINUTE_TOKEN_LIMIT, 15_000),
      runTokens: num(env.FREELLM_RUN_TOKEN_LIMIT, 80_000),
    },
  },

  groq: {
    apiKey: env.GROQ_API_KEY || '',
    model: env.GROQ_MODEL || 'qwen/qwen3.8-27b',
    // "none" turns off thinking on Qwen; gpt-oss models take low / medium / high. Empty = omit.
    reasoningEffort: env.GROQ_REASONING_EFFORT ?? 'none',
    timeoutMs: 10_000,
    // Free tier allows ~30 requests/minute.
    minIntervalMs: num(env.GROQ_MIN_INTERVAL_MS, 2_100),
    // Free tier: 1,000 requests/day and 8,000 tokens/minute. Stay under both with a margin.
    limits: {
      dailyTokens: num(env.GROQ_DAILY_TOKEN_LIMIT, 150_000),
      dailyRequests: num(env.GROQ_DAILY_REQUEST_LIMIT, 900),
      minuteTokens: num(env.GROQ_MINUTE_TOKEN_LIMIT, 7_000),
      runTokens: num(env.GROQ_RUN_TOKEN_LIMIT, 40_000),
    },
  },

  // Second provider, used when Groq is down, rate-limited or out of budget.
  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    thinkingLevel: env.GEMINI_THINKING_LEVEL ?? 'minimal',
    timeoutMs: 15_000,
    minIntervalMs: num(env.GEMINI_MIN_INTERVAL_MS, 7_000),
    limits: {
      dailyTokens: num(env.GEMINI_DAILY_TOKEN_LIMIT, 100_000),
      dailyRequests: num(env.GEMINI_DAILY_REQUEST_LIMIT, 200),
      minuteTokens: num(env.GEMINI_MINUTE_TOKEN_LIMIT, 30_000),
      runTokens: num(env.GEMINI_RUN_TOKEN_LIMIT, 25_000),
    },
  },


  smtp: {
    host: env.SMTP_HOST || 'smtp.hostinger.com',
    port: num(env.SMTP_PORT, 465),
    secure: env.SMTP_SECURE !== 'false',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASSWORD || '',
    from: env.SMTP_FROM || env.SMTP_USER || '',
  },
};

export const TIMEZONE = 'Asia/Kolkata';
