export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

export async function api(path, { method = 'GET', body, signal } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('Could not reach the server. Check your connection.', 0);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  if (res.status === 401 && path !== '/login') onUnauthorized();
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data;
}

export function toQuery(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    q.set(k, Array.isArray(v) ? v.join(',') : v === true ? '1' : String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : '';
}
