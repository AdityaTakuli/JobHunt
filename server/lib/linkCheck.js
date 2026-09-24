// Checks an apply link at ingest. Returns 'ok', 'broken' or 'unknown'.
// Only a clear signal (404/410 or an "expired" page) marks a link broken; bot walls,
// timeouts and odd status codes (LinkedIn's 999) stay 'unknown' so good jobs are not flagged.

const EXPIRED_RE = /no longer accepting applications|this job (is|has) (no longer available|expired|been closed)|job (has )?expired|position has been filled|job posting (has been )?(removed|closed)/i;
const MAX_BYTES = 400_000;

async function readStart(res) {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return text;
}

export async function checkLink(url, { fetchImpl = fetch, timeoutMs = 8_000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
    });
    if (res.status === 404 || res.status === 410) {
      res.body?.cancel().catch(() => {});
      return 'broken';
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return 'unknown';
    }
    const type = res.headers.get('content-type') || '';
    if (!type.includes('html')) {
      res.body?.cancel().catch(() => {});
      return 'ok';
    }
    return EXPIRED_RE.test(await readStart(res)) ? 'broken' : 'ok';
  } catch {
    return 'unknown';
  }
}

// Runs fn over items with a small concurrency limit.
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
