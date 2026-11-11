// ARCH in Chrome: the service worker. The only part that talks to the ArchJobs server (with the
// person's normal ArchJobs sign-in), and the switchboard between the popup, the keyboard shortcut
// and the content scripts in each frame of a tab.

const DEFAULT_SERVER = 'https://archjobs.velocitytechnologies.in';
const MAX_FILE_BYTES = 20 * 1024 * 1024; // a PDF bigger than this is left for the person to attach

async function serverUrl() {
  const { server } = await chrome.storage.sync.get('server');
  return String(server || DEFAULT_SERVER).replace(/\/+$/, '');
}

// One call to the ArchJobs API. Resolves to { ok, status, data } and never throws.
async function api(path, { method = 'GET', body } = {}) {
  const base = await serverUrl();
  try {
    const res = await fetch(`${base}/api${path}`, {
      method,
      credentials: 'include',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      // no JSON body
    }
    if (res.status === 401) data = { ...(data || {}), error: 'Sign in to ArchJobs in this browser first.' };
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: `Could not reach ${base}. Check the server address in the ARCH popup.` } };
  }
}

// Who is signed in and whether there is a profile to fill from.
async function status() {
  const base = await serverUrl();
  const r = await api('/profile/extension');
  if (r.status === 401) return { server: base, signedIn: false };
  if (!r.ok) return { server: base, signedIn: false, error: r.data?.error || `The server answered ${r.status}.` };
  return { server: base, signedIn: true, ...r.data };
}

// The stored CV or portfolio as base64, for a form's upload box.
async function file(kind) {
  const base = await serverUrl();
  let res;
  try {
    res = await fetch(`${base}/api/profile/file/${kind}`, { credentials: 'include' });
  } catch {
    return { error: 'Could not reach the server.' };
  }
  if (!res.ok) return { error: res.status === 404 ? `No ${kind === 'resume' ? 'CV' : 'portfolio'} uploaded to ArchJobs.` : `The server answered ${res.status}.` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) return { error: 'The file is too big to attach automatically.' };
  const disposition = res.headers.get('content-disposition') || '';
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="([^"]+)"/i);
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `${kind}.pdf`;
  // Base64 in chunks: a 10 MB buffer is too much for one String.fromCharCode call.
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  return { name, base64: btoa(binary) };
}

// Tells every frame of a tab to collect its fields and fill them.
async function fillTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'fill' });
    return { ok: true };
  } catch {
    // No content script here (chrome:// pages, the Web Store, a tab opened before install).
    return { ok: false, error: 'ARCH cannot run on this page. Reload the page and try again.' };
  }
}

const toTopFrame = (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  const reply = (p) => p.then(sendResponse, (err) => sendResponse({ error: err?.message || String(err) }));
  switch (message?.type) {
    case 'status':
      reply(status());
      return true;
    case 'set-server':
      reply(chrome.storage.sync.set({ server: String(message.server || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER }).then(status));
      return true;
    case 'fill-active-tab':
      reply(chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => (tab ? fillTab(tab.id) : { ok: false, error: 'No tab.' })));
      return true;
    case 'open-site':
      reply(serverUrl().then((base) => chrome.tabs.create({ url: `${base}/${message.path || ''}` })).then(() => ({ ok: true })));
      return true;
    // From a content script: answers for the fields it found.
    case 'fill-request':
      reply(api('/profile/fill', { method: 'POST', body: { page: message.page, fields: message.fields, ai: message.ai !== false } }));
      return true;
    case 'file':
      reply(file(message.kind));
      return true;
    // A job page's posting, read in the person's browser, for ArchJobs to keep (when it is a job
    // ArchJobs already has). Not signed in: nothing happens.
    case 'posting-seen':
      reply(api('/jobs/posting', { method: 'POST', body: message.posting }));
      return true;
    // A frame finished filling: the top frame shows the summary.
    case 'frame-filled':
      if (tabId != null) {
        if (sender.frameId) toTopFrame(tabId, { ...message, type: 'frame-result', frameId: sender.frameId });
        chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId });
        if (message.filled) chrome.action.setBadgeText({ text: String(message.filled), tabId });
      }
      return false;
    // A frame (often an embedded one) found an application form: the top frame shows the button.
    case 'form-seen':
      if (tabId != null) toTopFrame(tabId, { type: 'form-available', frameId: sender.frameId, count: message.count });
      return false;
    case 'focus-field':
      if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'focus', key: message.key }, { frameId: message.frameId }).catch(() => {});
      return false;
    case 'undo-all':
      if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'undo' }).catch(() => {});
      return false;
    case 'fill-this-tab':
      if (tabId != null) fillTab(tabId);
      return false;
    default:
      return false;
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) fillTab(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
});
