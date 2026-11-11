// ARCH in Chrome: the service worker. The only part that talks to the ArchJobs server (with the
// person's normal ArchJobs sign-in), the switchboard between the popup, the keyboard shortcut and
// the content scripts in each frame, and the keeper of each tab's application state: the job being
// applied for, its tailored CV, and whether ARCH is filling this tab (so later pages of the same
// form are filled too, even on another site).

const DEFAULT_SERVER = 'https://archjobs.velocitytechnologies.in';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SESSION_MS = 2 * 60 * 60 * 1000; // a tab stays "applying" for two hours after a fill

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

// ---- Per-tab state (chrome.storage.session: survives the worker sleeping, gone when Chrome closes) ----

const tabKey = (tabId) => `tab:${tabId}`;
async function tabState(tabId) {
  const key = tabKey(tabId);
  const state = (await chrome.storage.session.get(key))[key] || {};
  if (state.sessionAt && Date.now() - state.sessionAt > SESSION_MS) delete state.sessionAt;
  return state;
}
async function setTabState(tabId, patch) {
  const next = { ...(await tabState(tabId)), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k];
  await chrome.storage.session.set({ [tabKey(tabId)]: next });
  return next;
}
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)).catch(() => {}));

// ---- Calls ----

async function status() {
  const base = await serverUrl();
  const r = await api('/profile/extension');
  if (r.status === 401) return { server: base, signedIn: false };
  if (!r.ok) return { server: base, signedIn: false, error: r.data?.error || `The server answered ${r.status}.` };
  return { server: base, signedIn: true, ...r.data };
}

// A PDF for an upload box, as base64: the stored CV/portfolio, or the tailored CV / letter.
async function file(kind, tailoredId) {
  const base = await serverUrl();
  // kind: resume / portfolio / letter (tailored versions when this tab has them), doc:<id> for a
  // library file, or tailored-cv / tailored-letter picked by hand.
  const docId = String(kind).startsWith('doc:') ? String(kind).slice(4) : null;
  const path = docId
    ? `/documents/${encodeURIComponent(docId)}/file`
    : kind === 'tailored-cv' && tailoredId
      ? `/tailor/${tailoredId}/cv.pdf`
      : kind === 'tailored-letter' && tailoredId
        ? `/tailor/${tailoredId}/letter.pdf`
        : tailoredId && kind === 'resume'
          ? `/tailor/${tailoredId}/cv.pdf`
          : tailoredId && kind === 'letter'
            ? `/tailor/${tailoredId}/letter.pdf`
            : kind === 'letter'
              ? null
              : `/profile/file/${kind}`;
  if (!path) return { error: 'Tailor your CV for this job first: that writes the cover letter.' };
  let res;
  try {
    res = await fetch(`${base}/api${path}`, { credentials: 'include' });
  } catch {
    return { error: 'Could not reach the server.' };
  }
  if (!res.ok) return { error: res.status === 404 ? `No ${kind === 'resume' ? 'CV' : kind} in ArchJobs yet.` : `The server answered ${res.status}.` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_FILE_BYTES) return { error: 'The file is too big to attach automatically.' };
  const disposition = res.headers.get('content-disposition') || '';
  const star = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = disposition.match(/filename="([^"]+)"/i);
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : `${kind}.pdf`;
  const view = new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  return { name, base64: btoa(binary), mime: (res.headers.get('content-type') || 'application/pdf').split(';')[0] };
}

async function fillTab(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'fill' });
    return { ok: true };
  } catch {
    return { ok: false, error: 'ARCH cannot run on this page. Reload the page and try again.' };
  }
}

const toTopFrame = (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {});

async function onMessage(message, sender) {
  const tabId = sender.tab?.id;
  switch (message?.type) {
    case 'status':
      return status();
    case 'set-server':
      await chrome.storage.sync.set({ server: String(message.server || '').trim().replace(/\/+$/, '') || DEFAULT_SERVER });
      return status();
    case 'fill-active-tab': {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab ? fillTab(tab.id) : { ok: false, error: 'No tab.' };
    }
    case 'open-site':
      await chrome.tabs.create({ url: `${await serverUrl()}/${message.path || ''}` });
      return { ok: true };
    case 'open-api':
      await chrome.tabs.create({ url: `${await serverUrl()}${message.path}` });
      return { ok: true };

    case 'tab-state':
      return tabId != null ? tabState(tabId) : {};
    case 'tab-state-set':
      return tabId != null ? setTabState(tabId, message.patch || {}) : {};

    case 'fill-request': {
      const state = tabId != null ? await tabState(tabId) : {};
      const r = await api('/profile/fill', { method: 'POST', body: { page: message.page, fields: message.fields, ai: message.ai !== false, tailoredId: state.tailoredId || null } });
      if (r.ok && tabId != null && !message.auto) await setTabState(tabId, { sessionAt: Date.now(), startUrl: state.startUrl || message.page?.url });
      return r;
    }
    case 'file': {
      const state = tabId != null ? await tabState(tabId) : {};
      return file(message.kind, state.tailoredId);
    }
    // Everything she can attach, for the "Attach from ArchJobs" picker: this job's tailored CV and
    // letter first, then her library (CV and portfolio from the Profile page, and the rest).
    case 'documents': {
      const state = tabId != null ? await tabState(tabId) : {};
      const r = await api('/documents');
      if (!r.ok) return r;
      const tailored = state.tailoredId
        ? [
            { id: 'tailored-cv', kind: 'resume', name: `CV tailored to ${state.tailored?.company || 'this job'}`, mime: 'application/pdf', tailored: true },
            { id: 'tailored-letter', kind: 'cover_letter', name: `Cover letter for ${state.tailored?.company || 'this job'}`, mime: 'application/pdf', tailored: true },
          ]
        : [];
      return { ok: true, data: { documents: [...tailored, ...r.data.documents] } };
    }
    case 'tailor': {
      const state = tabId != null ? await tabState(tabId) : {};
      const job = state.job || {};
      const r = await api('/tailor', { method: 'POST', body: { url: job.url || message.url, posting: job.posting || message.posting, refresh: Boolean(message.refresh) } });
      if (r.ok && tabId != null) await setTabState(tabId, { tailoredId: r.data.tailored.id, tailored: { id: r.data.tailored.id, match: r.data.tailored.match, title: r.data.tailored.title, company: r.data.tailored.company } });
      return r;
    }
    // A job page's posting, read in the person's browser: remembered for this tab (to tailor to and
    // to name the role in the tracker) and sent to ArchJobs to keep, when it is a job ArchJobs has.
    case 'posting-seen': {
      if (tabId != null) await setTabState(tabId, { job: { url: message.posting.url, title: message.meta?.title || null, company: message.meta?.company || null, posting: message.posting } });
      return api('/jobs/posting', { method: 'POST', body: message.posting });
    }
    case 'otp':
      return api(`/profile/otp?host=${encodeURIComponent(message.host || '')}`);
    case 'track-applied': {
      const state = tabId != null ? await tabState(tabId) : {};
      const r = await api('/applications/from-page', {
        method: 'POST',
        body: { url: state.job?.url || state.startUrl || message.url, title: state.job?.title || message.title, company: state.job?.company || message.company },
      });
      if (r.ok && tabId != null) await setTabState(tabId, { tracked: true, pendingSubmit: null });
      return r;
    }

    // "ARCH needs you" / "Ready to submit": a system notification that opens the tab when clicked.
    case 'notify': {
      if (tabId == null) return null;
      const id = `arch-${tabId}-${Date.now()}`;
      await chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: String(message.title || 'ARCH in Chrome').slice(0, 80),
        message: String(message.message || '').slice(0, 300),
        contextMessage: sender.tab?.title?.slice(0, 80) || '',
        priority: 2,
        requireInteraction: /needs you|ready to submit/i.test(message.title || ''),
      });
      await chrome.storage.session.set({ [`note:${id}`]: { tabId, windowId: sender.tab?.windowId } });
      return null;
    }

    // Results and requests between frames.
    case 'frame-filled':
      if (tabId != null) {
        if (sender.frameId) toTopFrame(tabId, { ...message, type: 'frame-result', frameId: sender.frameId });
        chrome.action.setBadgeBackgroundColor({ color: '#2563eb', tabId });
        if (message.filled) chrome.action.setBadgeText({ text: String(message.filled), tabId });
      }
      return null;
    case 'form-seen':
      if (tabId != null) toTopFrame(tabId, { type: 'form-available', frameId: sender.frameId, count: message.count });
      return null;
    case 'otp-seen':
      if (tabId != null) toTopFrame(tabId, { type: 'otp-available', frameId: sender.frameId });
      return null;
    case 'otp-fill':
      if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'otp-code', code: message.code }, { frameId: message.frameId }).catch(() => {});
      return null;
    case 'focus-field':
      if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'focus', key: message.key }, { frameId: message.frameId }).catch(() => {});
      return null;
    case 'undo-all':
      if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'undo' }).catch(() => {});
      return null;
    case 'fill-this-tab':
      if (tabId != null) fillTab(tabId);
      return null;
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  onMessage(message, sender).then(sendResponse, (err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

chrome.notifications.onClicked.addListener(async (id) => {
  const key = `note:${id}`;
  const target = (await chrome.storage.session.get(key))[key];
  chrome.notifications.clear(id);
  if (!target) return;
  await chrome.tabs.update(target.tabId, { active: true }).catch(() => {});
  if (target.windowId != null) await chrome.windows.update(target.windowId, { focused: true }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'fill-page') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) fillTab(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
});
