// ARCH in Chrome: runs in every frame of every page. Finds the fields of an application form,
// asks the ArchJobs server (through the background worker) what goes in each, fills them, and
// marks what it did so the person can check. It never presses a submit button.
//
// Blue outline = taken straight from the CV. Amber outline = written by the AI: read it.

(() => {
  if (window.__archInChrome) return;
  window.__archInChrome = true;

  const isTop = window === window.top;
  const keys = new WeakMap(); // element -> key sent to the server
  const byKey = new Map(); // key -> { el, field, inputs?, items? }
  const undo = []; // { el, prev, classes, title } in fill order
  let seq = 0;
  let busy = false;

  const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const clean = (s) =>
    text(s)
      .replace(/\(?\brequired\b\)?/i, '')
      .replace(/\s*[*:]+\s*$/, '')
      .trim();

  // ---- Finding fields ----

  function visible(el) {
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  const isControl = (el) => el.matches('input, textarea, select, button, [contenteditable="true"], [role="radio"], [role="checkbox"]');

  // A label's text without the values of controls inside it.
  function labelText(label) {
    const copy = label.cloneNode(true);
    for (const c of copy.querySelectorAll('input, select, textarea, button')) c.remove();
    return copy.innerText || copy.textContent;
  }

  // Custom forms: the question is usually the text just before the control, or the heading of
  // the box the control sits in.
  function nearbyText(el) {
    let node = el;
    for (let depth = 0; depth < 5 && node && node !== document.body; depth++) {
      let sib = node.previousElementSibling;
      for (let n = 0; n < 3 && sib; n++, sib = sib.previousElementSibling) {
        if (isControl(sib) || sib.querySelector('input, select, textarea')) break;
        const t = clean(sib.innerText || sib.textContent);
        if (t && t.length <= 200) return t;
      }
      const parent = node.parentElement;
      if (!parent) break;
      if (parent.matches('fieldset')) {
        const legend = parent.querySelector(':scope > legend');
        if (legend) return clean(legend.textContent);
      }
      const head = parent.querySelector('legend, label, h1, h2, h3, h4, h5, h6, [role="heading"], [class*="label" i], [class*="question" i], [class*="title" i]');
      if (head && !head.contains(el) && head.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const t = clean(head.innerText || head.textContent);
        if (t && t.length <= 200) return t;
      }
      node = parent;
    }
    return '';
  }

  // The text a person reads as the question for this control.
  function labelFor(el) {
    const parts = [];
    const push = (s) => {
      const t = clean(s);
      if (t && t.length <= 300 && !parts.includes(t)) parts.push(t);
    };
    const byIds = (attr) => {
      for (const id of (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) {
        const node = document.getElementById(id);
        if (node) push(node.innerText || node.textContent);
      }
    };
    byIds('aria-labelledby');
    if (el.labels?.length) for (const l of el.labels) push(labelText(l));
    push(el.getAttribute('aria-label'));
    if (!parts.length) {
      const wrap = el.closest('label');
      if (wrap) push(labelText(wrap));
    }
    if (!parts.length) push(nearbyText(el));
    return parts.join(' — ').slice(0, 300);
  }

  function keyFor(el) {
    let k = keys.get(el);
    if (!k) {
      k = `f${++seq}`;
      keys.set(el, k);
    }
    return k;
  }

  const optionLabel = (input) =>
    clean(input.labels?.[0] ? labelText(input.labels[0]) : input.closest('label') ? labelText(input.closest('label')) : input.getAttribute('aria-label') || input.value);
  const ariaOption = (item) => clean(item.getAttribute('aria-label') || item.getAttribute('data-value') || item.textContent);

  function collect() {
    byKey.clear();
    const fields = [];
    const radios = new Map(); // group name -> inputs
    const add = (el, field, extra = {}) => {
      const key = keyFor(el);
      byKey.set(key, { el, field, ...extra });
      fields.push({ key, ...field });
    };
    for (const el of document.querySelectorAll('input, textarea, select, [contenteditable="true"]')) {
      if (el.closest('arch-in-chrome, [aria-hidden="true"]')) continue;
      if (el.disabled || el.readOnly) continue;
      if (el.isContentEditable && el.parentElement?.closest('[contenteditable="true"]')) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : '')).toLowerCase();
      if (tag === 'input' && ['hidden', 'submit', 'button', 'reset', 'image', 'password', 'range', 'color', 'search'].includes(type)) continue;
      // Upload boxes are often hidden behind a styled button, so they count when hidden.
      if (type === 'file') {
        add(el, { tag: 'file', type, label: labelFor(el) || nearbyText(el.parentElement || el), name: el.name || '', id: el.id || '' });
        continue;
      }
      if (!visible(el)) continue;
      if (type === 'checkbox') {
        add(el, { tag: 'checkbox', type, label: labelFor(el), name: el.name || '', id: el.id || '', required: el.required });
        continue;
      }
      if (type === 'radio') {
        const group = el.name || keyFor(el);
        if (!radios.has(group)) radios.set(group, []);
        radios.get(group).push(el);
        continue;
      }
      const common = {
        label: labelFor(el),
        name: el.name || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
      };
      if (tag === 'select') {
        add(el, { tag: 'select', type: 'select', ...common, options: [...el.options].map((o) => text(o.textContent)).filter(Boolean) });
      } else if (tag === 'textarea' || el.isContentEditable) {
        add(el, { tag: 'textarea', type: 'textarea', ...common, maxLength: el.maxLength > 0 ? el.maxLength : null });
      } else {
        add(el, { tag: 'input', type: type || 'text', ...common, maxLength: el.maxLength > 0 ? el.maxLength : null });
      }
    }
    for (const inputs of radios.values()) {
      const first = inputs[0];
      const box = first.closest('fieldset, [role="radiogroup"], [role="group"]');
      const label =
        (box && clean(box.querySelector('legend')?.textContent || box.getAttribute('aria-label') || '')) || nearbyText(box || first.parentElement || first) || labelFor(first);
      add(first, { tag: 'radio', type: 'radio', label, name: first.name || '', id: first.id || '', required: first.required, options: inputs.map(optionLabel).filter(Boolean) }, { inputs });
    }
    // Google Forms and the like: radio buttons made of divs.
    for (const group of document.querySelectorAll('[role="radiogroup"]')) {
      const items = [...group.querySelectorAll('[role="radio"]')].filter(visible);
      if (!items.length || items.some((i) => i.tagName === 'INPUT')) continue;
      add(group, { tag: 'radio', type: 'radio', label: labelFor(group) || nearbyText(group), name: '', id: group.id || '', required: group.getAttribute('aria-required') === 'true', options: items.map(ariaOption).filter(Boolean) }, { items });
    }
    return fields;
  }

  // ---- Filling ----

  // React, Vue and Angular forms watch the value setter, so the native one is called.
  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  const fire = (el, names) => names.forEach((n) => el.dispatchEvent(new Event(n, { bubbles: true })));

  function remember(el, prev) {
    undo.push({ el, prev, classes: el.className, title: el.getAttribute('title') });
  }

  function mark(el, ai, note) {
    el.classList.add(ai ? 'arch-filled-ai' : 'arch-filled');
    el.setAttribute('title', ai ? `ARCH: written by the AI, check it${note ? ` (${note})` : ''}` : 'ARCH: from your CV');
  }

  // Writes one answer. Returns true when the page took it.
  function fill(entry, answer) {
    const { el, field } = entry;
    const ai = answer.source === 'ai';
    const want = text(answer.value).toLowerCase();
    if (field.tag === 'radio') {
      const items = entry.inputs || entry.items || [];
      const target = items.find((it) => (entry.inputs ? optionLabel(it) : ariaOption(it)).toLowerCase() === want);
      if (!target) return false;
      const prev = entry.inputs ? items.find((it) => it.checked) : items.find((it) => it.getAttribute('aria-checked') === 'true');
      remember(target, prev || null);
      target.click();
      mark(entry.inputs ? target.closest('label') || target : target, ai, answer.note);
      return true;
    }
    if (field.tag === 'select') {
      const opt = [...el.options].find((o) => text(o.textContent).toLowerCase() === want) || [...el.options].find((o) => text(o.value).toLowerCase() === want);
      if (!opt) return false;
      remember(el, el.value);
      setNative(el, opt.value);
      fire(el, ['input', 'change']);
      mark(el, ai, answer.note);
      return true;
    }
    if (el.isContentEditable) {
      remember(el, el.innerHTML);
      el.focus();
      el.textContent = answer.value;
      fire(el, ['input', 'change']);
      el.blur();
      mark(el, ai, answer.note);
      return true;
    }
    let value = String(answer.value);
    if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    if (field.type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) return false;
    if (el.maxLength > 0) value = value.slice(0, el.maxLength);
    remember(el, el.value);
    el.focus();
    setNative(el, value);
    fire(el, ['input', 'change']);
    el.blur();
    mark(el, ai, answer.note);
    return true;
  }

  // Puts a PDF into an upload box, as if it had been picked.
  function attach(entry, { name, base64 }) {
    const el = entry.el;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'application/pdf' }));
    try {
      el.files = dt.files;
    } catch {
      return false;
    }
    fire(el, ['input', 'change']);
    const shown = visible(el) ? el : el.closest('label') || el.parentElement;
    if (shown) {
      remember(shown, null);
      mark(shown, false);
    }
    return true;
  }

  function undoAll() {
    while (undo.length) {
      const { el, prev, classes, title } = undo.pop();
      try {
        if (el.type === 'radio' || el.getAttribute?.('role') === 'radio') {
          if (prev) prev.click();
          else if (el.type === 'radio') el.checked = false;
        } else if (el.isContentEditable) el.innerHTML = prev ?? '';
        else if (prev != null && 'value' in el && el.type !== 'file') {
          setNative(el, prev);
          fire(el, ['input', 'change']);
        }
        el.className = classes;
        if (title == null) el.removeAttribute('title');
        else el.setAttribute('title', title);
      } catch {
        // the page may have replaced the element
      }
    }
  }

  // ---- One run ----

  const pageContext = () => ({ url: location.href, title: document.title, text: text(document.body?.innerText || '').slice(0, 4000) });

  const WHY = {
    checkbox: 'Tick it yourself',
    never: 'Yours to answer (pay, personal, password)',
    unknown: 'Not on your CV',
    file: 'Attach the file yourself',
    no_file: 'Upload it to ArchJobs first',
    ai_off: 'AI help is off',
    no_ai: 'No AI on the server',
    ai_failed: 'The AI did not answer; try again',
    too_many: 'Too many open questions for one go',
  };

  async function run() {
    if (busy) return;
    busy = true;
    try {
      undoAll();
      const fields = collect();
      if (!fields.length) {
        report({ fields: 0 });
        return;
      }
      if (isTop) showPanel({ loading: true, count: fields.length });
      const r = await chrome.runtime.sendMessage({ type: 'fill-request', fields, page: pageContext() });
      if (!r?.ok) {
        report({ error: r?.data?.error || r?.error || 'The ArchJobs server did not answer.', status: r?.status || 0, fields: fields.length });
        return;
      }
      const data = r.data;
      const labels = new Map(fields.map((f) => [f.key, f.label || f.placeholder || f.name || f.tag]));
      const done = [];
      const aiDone = [];
      const needsYou = [];
      for (const a of data.answers) {
        const entry = byKey.get(a.key);
        if (!entry) continue;
        if (a.source === 'file') {
          const f = await chrome.runtime.sendMessage({ type: 'file', kind: a.file });
          if (f?.base64 && attach(entry, f)) done.push({ key: a.key, label: labels.get(a.key), value: f.name });
          else needsYou.push({ key: a.key, label: labels.get(a.key), why: f?.error || 'Attach the file yourself' });
          continue;
        }
        if (fill(entry, a)) (a.source === 'ai' ? aiDone : done).push({ key: a.key, label: labels.get(a.key), value: a.value, note: a.note });
        else needsYou.push({ key: a.key, label: labels.get(a.key), why: 'The page did not take the value' });
      }
      for (const s of data.skipped) {
        const entry = byKey.get(s.key);
        // Optional tick boxes (newsletters, "remember me") are not worth listing.
        if (s.reason === 'checkbox' && !entry?.field.required) continue;
        needsYou.push({ key: s.key, label: labels.get(s.key), why: WHY[s.reason] || 'Fill it yourself' });
      }
      report({ fields: fields.length, filled: done.length + aiDone.length, done, aiDone, needsYou, ai: data.ai });
    } catch (err) {
      report({ error: err?.message || String(err), fields: 0 });
    } finally {
      busy = false;
    }
  }

  function report(result) {
    try {
      chrome.runtime.sendMessage({ type: 'frame-filled', ...result, filled: result.filled || 0 }).catch(() => {});
    } catch {
      // the extension was reloaded; this page needs a reload too
    }
    if (isTop) onFrameResult({ ...result, frameId: 0 });
  }

  function focusField(key) {
    const entry = byKey.get(key);
    if (!entry) return;
    const el = entry.inputs?.[0] || entry.items?.[0] || entry.el;
    const shown = visible(el) ? el : el.closest('label') || el.parentElement || el;
    shown.scrollIntoView({ behavior: 'smooth', block: 'center' });
    shown.classList.add('arch-focus');
    setTimeout(() => shown.classList.remove('arch-focus'), 1800);
    try {
      el.focus({ preventScroll: true });
    } catch {
      // not focusable
    }
  }

  // ---- The panel (top frame only) ----

  let host = null;
  let root = null;
  const frames = new Map(); // frameId -> that frame's result

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .chip { display: inline-flex; align-items: center; gap: 8px; padding: 9px 12px 9px 9px; border-radius: 999px; background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; border: 0; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
    .chip:hover { background: #1d4ed8; }
    .chip .sub { color: #dbeafe; font-weight: 500; }
    .chip .x { margin-left: 4px; padding: 0 4px; opacity: .8; font-weight: 400; }
    .mark { width: 22px; height: 22px; border-radius: 6px; background: #fff; color: #2563eb; display: inline-grid; place-items: center; font-weight: 800; font-size: 12px; }
    .panel { width: 350px; max-width: calc(100vw - 32px); max-height: min(72vh, 580px); display: flex; flex-direction: column; background: #fff; color: #11141a; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.28); border: 1px solid #e5e7eb; font-size: 13px; overflow: hidden; }
    .panel .mark { background: #2563eb; color: #fff; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    .head b { flex: 1; font-size: 14px; }
    .close { border: 0; background: none; font-size: 20px; cursor: pointer; color: inherit; opacity: .7; line-height: 1; padding: 0 4px; }
    .body { overflow: auto; padding: 10px 12px; }
    .sum { margin: 0 0 8px; line-height: 1.45; }
    .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-weight: 600; font-size: 12px; margin: 0 4px 4px 0; }
    .pill.b { background: #e8efff; color: #1d4ed8; } .pill.a { background: #fef3c7; color: #b45309; } .pill.r { background: #fee2e2; color: #b91c1c; }
    h4 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
    .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid #f1f1f1; }
    .row .l { flex: 1; min-width: 0; }
    .row .l b { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
    .row .l span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .muted { color: #6b7280; font-size: 12px; }
    .go { border: 1px solid #d1d5db; background: #fff; color: #1d4ed8; border-radius: 8px; padding: 3px 10px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .foot { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-top: 1px solid #e5e7eb; }
    .foot .note { flex: 1; font-size: 11.5px; color: #6b7280; line-height: 1.35; }
    .btn { border: 1px solid #d1d5db; background: #fff; color: #11141a; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .btn.p { background: #2563eb; color: #fff; border-color: #2563eb; }
    .err { color: #b91c1c; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #c7d2fe; border-top-color: #2563eb; border-radius: 50%; animation: s .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes s { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) {
      .panel { background: #141414; color: #ededed; border-color: #2a2a2a; }
      .head, .foot { border-color: #2a2a2a; } .row { border-color: #222; }
      .muted, .foot .note, h4 { color: #a3a3a3; }
      .btn, .go { background: #1f1f1f; color: #ededed; border-color: #333; } .go { color: #8ab4ff; }
      .btn.p { background: #2563eb; color: #fff; }
    }
  `;

  function ensureRoot() {
    if (host?.isConnected) return root;
    host = document.createElement('arch-in-chrome');
    host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; right: 16px; bottom: 16px;';
    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    root.appendChild(style);
    (document.body || document.documentElement).appendChild(host);
    return root;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  function render(html) {
    const r = ensureRoot();
    let box = r.querySelector('.box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'box';
      r.appendChild(box);
    }
    box.innerHTML = html;
    return box;
  }

  function hide() {
    host?.remove();
    host = null;
  }

  let chipHidden = false;
  function showChip(count) {
    if (chipHidden || (host && root?.querySelector('.panel'))) return;
    const box = render(
      `<button class="chip" type="button" title="Fill this form from your ArchJobs profile (Alt+Shift+A)"><span class="mark">A</span>Fill with ARCH <span class="sub">· ${count} fields</span><span class="x" title="Hide on this page" aria-label="Hide">✕</span></button>`,
    );
    box.querySelector('.chip').addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) {
        chipHidden = true;
        hide();
        return;
      }
      chrome.runtime.sendMessage({ type: 'fill-this-tab' });
    });
  }

  function rows(list, kind) {
    return list
      .map(
        (it) =>
          `<div class="row"><div class="l"><b title="${esc(it.label)}">${esc(it.label || '(unnamed field)')}</b><span class="muted" title="${esc(kind === 'need' ? it.why : it.value)}">${esc(kind === 'need' ? it.why : kind === 'ai' && it.note ? it.note : it.value || '')}</span></div><button class="go" type="button" data-frame="${it.frameId}" data-key="${esc(it.key)}">Show</button></div>`,
      )
      .join('');
  }

  function showPanel(state) {
    let body;
    let foot = '';
    if (state.loading) {
      body = `<p class="sum"><span class="spin"></span>Reading ${state.count} field${state.count === 1 ? '' : 's'} and matching them with your profile. Open questions take the AI a few seconds…</p>`;
    } else if (state.empty) {
      body = '<p class="sum">No form fields on this page. Open the application form itself, then press <b>Alt+Shift+A</b> or the ARCH button.</p>';
    } else if (state.error) {
      const signIn = state.status === 401;
      body = `<p class="sum err">${esc(state.error)}</p>${signIn ? '<p class="sum muted">ARCH uses your ArchJobs sign-in. Sign in there in this browser, then fill again.</p>' : ''}`;
      foot = `<span class="note"></span>${signIn ? '<button class="btn p" type="button" data-act="open">Open ArchJobs</button>' : '<button class="btn p" type="button" data-act="again">Try again</button>'}`;
    } else {
      const all = [...frames.values()];
      const tagged = (key) => all.flatMap((f) => (f[key] || []).map((x) => ({ ...x, frameId: f.frameId })));
      const done = tagged('done');
      const aiDone = tagged('aiDone');
      const need = tagged('needsYou');
      const ai = all.find((f) => f.ai)?.ai;
      body =
        `<p class="sum"><span class="pill b">${done.length} from your CV</span><span class="pill a">${aiDone.length} written by AI</span><span class="pill r">${need.length} need you</span></p>` +
        (ai?.limited ? `<p class="sum muted">Today's ${ai.limit} AI fills are used, so open questions were left for you.</p>` : '') +
        (ai?.error ? '<p class="sum muted">The AI could not answer the open questions just now. Fill again in a minute.</p>' : '') +
        (need.length ? `<h4>Needs you</h4>${rows(need, 'need')}` : '') +
        (aiDone.length ? `<h4>Written by the AI · read these</h4>${rows(aiDone, 'ai')}` : '') +
        (done.length ? `<h4>From your CV</h4>${rows(done, 'cv')}` : '');
      foot = '<span class="note">Nothing is submitted for you. Check every field, then continue on the page.</span><button class="btn" type="button" data-act="undo">Undo</button><button class="btn p" type="button" data-act="again">Fill again</button>';
    }
    const box = render(
      `<div class="panel" role="dialog" aria-label="ARCH in Chrome"><div class="head"><span class="mark">A</span><b>ARCH in Chrome</b><button class="close" type="button" title="Close" aria-label="Close">×</button></div><div class="body">${body}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</div>`,
    );
    box.querySelector('.close').addEventListener('click', hide);
    box.querySelectorAll('.go').forEach((b) =>
      b.addEventListener('click', () => {
        const frameId = Number(b.dataset.frame);
        if (frameId === 0) focusField(b.dataset.key);
        else chrome.runtime.sendMessage({ type: 'focus-field', frameId, key: b.dataset.key });
      }),
    );
    box.querySelector('[data-act="undo"]')?.addEventListener('click', () => {
      undoAll();
      chrome.runtime.sendMessage({ type: 'undo-all' });
      frames.clear();
      hide();
    });
    box.querySelector('[data-act="again"]')?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'fill-this-tab' }));
    box.querySelector('[data-act="open"]')?.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-site', path: '#/profile' }));
  }

  // Results arrive from this frame and from embedded ones (many job sites put the form in an iframe).
  let emptyTimer = null;
  function onFrameResult(result) {
    if (!isTop) return;
    if (result.error) {
      showPanel({ error: result.error, status: result.status });
      return;
    }
    if (!result.fields) {
      // This frame had no form; wait a moment for an embedded one before saying "nothing here".
      clearTimeout(emptyTimer);
      emptyTimer = setTimeout(() => {
        if (!frames.size) showPanel({ empty: true });
      }, 1500);
      return;
    }
    clearTimeout(emptyTimer);
    frames.set(result.frameId, result);
    showPanel({});
  }

  // ---- Reading postings for ArchJobs ----
  // Job sites like Glassdoor block the ArchJobs server, but show the posting to the person's own
  // browser. On a job page, the posting is sent to ArchJobs, which keeps it only when the page is
  // a job already in ArchJobs. Only the posting text goes, never form contents.

  const DESCRIPTION_SELECTORS = [
    '[class*="JobDetails_jobDescription"]',
    '#jobDescriptionText',
    '.jobs-description__content',
    '.description__text',
    '[data-automation-id="jobPostingDescription"]',
    '[class*="job-description" i]',
    '[class*="jobDescription" i]',
    '[id*="job-description" i]',
    '[class*="job_description" i]',
  ].join(', ');

  function postingOnPage() {
    const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '').filter((t) => /JobPosting/.test(t));
    let pageText = '';
    if (!jsonld.length) {
      const box = document.querySelector(DESCRIPTION_SELECTORS);
      pageText = box ? (box.innerText || '').trim() : '';
    }
    if (!jsonld.length && pageText.length < 300) return null;
    return { url: location.href, jsonld: jsonld.map((t) => t.slice(0, 200_000)), text: pageText.slice(0, 20_000) };
  }

  const sentPostings = new Set();
  async function sendPosting() {
    if (!isTop) return;
    const posting = postingOnPage();
    if (!posting || sentPostings.has(posting.url)) return;
    sentPostings.add(posting.url);
    const r = await chrome.runtime.sendMessage({ type: 'posting-seen', posting }).catch(() => null);
    if (r?.ok && r.data?.saved) toast('ARCH saved this posting to ArchJobs. "Analyse" there now reads the real requirements.');
  }

  function toast(message) {
    if (host && root?.querySelector('.panel')) return;
    const box = render(`<div class="chip" role="status" style="cursor:default"><span class="mark">A</span><span>${esc(message)}</span></div>`);
    box.querySelector('.chip').style.maxWidth = '360px';
    setTimeout(() => {
      if (root?.querySelector('[role="status"]')) hide();
    }, 6000);
  }

  // Job sites change the address without reloading (Glassdoor, LinkedIn): look again when it changes.
  if (isTop) {
    let lastUrl = location.href;
    setTimeout(sendPosting, 1500);
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(sendPosting, 1500);
      }
    }, 1000);
  }

  // ---- Offering to help on application forms ----

  function looksLikeApplication() {
    const inputs = [...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=search]), textarea, select')].filter(
      (el) => el.type === 'file' || visible(el),
    );
    if (inputs.length < 3) return 0;
    const hasFile = inputs.some((el) => el.type === 'file');
    const words = /apply|application|career|job|candidate|recruit|hiring|vacanc|internship|position|opening|resume|\bcv\b/i;
    const page = `${location.href} ${document.title} ${text(document.body?.innerText || '').slice(0, 3000)}`;
    return hasFile || words.test(page) ? inputs.length : 0;
  }

  async function offer() {
    const { server } = await chrome.storage.sync.get('server').catch(() => ({}));
    const own = String(server || 'https://archjobs.velocitytechnologies.in');
    // Not on ArchJobs itself, nor on local development pages.
    if (location.href.startsWith(own) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/(#|$|\?)/.test(location.href)) return;
    const count = looksLikeApplication();
    if (!count) return;
    if (isTop) showChip(count);
    else chrome.runtime.sendMessage({ type: 'form-seen', count }).catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message) => {
    switch (message?.type) {
      case 'fill':
        if (isTop) frames.clear();
        run();
        break;
      case 'frame-result':
        onFrameResult(message);
        break;
      case 'form-available':
        if (isTop) showChip(message.count);
        break;
      case 'focus':
        focusField(message.key);
        break;
      case 'undo':
        undoAll();
        break;
      default:
    }
  });

  // Forms often appear after the page loads: look now and again a little later.
  setTimeout(offer, 800);
  setTimeout(() => {
    if (!host) offer();
  }, 4000);
})();
