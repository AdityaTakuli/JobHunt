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

// Sends a PDF as the request body (the server reads it straight from the body, no form).
export const uploadPdf = (path, file, options = {}) => uploadFile(path, file, { ...options, type: 'application/pdf' });

// Any file as the request body; extra headers (X-Doc-Kind) as given.
export async function uploadFile(path, file, { onProgress, type, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api${path}`);
    xhr.setRequestHeader('Content-Type', type || file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'file'));
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.withCredentials = true;
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError('Could not reach the server. Check your connection.', 0));
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // not JSON
      }
      if (xhr.status === 401) onUnauthorized();
      if (xhr.status < 200 || xhr.status >= 300) return reject(new ApiError(data?.error || `Upload failed (${xhr.status})`, xhr.status));
      resolve(data);
    };
    xhr.send(file);
  });
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
