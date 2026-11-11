// ARCH in Chrome: runs in every frame of every page.
//  - Finds the fields of an application form, asks the ArchJobs server what goes in each, fills
//    them (custom dropdowns and split dates too) and marks what it did. Never presses submit.
//  - Keeps going on the next page of the same application (two hours after a fill in this tab).
//  - Checks the page's own error messages after filling, fixes the common ones, lists the rest.
//  - Tailors the CV and cover letter to this posting on request, and attaches them.
//  - Reads the posting on job pages and sends it to ArchJobs (for sites that block the server).
//  - Offers "Get code from Gmail" next to a one-time-code box, and "Add to tracker" after sending.
//
// Blue outline = from the CV. Amber outline = written by the AI: read it.

(() => {
  if (window.__archInChrome) return;
  window.__archInChrome = true;

  const isTop = window === window.top;
  const keys = new WeakMap(); // element -> key sent to the server
  const handled = new WeakSet(); // elements ARCH filled or already reported, so later passes skip them
  const byKey = new Map(); // key -> { el, field, inputs?, items? }
  const undo = []; // { el, prev, shown, classes, title } in fill order
  let seq = 0;
  let busy = false;
  let sessionActive = false;
  let tailored = null; // { id, match, title, company } for this tab

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const clean = (s) =>
    text(s)
      .replace(/\(?\brequired\b\)?/i, '')
      .replace(/\s*[*:]+\s*$/, '')
      .trim();
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => null);

  // ---- Finding fields ----

  function visible(el) {
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  const isControl = (el) => el.matches('input, textarea, select, button, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="combobox"]');

  function labelText(label) {
    const copy = label.cloneNode(true);
    for (const c of copy.querySelectorAll('input, select, textarea, button')) c.remove();
    return copy.innerText || copy.textContent;
  }

  // The question is often the text just before the control, or the heading of its box.
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

  function labelFor(el) {
    const parts = [];
    const push = (s) => {
      const t = clean(s);
      if (t && t.length <= 300 && !parts.includes(t)) parts.push(t);
    };
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const node = document.getElementById(id);
      if (node) push(node.innerText || node.textContent);
    }
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

  // One box of a date split into day / month / year.
  function datePartOf(el) {
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (ac === 'bday-day') return 'day';
    if (ac === 'bday-month') return 'month';
    if (ac === 'bday-year') return 'year';
    const hint = text(`${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${el.name || ''} ${el.id || ''} ${el.tagName === 'SELECT' ? el.options[0]?.textContent || '' : ''}`).toLowerCase();
    if (/(^|[\s_-])(dd|day)($|[\s_-])/.test(hint)) return 'day';
    if (/(^|[\s_-])(mm|month)($|[\s_-])/.test(hint)) return 'month';
    if (/(^|[\s_-])(yyyy|yy|year)($|[\s_-])/.test(hint)) return 'year';
    return null;
  }

  // A dropdown that is not a <select>: Workday buttons, react-select inputs, ARIA comboboxes.
  const isCustomDropdown = (el) => el.tagName !== 'SELECT' && (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox');

  // Fields already dealt with: filled by ARCH, or holding something the person typed or picked.
  function alreadyAnswered(el, tag) {
    if (handled.has(el)) return true;
    if (tag === 'select') return el.selectedIndex > 0;
    if (tag === 'file') return el.files?.length > 0;
    if (tag === 'custom') return Boolean(text(el.value || el.textContent).length) && !/^(select|choose|--)/i.test(text(el.value || el.textContent));
    if ('value' in el) return Boolean(String(el.value || '').trim());
    return Boolean(text(el.textContent));
  }

  function collect({ onlyNew = false } = {}) {
    if (!onlyNew) byKey.clear();
    const fields = [];
    const radios = new Map();
    const add = (el, field, extra = {}) => {
      const key = keyFor(el);
      byKey.set(key, { el, field, ...extra });
      fields.push({ key, ...field });
    };
    for (const el of document.querySelectorAll('input, textarea, select, [contenteditable="true"], [role="combobox"], [aria-haspopup="listbox"]')) {
      if (el.closest('arch-in-chrome, [aria-hidden="true"]')) continue;
      if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.isContentEditable && el.parentElement?.closest('[contenteditable="true"]')) continue;
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || (tag === 'input' ? 'text' : '')).toLowerCase();
      if (tag === 'input' && ['hidden', 'submit', 'button', 'reset', 'image', 'password', 'range', 'color', 'search'].includes(type)) continue;
      if (isOtpField(el)) continue;
      if (type === 'file') {
        if (onlyNew && alreadyAnswered(el, 'file')) continue;
        add(el, { tag: 'file', type, label: labelFor(el) || nearbyText(el.parentElement || el), name: el.name || '', id: el.id || '' });
        continue;
      }
      if (!visible(el)) continue;
      if (isCustomDropdown(el)) {
        // react-select puts role=combobox on a tiny input inside the visible box: label it from the box.
        if (onlyNew && alreadyAnswered(el, 'custom')) continue;
        add(el, { tag: 'select', type: 'select', custom: true, label: labelFor(el) || nearbyText(el), name: el.name || '', id: el.id || '', required: el.getAttribute('aria-required') === 'true', options: [] });
        continue;
      }
      if (type === 'checkbox') {
        if (onlyNew && handled.has(el)) continue;
        add(el, { tag: 'checkbox', type, label: labelFor(el), name: el.name || '', id: el.id || '', required: el.required });
        continue;
      }
      if (type === 'radio') {
        const group = el.name || keyFor(el);
        if (!radios.has(group)) radios.set(group, []);
        radios.get(group).push(el);
        continue;
      }
      if (onlyNew && alreadyAnswered(el, tag)) continue;
      const part = tag === 'select' || tag === 'input' ? datePartOf(el) : null;
      const own = labelFor(el);
      // A date box labelled just "Day": the question is the group's ("Date of birth").
      let label = own;
      if (part) {
        const group = el.closest('fieldset, [role="group"]');
        const groupLabel = group ? clean(group.querySelector(':scope > legend')?.textContent || group.getAttribute('aria-label') || '') || labelFor(group) : '';
        label = `${groupLabel || nearbyText(el.parentElement || el) || own} (${part})`;
      }
      const common = {
        label,
        name: el.name || '',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        required: el.required || el.getAttribute('aria-required') === 'true',
        ...(part ? { part } : {}),
      };
      if (tag === 'select') add(el, { tag: 'select', type: 'select', ...common, options: [...el.options].map((o) => text(o.textContent)).filter(Boolean) });
      else if (tag === 'textarea' || el.isContentEditable) add(el, { tag: 'textarea', type: 'textarea', ...common, maxLength: el.maxLength > 0 ? el.maxLength : null });
      else add(el, { tag: 'input', type: type || 'text', ...common, maxLength: el.maxLength > 0 ? el.maxLength : null });
    }
    for (const inputs of radios.values()) {
      if (onlyNew && inputs.some((i) => i.checked || handled.has(i))) continue;
      const first = inputs[0];
      const box = first.closest('fieldset, [role="radiogroup"], [role="group"]');
      const label = (box && clean(box.querySelector('legend')?.textContent || box.getAttribute('aria-label') || '')) || nearbyText(box || first.parentElement || first) || labelFor(first);
      add(first, { tag: 'radio', type: 'radio', label, name: first.name || '', id: first.id || '', required: first.required, options: inputs.map(optionLabel).filter(Boolean) }, { inputs });
    }
    for (const group of document.querySelectorAll('[role="radiogroup"]')) {
      const items = [...group.querySelectorAll('[role="radio"]')].filter(visible);
      if (!items.length || items.some((i) => i.tagName === 'INPUT')) continue;
      if (onlyNew && (handled.has(group) || items.some((i) => i.getAttribute('aria-checked') === 'true'))) continue;
      add(group, { tag: 'radio', type: 'radio', label: labelFor(group) || nearbyText(group), name: '', id: group.id || '', required: group.getAttribute('aria-required') === 'true', options: items.map(ariaOption).filter(Boolean) }, { items });
    }
    return fields;
  }

  // ---- Filling ----

  function setNative(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  }
  const fire = (el, names) => names.forEach((n) => el.dispatchEvent(new Event(n, { bubbles: true })));
  const press = (el, key) => {
    for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true }));
  };
  const clickLikeAPerson = (el) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    el.click();
  };

  function remember(el, prev, shown = el) {
    undo.push({ el, prev, shown, classes: shown.className, title: shown.getAttribute('title') });
  }
  function mark(el, ai, note) {
    el.classList.add(ai ? 'arch-filled-ai' : 'arch-filled');
    el.setAttribute('title', ai ? `ARCH: written by the AI, check it${note ? ` (${note})` : ''}` : 'ARCH: from your CV');
  }

  // Best option for any of the wanted wordings: exact, then starts-with, then contains.
  function bestOption(options, wanted, labelOf) {
    const norm = (s) => text(s).toLowerCase();
    for (const how of ['exact', 'start', 'contains']) {
      for (const w of wanted.map(norm).filter(Boolean)) {
        const hit = options.find((o) => {
          const l = norm(labelOf(o));
          return how === 'exact' ? l === w : how === 'start' ? l.startsWith(w) || w.startsWith(l) : l.includes(w);
        });
        if (hit) return hit;
      }
    }
    return null;
  }

  // Opens a custom dropdown, picks the option, and closes it. Options often render elsewhere in
  // the page (a portal), so the whole document is searched for the open listbox.
  async function pickCustom(el, wanted) {
    const before = new Set(document.querySelectorAll('[role="option"]'));
    el.focus();
    clickLikeAPerson(el);
    if (el.tagName === 'INPUT') {
      // Typing filters long lists (country, college) down to the match.
      setNative(el, wanted[0]);
      fire(el, ['input']);
    }
    let options = [];
    for (let i = 0; i < 15; i++) {
      await sleep(100);
      const listbox = el.getAttribute('aria-controls') && document.getElementById(el.getAttribute('aria-controls'));
      options = [...(listbox || document).querySelectorAll('[role="option"]')].filter((o) => visible(o) && (listbox || !before.has(o) || el.getAttribute('aria-expanded') === 'true'));
      if (options.length) break;
    }
    const hit = bestOption(options, wanted, (o) => o.getAttribute('aria-label') || o.textContent);
    if (!hit) {
      press(el, 'Escape');
      if (el.tagName === 'INPUT') {
        setNative(el, '');
        fire(el, ['input']);
      }
      return false;
    }
    hit.scrollIntoView({ block: 'nearest' });
    clickLikeAPerson(hit);
    await sleep(150);
    return true;
  }

  // Writes one answer. Resolves to true when the page took it.
  async function fill(entry, answer) {
    const { el, field } = entry;
    const ai = answer.source === 'ai';
    const want = text(answer.value).toLowerCase();
    if (field.tag === 'radio') {
      const items = entry.inputs || entry.items || [];
      const target = items.find((it) => (entry.inputs ? optionLabel(it) : ariaOption(it)).toLowerCase() === want);
      if (!target) return false;
      const prev = entry.inputs ? items.find((it) => it.checked) : items.find((it) => it.getAttribute('aria-checked') === 'true');
      const shown = entry.inputs ? target.closest('label') || target : target;
      remember(target, prev || null, shown);
      target.click();
      mark(shown, ai, answer.note);
      items.forEach((i) => handled.add(i));
      handled.add(el);
      return true;
    }
    if (field.custom) {
      const box = el.closest('[class*="select" i], [class*="dropdown" i]') || el;
      remember(el, null, box);
      const ok = await pickCustom(el, [answer.value, ...(answer.alts || [])]);
      if (!ok) {
        undo.pop();
        return false;
      }
      mark(box, ai, answer.note);
      handled.add(el);
      return true;
    }
    if (field.tag === 'select') {
      const opt = bestOption([...el.options], [answer.value], (o) => o.textContent) || [...el.options].find((o) => text(o.value).toLowerCase() === want);
      if (!opt) return false;
      remember(el, el.value);
      setNative(el, opt.value);
      fire(el, ['input', 'change']);
      mark(el, ai, answer.note);
      handled.add(el);
      return true;
    }
    if (el.isContentEditable) {
      remember(el, el.innerHTML);
      el.focus();
      el.textContent = answer.value;
      fire(el, ['input', 'change']);
      el.blur();
      mark(el, ai, answer.note);
      handled.add(el);
      return true;
    }
    let value = String(answer.value);
    if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    if (field.type === 'number' && !/^-?\d+(\.\d+)?$/.test(value)) return false;
    if (answer.fact === 'phone') value = phoneFor(el, value);
    if (el.maxLength > 0) value = value.slice(0, el.maxLength);
    remember(el, el.value);
    el.focus();
    setNative(el, value);
    fire(el, ['input', 'change']);
    el.blur();
    mark(el, ai, answer.note);
    handled.add(el);
    return true;
  }

  // Phone: the national number when the form has its own country-code box (so +91 isn't typed
  // twice), or when the box only takes 10 digits.
  function phoneFor(el, value) {
    const digits = value.replace(/\D/g, '');
    const national = digits.length > 10 && /^(91|0)/.test(digits) ? digits.slice(-10) : digits;
    const form = el.closest('form') || document;
    const codeBox = [...form.querySelectorAll('select, input, [role="combobox"], button[aria-haspopup="listbox"]')].some((c) => {
      if (c === el) return false;
      const sig = `${labelFor(c)} ${c.name || ''} ${c.id || ''} ${c.getAttribute('placeholder') || ''}`.toLowerCase();
      const shows = c.tagName === 'SELECT' ? c.options[c.selectedIndex]?.textContent || '' : c.value || c.textContent || '';
      return /country ?code|dial(ing)? ?code|calling code|isd|phone ?code|phone ?prefix/.test(sig) || /^\s*\+\d{1,3}\b/.test(shows);
    });
    const tight = (el.maxLength > 0 && el.maxLength <= 11) || /^\[?\\?d\{10\}/.test(el.getAttribute('pattern') || '') || /10[- ]digit/i.test(`${el.getAttribute('placeholder') || ''} ${labelFor(el)}`);
    return codeBox || tight ? national : value;
  }

  function attach(entry, { name, base64, mime = 'application/pdf' }) {
    const el = entry.el;
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: mime }));
    try {
      el.files = dt.files;
    } catch {
      return false;
    }
    fire(el, ['input', 'change']);
    const shown = (visible(el) ? el : el.closest('label') || el.parentElement) || el;
    remember(el, null, shown);
    mark(shown, false);
    handled.add(el);
    return true;
  }

  function undoAll() {
    while (undo.length) {
      const { el, prev, shown, classes, title } = undo.pop();
      try {
        if (el.type === 'radio' || el.getAttribute?.('role') === 'radio') {
          if (prev) prev.click();
          else if (el.type === 'radio') el.checked = false;
        } else if (el.type === 'file') {
          el.value = '';
          fire(el, ['input', 'change']);
        } else if (el.isContentEditable) el.innerHTML = prev ?? '';
        else if (prev != null && 'value' in el) {
          setNative(el, prev);
          fire(el, ['input', 'change']);
        }
        shown.className = classes;
        if (title == null) shown.removeAttribute('title');
        else shown.setAttribute('title', title);
        handled.delete(el);
      } catch {
        // the page may have replaced the element
      }
    }
  }

  // ---- After filling: the page's own error messages ----

  function errorFor(el) {
    if (el.validity && !el.validity.valid && el.validationMessage) return el.validationMessage;
    const invalid = el.getAttribute('aria-invalid') === 'true';
    let box = el.parentElement;
    for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
      for (const id of (el.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)) {
        const d = document.getElementById(id);
        const t = d && visible(d) ? clean(d.textContent) : '';
        if (t && /invalid|required|must|please|enter a|not valid|format|too (long|short)|error/i.test(t)) return t;
      }
      const msg = [...box.querySelectorAll('[role="alert"], [class*="error" i], [id*="error" i], [class*="invalid" i], [class*="helper-text" i]')].find((m) => visible(m) && clean(m.textContent) && clean(m.textContent).length < 200 && !m.contains(el));
      if (msg) return clean(msg.textContent);
      if (!invalid) break;
    }
    return invalid ? 'The page marked this field as not valid' : null;
  }

  // Tries the usual fixes once; returns the problems still showing.
  async function checkAndFix(filledEntries) {
    await sleep(600);
    const problems = [];
    for (const { entry, answer } of filledEntries) {
      const el = entry.el;
      let message = errorFor(el);
      if (!message || !('value' in el)) {
        if (message) problems.push({ key: keyFor(el), message });
        continue;
      }
      const tries = [];
      const v = String(el.value || '');
      if (answer.fact === 'phone') tries.push(v.replace(/\D/g, '').slice(-10), `+91${v.replace(/\D/g, '').slice(-10)}`, `0${v.replace(/\D/g, '').slice(-10)}`);
      if (el.getAttribute('pattern') && /\d/.test(v)) tries.push(v.replace(/\D/g, ''));
      if (el.maxLength > 0 && v.length > el.maxLength) tries.push(v.slice(0, el.maxLength));
      for (const t of tries) {
        if (!t || t === el.value) continue;
        setNative(el, t);
        fire(el, ['input', 'change']);
        el.blur();
        await sleep(250);
        message = errorFor(el);
        if (!message) break;
      }
      if (message) problems.push({ key: keyFor(el), message });
    }
    return problems;
  }

  // ---- One run ----

  const pageContext = () => ({ url: location.href, title: document.title, text: text(document.body?.innerText || '').slice(0, 4000) });

  const WHY = {
    checkbox: 'Tick it yourself',
    never: 'Yours to answer (pay, personal, password)',
    unknown: 'Not on your CV',
    file: 'Pick one with “Attach from ArchJobs” below it',
    no_file: 'Not in your ArchJobs files yet: use “Attach from ArchJobs” or add it on your Profile',
    ai_off: 'AI help is off',
    no_ai: 'No AI on the server',
    ai_failed: 'The AI did not answer; try again',
    too_many: 'Too many open questions for one go',
  };

  // Results so far in this frame (later pages add to them).
  let acc = { done: [], aiDone: [], needsYou: [] };

  async function run({ auto = false } = {}) {
    if (busy) return;
    busy = true;
    try {
      if (!auto) {
        undoAll();
        acc = { done: [], aiDone: [], needsYou: [] };
      }
      const fields = collect({ onlyNew: auto });
      if (!fields.length) {
        if (!auto) report({ fields: 0 });
        return;
      }
      if (!auto && !tailored) await tailorFirst();
      if (isTop && !auto) showPanel({ loading: true, count: fields.length });
      const r = await send({ type: 'fill-request', fields, page: pageContext(), auto });
      if (!r?.ok) {
        if (!auto) report({ error: r?.data?.error || r?.error || 'The ArchJobs server did not answer.', status: r?.status || 0, fields: fields.length });
        return;
      }
      const data = r.data;
      const labels = new Map(fields.map((f) => [f.key, f.label || f.placeholder || f.name || f.tag]));
      const filled = [];
      for (const a of data.answers) {
        const entry = byKey.get(a.key);
        if (!entry) continue;
        if (a.source === 'file') {
          const f = await send({ type: 'file', kind: a.file });
          if (f?.base64 && attach(entry, f)) acc.done.push({ key: a.key, label: labels.get(a.key), value: f.name });
          else acc.needsYou.push({ key: a.key, label: labels.get(a.key), why: f?.error || 'Attach the file yourself' });
          continue;
        }
        if (await fill(entry, a)) {
          filled.push({ entry, answer: a });
          (a.source === 'ai' ? acc.aiDone : acc.done).push({ key: a.key, label: labels.get(a.key), value: a.value, note: a.source === 'tailored' ? 'from your tailored cover letter' : a.note });
        } else acc.needsYou.push({ key: a.key, label: labels.get(a.key), why: entry.field.custom ? 'Pick it from the list yourself' : 'The page did not take the value' });
      }
      for (const s of data.skipped) {
        const entry = byKey.get(s.key);
        if (entry) handled.add(entry.el);
        if (s.reason === 'checkbox' && !entry?.field.required) continue;
        acc.needsYou.push({ key: s.key, label: labels.get(s.key), why: WHY[s.reason] || 'Fill it yourself' });
      }
      // The page's own complaints, after the usual fixes.
      const problems = await checkAndFix(filled);
      for (const p of problems) {
        const label = labels.get(p.key) || 'A field';
        acc.needsYou.push({ key: p.key, label, why: `Page says: ${p.message}` });
      }
      report({ fields: fields.length, filled: acc.done.length + acc.aiDone.length, ...acc, ai: data.ai, auto });
      sessionActive = true;
      busy = false;
      // Next step by itself, or stop and call the person (never the final submit).
      addPickers();
      nextStep(problems);
    } catch (err) {
      if (!auto) report({ error: err?.message || String(err), fields: 0 });
    } finally {
      busy = false;
    }
  }

  function report(result) {
    send({ type: 'frame-filled', ...result, filled: result.filled || 0 });
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

  // ---- Next pages of the same application ----
  // After a fill in this tab, new fields (the next step of a multi-page form, or a section that
  // opens) are filled as they appear. Fields that already hold something are left alone.

  let pending = null;
  function watchForNewFields() {
    const observer = new MutationObserver(() => {
      if (!sessionActive || busy) return;
      clearTimeout(pending);
      pending = setTimeout(() => {
        if (collect({ onlyNew: true }).length) run({ auto: true });
        if (sessionActive) addPickers();
        checkOtp();
        checkConfirmation();
      }, 1200);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ---- Moving through the form, and stopping for the person ----
  // After a fill, ARCH presses Next / Continue by itself, page after page. It never presses the
  // final button: Submit, Apply, Send, Finish, Confirm, Pay or Review-and-submit. It stops, and
  // sends a notification, whenever something needs the person: a required field it could not
  // answer, an error the page shows, a CAPTCHA, a code, terms to accept, or the final submit.

  const FINAL = /submit|apply|send|finish|complete|confirm|place order|\bpay\b|review and submit|done|sign and|e-?sign|register/i;
  const NEXT = /^(next|continue|save (and|&) (continue|next)|save & next|proceed|next step|go to next|continue to|move on|forward)\b/i;
  const MAX_STEPS = 15;

  const buttonLabel = (b) => text(b.innerText || b.value || b.getAttribute('aria-label') || b.title || '');
  function pageButtons() {
    return [...document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a[class*="btn" i], a[class*="button" i]')].filter(
      (b) => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && !b.closest('arch-in-chrome') && buttonLabel(b).length <= 40,
    );
  }

  // Required fields still empty, as labels.
  function requiredEmpty() {
    const out = [];
    const seenGroups = new Set();
    for (const el of document.querySelectorAll('input, select, textarea, [role="combobox"], [role="radiogroup"]')) {
      if (el.closest('arch-in-chrome') || !visible(el)) continue;
      const required = el.required || el.getAttribute('aria-required') === 'true';
      if (!required) continue;
      if (el.type === 'radio') {
        if (seenGroups.has(el.name)) continue;
        seenGroups.add(el.name);
        if (![...document.getElementsByName(el.name)].some((r) => r.checked)) out.push(nearbyText(el.closest('fieldset') || el) || 'A choice');
        continue;
      }
      if (el.getAttribute('role') === 'radiogroup') {
        if (!el.querySelector('[aria-checked="true"]')) out.push(labelFor(el) || 'A choice');
        continue;
      }
      if (el.type === 'checkbox') {
        if (!el.checked) out.push(labelFor(el) || 'A tick box');
        continue;
      }
      if (el.type === 'file') {
        if (!el.files?.length) out.push(`${labelFor(el) || 'A file upload'} (use “Attach from ArchJobs”)`);
        continue;
      }
      const empty = el.tagName === 'SELECT' ? el.selectedIndex <= 0 && !el.value : !String(el.value ?? el.textContent ?? '').trim();
      if (empty) out.push(labelFor(el) || el.getAttribute('placeholder') || 'A required field');
    }
    return [...new Set(out)].slice(0, 6);
  }

  const hasCaptcha = () => Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, .cf-turnstile'));

  function notify(title, message) {
    send({ type: 'notify', title, message });
  }

  let stepping = false;
  // Decides what happens after a fill on this page: next step, or stop and call the person.
  async function nextStep(problems) {
    if (stepping) return;
    stepping = true;
    try {
      const settings = await chrome.storage.sync.get({ autoNext: true });
      await sleep(500);
      const missing = requiredEmpty();
      const reasons = [];
      if (problems.length) reasons.push(`${problems.length} field${problems.length === 1 ? '' : 's'} the page says ${problems.length === 1 ? 'is' : 'are'} wrong`);
      if (missing.length) reasons.push(`required: ${missing.join(', ')}`);
      if (hasCaptcha()) reasons.push('a "not a robot" check');
      if (otpBoxes().length) reasons.push('a code sent to you (use "Get code from Gmail")');
      const buttons = pageButtons();
      const final = buttons.find((b) => FINAL.test(buttonLabel(b)) && !NEXT.test(buttonLabel(b)));
      const next = buttons.find((b) => NEXT.test(buttonLabel(b)) && !FINAL.test(buttonLabel(b)));

      if (reasons.length) {
        notify('ARCH needs you', `Filled what it could on this page. Needs you: ${reasons.join('; ')}.`);
        setNote(`Needs you: ${reasons.join('; ')}.`, 'warn');
        return;
      }
      if (final && !next) {
        notify('Ready to submit', `Everything ARCH could fill is filled${document.title ? ` on "${document.title.slice(0, 60)}"` : ''}. Check it, then press "${buttonLabel(final)}" yourself.`);
        setNote(`All filled. Check everything, then press "${buttonLabel(final)}" yourself. ARCH never submits.`, 'done');
        final.classList.add('arch-focus');
        return;
      }
      if (next && settings.autoNext) {
        const state = (await send({ type: 'tab-state' })) || {};
        const steps = (state.steps || 0) + 1;
        if (steps > MAX_STEPS) {
          notify('ARCH stopped', 'This form has many steps; ARCH stopped moving forward. Carry on yourself.');
          return;
        }
        await send({ type: 'tab-state-set', patch: { steps } });
        setNote(`Going to the next step ("${buttonLabel(next)}")…`);
        const before = location.href;
        const fieldsBefore = collect({ onlyNew: false }).length;
        await sleep(900);
        clickLikeAPerson(next);
        // Still on the same step after a while: the page refused (an error it shows, or a field
        // ARCH could not see). Ask the person.
        await sleep(3000);
        if (location.href === before && document.contains(next) && visible(next) && collect({ onlyNew: false }).length === fieldsBefore) {
          const left = requiredEmpty();
          const errors = [...document.querySelectorAll('[role="alert"], [class*="error" i]')].filter((m) => visible(m) && clean(m.textContent)).map((m) => clean(m.textContent)).slice(0, 2);
          notify('ARCH needs you', `The form did not go to the next step.${errors.length ? ` It says: ${errors.join(' / ').slice(0, 160)}` : ''}${left.length ? ` Required: ${left.join(', ')}` : ''}`);
          setNote('The form did not move on. Check the page for a message, then press Next yourself.', 'warn');
        }
        return;
      }
      if (next) {
        notify('Page filled', `Check this page, then press "${buttonLabel(next)}".`);
        return;
      }
      notify('Page filled', 'ARCH filled this page. Check it before you continue.');
    } finally {
      stepping = false;
    }
  }

  // ---- "Attach from ArchJobs": pick a saved file for any upload box ----
  // A small button beside every upload box opens her saved files (this job's tailored CV and
  // letter, the CV and portfolio from her Profile, and her other documents). One click attaches it.

  const pickerFor = new WeakMap(); // file input -> its button host
  const DOC_LABEL = { resume: 'CV', portfolio: 'Portfolio', cover_letter: 'Cover letter', certificate: 'Certificate', work_sample: 'Work sample', other: 'Document' };

  // Does the box take this kind of file? (accept=".pdf,.doc" or "image/*")
  function accepts(input, doc) {
    const accept = (input.getAttribute('accept') || '').toLowerCase().split(',').map((a) => a.trim()).filter(Boolean);
    if (!accept.length) return true;
    const ext = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx' }[doc.mime] || '';
    return accept.some((a) => a === doc.mime || a === ext || (ext === '.jpg' && a === '.jpeg') || (a.endsWith('/*') && doc.mime.startsWith(a.slice(0, -1))));
  }

  // Where the button goes: after the visible part of the upload box.
  const uploadBox = (input) => (visible(input) ? input : input.closest('label') || input.closest('[class*="upload" i], [class*="drop" i], [class*="file" i]') || input.parentElement);

  function addPickers() {
    for (const input of document.querySelectorAll('input[type="file"]')) {
      if (input.disabled || pickerFor.has(input) || input.closest('arch-in-chrome, arch-attach')) continue;
      const box = uploadBox(input);
      if (!box || !visible(box)) continue;
      const hostEl = document.createElement('arch-attach');
      hostEl.style.cssText = 'all: initial; display: inline-block; position: relative; margin: 6px 0 2px; z-index: 2147483000;';
      const shadow = hostEl.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .open { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #c7d2fe; background: #eef2ff; color: #1d4ed8; border-radius: 8px; padding: 5px 10px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
        .open:hover { background: #e0e7ff; }
        .mark { width: 16px; height: 16px; border-radius: 4px; background: #2563eb; color: #fff; display: inline-grid; place-items: center; font-weight: 800; font-size: 10px; }
        .menu { position: absolute; left: 0; top: calc(100% + 4px); width: 300px; max-height: 300px; overflow: auto; background: #fff; color: #11141a; border: 1px solid #e5e7eb; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.2); padding: 4px; }
        .menu[hidden] { display: none; }
        .item { display: flex; gap: 8px; align-items: center; width: 100%; text-align: left; border: 0; background: none; padding: 7px 8px; border-radius: 7px; cursor: pointer; font-size: 13px; color: inherit; }
        .item:hover, .item:focus { background: #f1f5f9; outline: none; }
        .item b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; }
        .tag { font-size: 11px; color: #6b7280; }
        .tag.t { color: #1d4ed8; font-weight: 600; }
        .msg { padding: 8px; font-size: 12.5px; color: #6b7280; }
        @media (prefers-color-scheme: dark) { .menu { background: #141414; color: #ededed; border-color: #2a2a2a; } .item:hover, .item:focus { background: #222; } .tag { color: #a3a3a3; } .open { background: #111827; border-color: #1e3a8a; color: #8ab4ff; } }
      </style><button class="open" type="button" aria-haspopup="menu" aria-expanded="false"><span class="mark">A</span>Attach from ArchJobs</button><div class="menu" role="menu" hidden></div>`;
      const button = shadow.querySelector('.open');
      const menu = shadow.querySelector('.menu');
      const close = () => {
        menu.hidden = true;
        button.setAttribute('aria-expanded', 'false');
      };
      button.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!menu.hidden) return close();
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        menu.innerHTML = '<div class="msg">Loading your files…</div>';
        const r = await send({ type: 'documents' });
        if (!r?.ok) {
          menu.innerHTML = `<div class="msg">${esc(r?.data?.error || 'Could not load your files.')}</div>`;
          return;
        }
        const docs = r.data.documents.filter((d) => accepts(input, d));
        if (!docs.length) {
          menu.innerHTML = '<div class="msg">None of your saved files fit this box. Add files on your ArchJobs Profile page.</div>';
          return;
        }
        menu.innerHTML = docs
          .map(
            (d) =>
              `<button class="item" role="menuitem" type="button" data-id="${esc(d.id)}" data-tailored="${d.tailored ? 1 : ''}"><span><b title="${esc(d.name)}">${esc(d.name)}</b><span class="tag ${d.tailored ? 't' : ''}">${d.tailored ? 'Tailored to this job' : esc(DOC_LABEL[d.kind] || 'Document')}${d.main ? ' · from your Profile' : ''}</span></span></button>`,
          )
          .join('');
        menu.querySelectorAll('.item').forEach((item) =>
          item.addEventListener('click', async () => {
            const kind = item.dataset.tailored ? item.dataset.id : `doc:${item.dataset.id}`;
            menu.innerHTML = '<div class="msg">Attaching…</div>';
            const fileData = await send({ type: 'file', kind });
            close();
            if (fileData?.base64 && attach({ el: input }, fileData)) {
              button.innerHTML = `<span class="mark">A</span>Attached: ${esc(fileData.name).slice(0, 40)} · change`;
            } else {
              button.innerHTML = `<span class="mark">A</span>${esc(fileData?.error || 'Could not attach it')} · try again`;
            }
          }),
        );
      });
      document.addEventListener('click', (e) => !hostEl.contains(e.target) && close(), true);
      box.insertAdjacentElement('afterend', hostEl);
      pickerFor.set(input, hostEl);
    }
  }

  // ---- One-time codes ----

  function isOtpField(el) {
    if (el.tagName !== 'INPUT') return false;
    if ((el.getAttribute('autocomplete') || '').toLowerCase() === 'one-time-code') return true;
    const sig = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.name || ''} ${el.id || ''} ${el.labels?.[0]?.textContent || ''}`.toLowerCase();
    return /\botp\b|one[- ]?time|verification ?code|security ?code|passcode|confirmation ?code|enter (the )?code|\bcode\b.*(sent|email)/.test(sig);
  }
  // A code split over one-letter boxes counts as one field.
  function otpBoxes() {
    const inputs = [...document.querySelectorAll('input')].filter((el) => visible(el) && !el.disabled);
    const direct = inputs.filter(isOtpField);
    if (direct.length) return direct;
    const singles = inputs.filter((el) => el.maxLength === 1 && /text|tel|number|^$/.test(el.type || ''));
    return singles.length >= 4 && singles.length <= 8 ? singles : [];
  }

  let otpOffered = false;
  function checkOtp() {
    if (otpOffered || !otpBoxes().length) return;
    otpOffered = true;
    if (isTop) showOtpChip(0);
    else send({ type: 'otp-seen' });
  }

  function typeCode(code) {
    const boxes = otpBoxes();
    if (!boxes.length) return false;
    if (boxes.length === 1) {
      setNative(boxes[0], code);
      fire(boxes[0], ['input', 'change']);
      mark(boxes[0], false);
      return true;
    }
    [...code].slice(0, boxes.length).forEach((ch, i) => {
      boxes[i].focus();
      setNative(boxes[i], ch);
      fire(boxes[i], ['input', 'change']);
      press(boxes[i], ch);
    });
    boxes.forEach((b) => mark(b, false));
    return true;
  }

  // ---- After sending: offer to add it to the tracker ----

  const SENT = /thank(s| you) for (applying|your application|your interest)|application (has been |was )?(submitted|received|sent|complete)|we('ve| have) received your application|successfully (applied|submitted)|your application is (in|complete)/i;
  const SUBMIT = /^(submit|apply|send|finish|complete)\b|submit application|send application|apply now/i;

  function watchSubmits() {
    const note = () => send({ type: 'tab-state-set', patch: { pendingSubmit: Date.now() } });
    document.addEventListener('submit', () => sessionActive && note(), true);
    document.addEventListener(
      'click',
      (e) => {
        if (!sessionActive) return;
        const b = e.target.closest?.('button, input[type="submit"], [role="button"], a');
        if (b && SUBMIT.test(text(b.innerText || b.value || b.getAttribute('aria-label')))) note();
      },
      true,
    );
  }

  let confirmShown = false;
  async function checkConfirmation() {
    if (!isTop || confirmShown) return;
    const state = await send({ type: 'tab-state' });
    if (!state?.pendingSubmit || state.tracked || Date.now() - state.pendingSubmit > 30 * 60_000) return;
    if (!SENT.test(text(document.body?.innerText || '').slice(0, 5000))) return;
    confirmShown = true;
    showTrackChip(state);
  }

  // ---- Reading postings for ArchJobs ----

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

  function postingMeta(posting) {
    for (const block of posting.jsonld) {
      try {
        const data = JSON.parse(block);
        const all = [].concat(data['@graph'] || data);
        const p = all.find((x) => [].concat(x?.['@type'] || []).includes('JobPosting'));
        if (p) return { title: p.title || null, company: p.hiringOrganization?.name || null };
      } catch {
        // not JSON
      }
    }
    return { title: document.title.split(/[|\-–]/)[0].trim() || null, company: null };
  }

  const sentPostings = new Set();
  async function sendPosting() {
    if (!isTop) return;
    const posting = postingOnPage();
    if (!posting || sentPostings.has(posting.url)) return;
    sentPostings.add(posting.url);
    const r = await send({ type: 'posting-seen', posting, meta: postingMeta(posting) });
    if (r?.ok && r.data?.saved) toast('ARCH saved this posting to ArchJobs. "Analyse" there now reads the real requirements.');
  }

  // ---- The panel (top frame only) ----

  let host = null;
  let root = null;
  const frames = new Map();

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .chip { display: inline-flex; align-items: center; gap: 8px; padding: 9px 12px 9px 9px; border-radius: 999px; background: #2563eb; color: #fff; font-size: 14px; font-weight: 600; border: 0; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.25); max-width: 380px; text-align: left; }
    .chip:hover { background: #1d4ed8; }
    .chip .sub { color: #dbeafe; font-weight: 500; }
    .chip .x { margin-left: 4px; padding: 0 4px; opacity: .8; font-weight: 400; }
    .chip.note { cursor: default; background: #1e293b; font-weight: 500; }
    .chip .act { margin-left: 4px; background: #fff; color: #1d4ed8; border-radius: 999px; padding: 3px 10px; font-weight: 700; border: 0; cursor: pointer; font-size: 13px; white-space: nowrap; }
    .mark { width: 22px; height: 22px; border-radius: 6px; background: #fff; color: #2563eb; display: inline-grid; place-items: center; font-weight: 800; font-size: 12px; flex: none; }
    .panel { width: 360px; max-width: calc(100vw - 32px); max-height: min(76vh, 620px); display: flex; flex-direction: column; background: #fff; color: #11141a; border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.28); border: 1px solid #e5e7eb; font-size: 13px; overflow: hidden; }
    .panel .mark { background: #2563eb; color: #fff; }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #e5e7eb; }
    .head b { flex: 1; font-size: 14px; }
    .close { border: 0; background: none; font-size: 20px; cursor: pointer; color: inherit; opacity: .7; line-height: 1; padding: 0 4px; }
    .body { overflow: auto; padding: 10px 12px; }
    .sum { margin: 0 0 8px; line-height: 1.45; }
    .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-weight: 600; font-size: 12px; margin: 0 4px 4px 0; }
    .pill.b { background: #e8efff; color: #1d4ed8; } .pill.a { background: #fef3c7; color: #b45309; } .pill.r { background: #fee2e2; color: #b91c1c; }
    .tailor { border: 1px solid #c7d2fe; background: #f5f7ff; border-radius: 10px; padding: 8px 10px; margin: 0 0 8px; line-height: 1.45; }
    .tailor b { color: #1d4ed8; }
    .tailor .links { margin-top: 4px; display: flex; gap: 10px; }
    .tailor a, .linkish { color: #1d4ed8; cursor: pointer; text-decoration: underline; background: none; border: 0; padding: 0; font: inherit; }
    h4 { margin: 12px 0 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #6b7280; }
    .row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-top: 1px solid #f1f1f1; }
    .row .l { flex: 1; min-width: 0; }
    .row .l b { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
    .row .l span { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .muted { color: #6b7280; font-size: 12px; }
    .go { border: 1px solid #d1d5db; background: #fff; color: #1d4ed8; border-radius: 8px; padding: 3px 10px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .foot { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px 12px; border-top: 1px solid #e5e7eb; }
    .foot .note { flex: 1 1 100%; font-size: 11.5px; color: #6b7280; line-height: 1.35; }
    .btn { border: 1px solid #d1d5db; background: #fff; color: #11141a; border-radius: 8px; padding: 6px 10px; cursor: pointer; font-size: 12px; font-weight: 600; }
    .btn.p { background: #2563eb; color: #fff; border-color: #2563eb; }
    .btn:disabled { opacity: .6; cursor: default; }
    .err { color: #b91c1c; }
    .stepnote { margin: 0 0 8px; padding: 7px 10px; border-radius: 8px; background: #eff6ff; color: #1e3a8a; line-height: 1.4; }
    .stepnote.is-warn { background: #fff7ed; color: #9a3412; }
    .stepnote.is-done { background: #ecfdf5; color: #065f46; font-weight: 600; }
    .spin { display: inline-block; width: 12px; height: 12px; border: 2px solid #c7d2fe; border-top-color: #2563eb; border-radius: 50%; animation: s .8s linear infinite; vertical-align: -2px; margin-right: 6px; }
    @keyframes s { to { transform: rotate(360deg); } }
    @media (prefers-color-scheme: dark) {
      .panel { background: #141414; color: #ededed; border-color: #2a2a2a; }
      .head, .foot { border-color: #2a2a2a; } .row { border-color: #222; }
      .muted, .foot .note, h4 { color: #a3a3a3; }
      .btn, .go { background: #1f1f1f; color: #ededed; border-color: #333; } .go { color: #8ab4ff; }
      .btn.p { background: #2563eb; color: #fff; }
      .tailor { background: #111827; border-color: #1e3a8a; } .tailor b, .tailor a, .linkish { color: #8ab4ff; }
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
  const panelOpen = () => Boolean(host && root?.querySelector('.panel'));
  function hide() {
    host?.remove();
    host = null;
  }

  let chipHidden = false;
  function showChip(count) {
    if (chipHidden || panelOpen()) return;
    const box = render(
      `<button class="chip" type="button" title="Fill this form from your ArchJobs profile (Alt+Shift+A)"><span class="mark">A</span>Fill with ARCH <span class="sub">· ${count} fields</span><span class="x" title="Hide on this page" aria-label="Hide">✕</span></button>`,
    );
    box.querySelector('.chip').addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) {
        chipHidden = true;
        hide();
        return;
      }
      send({ type: 'fill-this-tab' });
    });
  }

  function toast(message, ms = 6000) {
    if (panelOpen()) return;
    render(`<div class="chip note" role="status"><span class="mark">A</span><span>${esc(message)}</span></div>`);
    setTimeout(() => {
      if (root?.querySelector('[role="status"]')) hide();
    }, ms);
  }

  function showOtpChip(frameId) {
    if (panelOpen()) return;
    const box = render(`<div class="chip note" role="status"><span class="mark">A</span><span>A code was sent to you?</span><button class="act" type="button">Get code from Gmail</button><span class="x" aria-label="Hide">✕</span></div>`);
    box.querySelector('.x').addEventListener('click', hide);
    box.querySelector('.act').addEventListener('click', async (e) => {
      e.target.textContent = 'Reading Gmail…';
      e.target.disabled = true;
      const r = await send({ type: 'otp', host: location.hostname });
      if (!r?.ok) {
        toast(r?.data?.error || 'Could not read Gmail.', 8000);
        otpOffered = false;
        return;
      }
      if (frameId) send({ type: 'otp-fill', frameId, code: r.data.code });
      else typeCode(r.data.code);
      toast(`Code ${r.data.code} typed in, from ${r.data.from || 'your email'}. Check it, then continue.`, 8000);
    });
  }

  function showTrackChip(state) {
    if (panelOpen()) return;
    const role = state.job?.title ? `${state.job.title}${state.job.company ? ` at ${state.job.company}` : ''}` : 'this application';
    const box = render(`<div class="chip note" role="status"><span class="mark">A</span><span>Sent? Add ${esc(role)} to your tracker.</span><button class="act" type="button">Add as Applied</button><span class="x" aria-label="Not now">✕</span></div>`);
    box.querySelector('.x').addEventListener('click', hide);
    box.querySelector('.act').addEventListener('click', async () => {
      const r = await send({ type: 'track-applied', url: location.href, title: document.title });
      toast(r?.ok ? 'Added to your ArchJobs tracker as Applied.' : r?.data?.error || 'Could not add it to the tracker.');
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

  function tailorBlock(state) {
    if (state.tailoring) return '<div class="tailor"><span class="spin"></span>Tailoring your CV and cover letter to this posting. Under a minute…</div>';
    if (!tailored) return '';
    const m = tailored.match || {};
    const match = m.before != null ? ` Keyword match <b>${m.before}% → ${m.after}%</b>.` : '';
    const missing = m.missing?.length ? `<div class="muted">Asked for, not on your CV (left out, not invented): ${esc(m.missing.join(', '))}</div>` : '';
    return `<div class="tailor">Using your CV tailored to this job.${match}${missing}<div class="links"><button class="linkish" type="button" data-open="/api/tailor/${tailored.id}/cv.pdf">View CV</button><button class="linkish" type="button" data-open="/api/tailor/${tailored.id}/letter.pdf">View cover letter</button></div></div>`;
  }

  let lastState = {};
  let note = null; // { text, tone } shown at the top of the panel
  function setNote(textLine, tone = 'info') {
    note = { text: textLine, tone };
    if (!isTop) return;
    if (panelOpen()) showPanel(lastState);
    else toast(textLine, tone === 'info' ? 3000 : 12000);
  }
  const noteBlock = () => (note ? `<p class="stepnote is-${note.tone}">${esc(note.text)}</p>` : '');
  function showPanel(state) {
    lastState = state;
    let body;
    let foot = '';
    if (state.loading) {
      body = `${noteBlock()}${tailorBlock(state)}${state.count ? `<p class="sum"><span class="spin"></span>Reading ${state.count} field${state.count === 1 ? '' : 's'} and matching them with your profile. Open questions take the AI a few seconds…</p>` : ''}`;
    } else if (state.empty) {
      body = '<p class="sum">No form fields on this page. Open the application form itself, then press <b>Alt+Shift+A</b> or the ARCH button.</p>';
    } else if (state.error) {
      const signIn = state.status === 401;
      body = `<p class="sum err">${esc(state.error)}</p>${signIn ? '<p class="sum muted">ARCH uses your ArchJobs sign-in. Sign in there in this browser, then fill again.</p>' : ''}`;
      foot = signIn ? '<button class="btn p" type="button" data-act="open">Open ArchJobs</button>' : '<button class="btn p" type="button" data-act="again">Try again</button>';
    } else {
      const all = [...frames.values()];
      const tagged = (key) => all.flatMap((f) => (f[key] || []).map((x) => ({ ...x, frameId: f.frameId })));
      const done = tagged('done');
      const aiDone = tagged('aiDone');
      const need = tagged('needsYou');
      const ai = all.find((f) => f.ai)?.ai;
      body =
        noteBlock() +
        tailorBlock(state) +
        `<p class="sum"><span class="pill b">${done.length} from your CV</span><span class="pill a">${aiDone.length} written by AI</span><span class="pill r">${need.length} need you</span></p>` +
        (ai?.limited ? `<p class="sum muted">Today's ${ai.limit} AI fills are used, so open questions were left for you.</p>` : '') +
        (ai?.error ? '<p class="sum muted">The AI could not answer the open questions just now. Fill again in a minute.</p>' : '') +
        (need.length ? `<h4>Needs you</h4>${rows(need, 'need')}` : '') +
        (aiDone.length ? `<h4>Written by the AI · read these</h4>${rows(aiDone, 'ai')}` : '') +
        (done.length ? `<h4>From your CV</h4>${rows(done, 'cv')}` : '');
      foot =
        '<span class="note">Nothing is submitted for you. Check every field, then continue. ARCH keeps filling the next pages.</span>' +
        (tailored ? '' : `<button class="btn" type="button" data-act="tailor" ${state.tailoring ? 'disabled' : ''}>Tailor CV &amp; letter</button>`) +
        '<button class="btn" type="button" data-act="undo">Undo</button><button class="btn p" type="button" data-act="again">Fill again</button>';
    }
    const box = render(
      `<div class="panel" role="dialog" aria-label="ARCH in Chrome"><div class="head"><span class="mark">A</span><b>ARCH in Chrome</b><button class="close" type="button" title="Close" aria-label="Close">×</button></div><div class="body">${body}</div>${foot ? `<div class="foot">${foot}</div>` : ''}</div>`,
    );
    box.querySelector('.close').addEventListener('click', hide);
    box.querySelectorAll('.go').forEach((b) =>
      b.addEventListener('click', () => {
        const frameId = Number(b.dataset.frame);
        if (frameId === 0) focusField(b.dataset.key);
        else send({ type: 'focus-field', frameId, key: b.dataset.key });
      }),
    );
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => send({ type: 'open-api', path: b.dataset.open })));
    box.querySelector('[data-act="undo"]')?.addEventListener('click', () => {
      undoAll();
      send({ type: 'undo-all' });
      frames.clear();
      hide();
    });
    box.querySelector('[data-act="again"]')?.addEventListener('click', () => send({ type: 'fill-this-tab' }));
    box.querySelector('[data-act="open"]')?.addEventListener('click', () => send({ type: 'open-site', path: '#/profile' }));
    box.querySelector('[data-act="tailor"]')?.addEventListener('click', tailorNow);
  }

  // Before the first page of an application: a CV and letter tailored to the posting this tab
  // came from, when that setting is on. If it fails, the stored CV is used.
  async function tailorFirst() {
    const { autoTailor } = await chrome.storage.sync.get({ autoTailor: true });
    if (!autoTailor) return;
    const state = (await send({ type: 'tab-state' })) || {};
    const posting = state.job?.posting || postingOnPage();
    if (!posting || state.tailorTried) return;
    await send({ type: 'tab-state-set', patch: { tailorTried: true } });
    if (isTop) showPanel({ tailoring: true, loading: true, count: 0 });
    const r = await send({ type: 'tailor', url: location.href, posting });
    if (r?.ok) tailored = { id: r.data.tailored.id, match: r.data.tailored.match, title: r.data.tailored.title, company: r.data.tailored.company };
    else note = { text: `Could not tailor your CV (${r?.data?.error || 'no answer'}); using your uploaded CV.`, tone: 'warn' };
  }

  // Tailor to the posting this tab came from (or this page), then fill again with the new CV.
  async function tailorNow() {
    showPanel({ ...lastState, tailoring: true });
    const posting = postingOnPage();
    const r = await send({ type: 'tailor', url: location.href, posting: posting || { url: location.href, jsonld: [], text: text(document.body?.innerText || '').slice(0, 8000), title: document.title } });
    if (!r?.ok) {
      showPanel({ error: r?.data?.error || 'Could not tailor your CV just now.', status: r?.status });
      return;
    }
    tailored = { id: r.data.tailored.id, match: r.data.tailored.match, title: r.data.tailored.title, company: r.data.tailored.company };
    send({ type: 'fill-this-tab' });
  }

  let emptyTimer = null;
  function onFrameResult(result) {
    if (!isTop) return;
    if (result.error) {
      showPanel({ error: result.error, status: result.status });
      return;
    }
    if (!result.fields) {
      clearTimeout(emptyTimer);
      emptyTimer = setTimeout(() => {
        if (!frames.size) showPanel({ empty: true });
      }, 1500);
      return;
    }
    clearTimeout(emptyTimer);
    frames.set(result.frameId, result);
    // A later page filled on its own: a short note rather than the whole panel.
    showPanel({});
  }

  // ---- Offering help ----

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

  async function start() {
    const { server } = await chrome.storage.sync.get('server').catch(() => ({}));
    const own = String(server || 'https://archjobs.velocitytechnologies.in');
    if (location.href.startsWith(own) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/(#|$|\?)/.test(location.href)) return;
    const state = (await send({ type: 'tab-state' })) || {};
    tailored = state.tailored || null;
    sessionActive = Boolean(state.sessionAt);
    watchForNewFields();
    watchSubmits();
    if (isTop) {
      sendPosting();
      checkConfirmation();
    }
    checkOtp();
    // The next page of an application this tab is filling: carry on without being asked.
    if (sessionActive) {
      if (collect({ onlyNew: true }).length) run({ auto: true });
      return;
    }
    const count = looksLikeApplication();
    if (!count) return;
    addPickers();
    // Filling automatically (the default): no button to press.
    const { autoFill } = await chrome.storage.sync.get({ autoFill: true });
    if (autoFill) {
      run();
      return;
    }
    if (isTop) showChip(count);
    else send({ type: 'form-seen', count });
  }

  chrome.runtime.onMessage.addListener((message) => {
    switch (message?.type) {
      case 'fill':
        if (isTop) frames.clear();
        send({ type: 'tab-state' }).then((s) => {
          tailored = s?.tailored || tailored;
          run();
        });
        break;
      case 'frame-result':
        onFrameResult(message);
        break;
      case 'form-available':
        if (isTop) showChip(message.count);
        break;
      case 'otp-available':
        if (isTop) showOtpChip(message.frameId);
        break;
      case 'otp-code':
        typeCode(message.code);
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

  // Job sites change the address without reloading (Glassdoor, LinkedIn): look again when it changes.
  if (isTop) {
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => {
          sendPosting();
          checkConfirmation();
        }, 1500);
      }
    }, 1000);
  }

  setTimeout(start, 800);
})();
