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
      `<div class="line"><span>Profile read from your CV</span>${s.ready ? yes : no}</div>` +
      `<div class="line"><span>CV uploaded</span>${s.resume ? yes : no}</div>` +
      `<div class="line"><span>Portfolio uploaded</span>${s.portfolio ? yes : no}</div>` +
      `<div class="line"><span>AI answers today</span><span>${s.fills?.today ?? 0} / ${s.fills?.limit ?? '–'}${s.ai ? '' : ' (off)'}</span></div>` +
      (s.status === 'building' ? '<p class="muted" style="margin-top:6px">Your profile is being read right now.</p>' : '') +
      (!s.ready && s.status !== 'building' ? '<p class="muted" style="margin-top:6px">Upload your CV on your ArchJobs Profile page so there is something to fill from.</p>' : '');
  }
  $('status').innerHTML = html;
  $('fill').disabled = !(s.signedIn && s.ready);
}

chrome.runtime.sendMessage({ type: 'status' }).then(show, (err) => show({ error: err.message }));

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
$('save').addEventListener('click', async () => {
  $('status').innerHTML = '<span class="muted">Checking…</span>';
  show(await chrome.runtime.sendMessage({ type: 'set-server', server: $('server').value.trim() }));
});
