// Usage statistics for the owner's Admin page: the name of what was pressed, nothing typed.
// Names are queued and sent in small batches (server: POST /api/events, lib/events.js keeps only
// known names). Failures are ignored: statistics never get in the way of using the app.

let queue = [];
let timer = null;

function flush() {
  timer = null;
  if (!queue.length) return;
  const body = JSON.stringify({ events: queue.splice(0, 50) });
  try {
    fetch('/api/events', { method: 'POST', credentials: 'same-origin', keepalive: true, headers: { 'Content-Type': 'application/json' }, body }).catch(() => {});
  } catch {
    // offline or blocked: drop it
  }
  if (queue.length) timer = setTimeout(flush, 1000);
}

export function track(name) {
  if (typeof name !== 'string' || !name) return;
  queue.push(name);
  if (queue.length >= 20) flush();
  else if (!timer) timer = setTimeout(flush, 4000);
}

// Send what is queued before the tab goes away.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      clearTimeout(timer);
      flush();
    }
  });
}
