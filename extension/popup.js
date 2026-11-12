// The popup: is the person signed in, is there a profile to fill from, and a button to fill the page.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function show(s) {
  $('server').value = s.server || '';
  const yes = '<span class="ok">✓</span>';
  const no = '<span class="no">–</span>';
  let html;
  if (s.error && !s.signedIn) {
    html = `<p class="err">${esc(s.error)}</p>`;
  } else if (!s.signedIn) {
    html = '<p style="margin-bottom:6px"><b>Not signed in.</b></p><p class="muted">ARCH uses your ArchJobs sign-in. Open ArchJobs in this browser, sign in, then come back.</p>';
  } else {
    html =
      `<p style="margin-bottom:6px">Signed in as <b>${esc(s.user?.name || s.user?.email || 'you')}</b></p>` +
      `<div class="line"><span>Application details saved</span>${s.details ? yes : no}</div>` +
      `<div class="line"><span>Profile read from your CV / portfolio</span>${s.ready ? yes : no}</div>` +
      `<div class="line"><span>CV to attach</span>${s.resume ? yes : s.general_cv ? '<span class="ok">My CV</span>' : no}</div>` +
      `<div class="line"><span>Portfolio uploaded</span>${s.portfolio ? yes : no}</div>` +
      `<div class="line"><span>AI answers today</span><span>${s.fills?.today ?? 0} / ${s.fills?.limit ?? '–'}${s.ai ? '' : ' (off)'}</span></div>` +
      (s.status === 'building' ? '<p class="muted" style="margin-top:6px">Your profile is being read right now.</p>' : '') +
      (s.details_missing?.length ? `<p class="muted" style="margin-top:6px">Still needed in your details: ${esc(s.details_missing.join(', ').replace(/_/g, ' '))}.</p>` : '') +
      (!s.ready && s.status !== 'building' ? '<p class="muted" style="margin-top:6px">Fill in your application details (or upload your CV) in ArchJobs so there is something to fill from.</p>' : '');
  }
  $('status').innerHTML = html;
  $('fill').disabled = !(s.signedIn && s.ready);
}

chrome.runtime.sendMessage({ type: 'status' }).then(show, (err) => show({ error: err.message }));

// The two automatic behaviours, both on unless switched off.
chrome.storage.sync.get({ autoFillFromArch: false, autoTailor: true, autoNext: true }).then((s) => {
  $('autoFill').checked = s.autoFillFromArch;
  $('autoTailor').checked = s.autoTailor;
  $('autoNext').checked = s.autoNext;
});
for (const id of ['autoFill', 'autoTailor', 'autoNext']) $(id).addEventListener('change', (e) => chrome.storage.sync.set({ [id === 'autoFill' ? 'autoFillFromArch' : id]: e.target.checked }));

$('fill').addEventListener('click', async () => {
  $('fill').textContent = 'Filling…';
  const r = await chrome.runtime.sendMessage({ type: 'fill-active-tab' });
  if (r?.ok) window.close();
  else {
    $('fill').textContent = 'Fill this page';
    $('fillError').hidden = false;
    $('fillError').textContent = r?.error || 'Could not fill this page.';
  }
});
$('open').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-site', path: '#/profile' }));
$('details').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-site', path: '#/profile?details=1' }));
$('save').addEventListener('click', async () => {
  $('status').innerHTML = '<span class="muted">Checking…</span>';
  show(await chrome.runtime.sendMessage({ type: 'set-server', server: $('server').value.trim() }));
});
