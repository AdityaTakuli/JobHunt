// Token guardrails for the free AI tiers. Three limits are checked before every call:
//   - session: one classifier instance (one task run) may spend at most `runTokens`;
//   - daily: tokens and requests per provider per IST day, stored in ai_usage so every task and
//     every restart draws from the same budget;
//   - minute: tokens in any 60 s window, so bursts stay under the provider's per-minute limit.
//     A call that does not fit waits for the window to clear, up to maxWaitMs.
// A call that would break a limit is not made. The job goes to the next provider or the rule
// fallback, and the hourly retry-classify re-labels it once budget is back.

import { query } from '../db/pool.js';
import { istDateString } from './time.js';

const MINUTE_MS = 60_000;
// Stop before the provider's own count of requests left today reaches zero.
export const SERVER_REQUEST_RESERVE = 25;

const within = (limit, value) => limit == null || value <= limit;

// Daily totals live in MySQL; the minute window lives in this process and is shared by every
// session in it.
function createDbUsageStore() {
  const windows = new Map();
  return {
    async get(provider, day) {
      const [row] = await query('SELECT requests, tokens FROM ai_usage WHERE provider = ? AND day = ?', [provider, day]);
      return { requests: Number(row?.requests || 0), tokens: Number(row?.tokens || 0) };
    },
    async add(provider, day, tokens) {
      await query(
        `INSERT INTO ai_usage (provider, day, requests, tokens, updated_at) VALUES (?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE requests = requests + 1, tokens = tokens + VALUES(tokens), updated_at = VALUES(updated_at)`,
        [provider, day, tokens, new Date()],
      );
    },
    window(provider) {
      if (!windows.has(provider)) windows.set(provider, []);
      return windows.get(provider);
    },
  };
}

export const dbUsageStore = createDbUsageStore();

// Same interface, in memory. For tests.
export function memoryUsageStore(initial = {}) {
  const days = new Map(Object.entries(initial));
  const windows = new Map();
  return {
    days,
    async get(provider, day) {
      return { requests: 0, tokens: 0, ...days.get(`${provider}:${day}`) };
    },
    async add(provider, day, tokens) {
      const cur = await this.get(provider, day);
      days.set(`${provider}:${day}`, { requests: cur.requests + 1, tokens: cur.tokens + tokens });
    },
    window(provider) {
      if (!windows.has(provider)) windows.set(provider, []);
      return windows.get(provider);
    },
  };
}

// Today's usage for every provider, for the Settings screen.
export async function usageToday(now = new Date()) {
  const rows = await query('SELECT provider, requests, tokens FROM ai_usage WHERE day = ?', [istDateString(now)]);
  return Object.fromEntries(rows.map((r) => [r.provider, { requests: Number(r.requests), tokens: Number(r.tokens) }]));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param provider 'groq' | 'gemini'
 * @param limits { dailyTokens, dailyRequests, minuteTokens, runTokens }; a missing limit is not enforced
 */
export function createBudget(provider, limits = {}, { store = dbUsageStore, maxWaitMs = 30_000, now = Date.now, sleep = defaultSleep } = {}) {
  let runTokens = 0;
  let serverRemaining = null;
  const day = () => istDateString(new Date(now()));

  function windowTokens() {
    const win = store.window(provider);
    const cutoff = now() - MINUTE_MS;
    while (win.length && win[0].at <= cutoff) win.shift();
    return win.reduce((sum, e) => sum + e.tokens, 0);
  }

  // Returns null when a call of `estimate` tokens may go ahead, else the name of the limit it
  // would break.
  async function reserve(estimate) {
    if (!within(limits.runTokens, runTokens + estimate)) return 'run_tokens';
    if (serverRemaining != null && serverRemaining <= SERVER_REQUEST_RESERVE) return 'daily_requests';
    const used = await store.get(provider, day());
    if (!within(limits.dailyRequests, used.requests + 1)) return 'daily_requests';
    if (!within(limits.dailyTokens, used.tokens + estimate)) return 'daily_tokens';

    if (limits.minuteTokens == null) return null;
    if (estimate > limits.minuteTokens) return 'minute_tokens';
    let waited = 0;
    while (windowTokens() + estimate > limits.minuteTokens) {
      const oldest = store.window(provider)[0];
      const wait = oldest.at + MINUTE_MS - now() + 50;
      if (waited + wait > maxWaitMs) return 'minute_tokens';
      await sleep(wait);
      waited += wait;
    }
    return null;
  }

  // Records one call. `tokens` is what the provider reported, or null when it did not say (the
  // estimate is used instead so the budget never under-counts).
  async function record({ tokens, remainingRequests } = {}, estimate = 0) {
    const spent = Number.isFinite(tokens) ? tokens : estimate;
    runTokens += spent;
    store.window(provider).push({ at: now(), tokens: spent });
    if (remainingRequests != null) serverRemaining = remainingRequests;
    await store.add(provider, day(), spent);
  }

  return {
    reserve,
    record,
    get runTokens() {
      return runTokens;
    },
  };
}
