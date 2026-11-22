import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../App.jsx';
import ChipInput from '../components/ChipInput.jsx';
import { RowsSkeleton } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDateTime, SOURCE_LABELS } from '../format.js';
import { IconCheck } from '../icons.jsx';
import { track } from '../track.js';

// Connections, Activity and People are the owner's (and other admins'). Plan shows once Pro is on
// sale or the weekly free limits run (and always to admins).
const ALL_TABS = [
  { id: 'account', label: 'Account' },
  { id: 'plan', label: 'Plan', plans: true },
  { id: 'preferences', label: 'Preferences' },
  { id: 'connections', label: 'Connections', admin: true },
  { id: 'activity', label: 'Activity', admin: true },
  { id: 'people', label: 'People', admin: true },
  { id: 'review', label: 'Review' },
];
const TAB_KEY = 'aj-settings-tab';

const TASKS = [
  { name: 'fetch-jobs', label: 'Fetch jobs', hint: "Search Google Jobs now. Uses up to 3 of this month's searches." },
  { name: 'fetch-companies', label: 'Check company careers', hint: 'Read the careers feeds of the companies on the Companies page. Free: no searches used.' },
  { name: 'read-gmail', label: "Check everyone's Gmail", hint: 'Read new job alerts, job emails from any site and application emails for everyone who connected Gmail.' },
  { name: 'archive', label: 'Clean up postings', hint: 'Close postings past their deadline or taken down, and delete old ones.' },
  { name: 'retry-classify', label: 'Re-label with AI', hint: 'Send keyword-labelled jobs to the AI (FreeLLMAPI, Groq or Gemini). Uses AI tokens.' },
  { name: 'send-digest', label: 'Send digest', hint: "Email today's digest right away." },
];

const LOG_LABELS = { ...SOURCE_LABELS, groq: 'AI re-label', digest: 'Digest email', gmail: 'Gmail', cleanup: 'Clean-up' };
const EASE = [0.22, 1, 0.36, 1];

function summarize(result) {
  if (result.skipped) return `Skipped: ${result.skipped}`;
  if (result.task === 'archive') {
    return `Closed ${result.closedByDeadline + result.closedRemoved} postings, checked ${result.linksChecked} links, deleted ${result.deleted} old ones.`;
  }
  if (result.task === 'send-digest') return result.sent ? `Digest sent (${result.jobs} roles).` : 'Digest not sent.';
  if (result.task === 'retry-classify') {
    const stopped = result.stoppedBecause ? ` Stopped: ${result.stoppedBecause}.` : '';
    return `AI labeled ${result.upgraded} of ${result.pending} jobs.${stopped}`;
  }
  const parts = [];
  if (result.found != null) parts.push(`${result.found} found, ${result.new} new`);
  if (result.messages != null) parts.unshift(`${result.messages} emails`);
  if (result.errors?.length || result.error) parts.push('with errors (see Activity)');
  return parts.join(', ') || 'Done.';
}

const toForm = (s) => ({
  display_name: s.display_name,
  notification_email: s.notification_email,
  cities: s.cities,
  search_queries: s.search_queries,
  extra_exclude_keywords: s.extra_exclude_keywords,
  digest_enabled: s.digest_enabled,
  digest_time: s.digest_time,
});

/* ---------- Layout pieces ---------- */

function Section({ id, title, description, action, children }) {
  return (
    <section className="card set-section" aria-labelledby={id}>
      <header className="set-section-head">
        <div>
          <h2 id={id}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        {action}
      </header>
      <div className="set-section-body">{children}</div>
    </section>
  );
}

// One setting: label and explanation on the left, the control on the right (stacked on phones).
function Row({ label, hint, htmlFor, children }) {
  const hintId = htmlFor ? `${htmlFor}-hint` : undefined;
  return (
    <div className="set-row">
      <div className="set-row-text">
        {htmlFor ? (
          <label className="set-label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="set-label">{label}</span>
        )}
        {hint && (
          <p className="set-hint" id={hintId}>
            {hint}
          </p>
        )}
      </div>
      <div className="set-row-control">{children}</div>
    </div>
  );
}

function Switch({ id, checked, onChange, describedBy }) {
  return (
    <button type="button" role="switch" id={id} aria-checked={checked} aria-describedby={describedBy} className="switch" onClick={() => onChange(!checked)}>
      <motion.span className="switch-thumb" layout transition={{ type: 'spring', stiffness: 700, damping: 40 }} />
    </button>
  );
}

function StatusBadge({ ok, okLabel = 'Connected', offLabel = 'Not set' }) {
  return <span className={`status-badge ${ok ? 'is-ok' : 'is-off'}`}>{ok ? okLabel : offLabel}</span>;
}

/* ---------- Preferences ---------- */

function PreferencesPanel() {
  const { toast } = useToast();
  const { refreshMeta, me } = useMeta();
  const [baseline, setBaseline] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/settings')
      .then(({ settings }) => {
        setBaseline(toForm(settings));
        setForm(toForm(settings));
      })
      .catch((err) => setError(err.message));
  }, []);

  const dirty = useMemo(() => form && baseline && JSON.stringify(form) !== JSON.stringify(baseline), [form, baseline]);
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const setInput = (key) => (e) => set(key)(e.target.value);

  async function save(e) {
    e?.preventDefault();
    if (!dirty || busy) return;
    setBusy(true);
    setError('');
    try {
      const { settings } = await api('/settings', { method: 'PUT', body: form });
      // The server tidies values (e.g. "Bangalore" -> "Bengaluru"); show what was stored.
      setBaseline(toForm(settings));
      setForm(toForm(settings));
      toast({ message: 'Settings saved.' });
      refreshMeta(); // cities and the welcome name live in /jobs/meta too
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!form) {
    return error ? (
      <p className="form-error" role="alert" aria-live="assertive">
        {error}
      </p>
    ) : (
      <RowsSkeleton rows={6} label="Loading settings" />
    );
  }

  return (
    <form className="set-stack" onSubmit={save}>
      <Section id="set-profile" title="Profile" description="How the app greets you, and where the daily digest is sent.">
        <Row label="Your name" hint="Shown in the welcome message after you sign in." htmlFor="set-name">
          <input
            id="set-name"
            className="input"
            value={form.display_name}
            onChange={setInput('display_name')}
            maxLength={40}
            placeholder={me?.name?.split(' ')[0] || 'Your name'}
            aria-describedby="set-name-hint"
          />
        </Row>
        <Row label="Digest email" hint={me?.email ? `Where the daily list of new roles goes. Empty = ${me.email}.` : 'Where the daily list of new roles goes.'} htmlFor="set-email">
          <input
            id="set-email"
            className="input"
            type="email"
            value={form.notification_email}
            onChange={setInput('notification_email')}
            placeholder={me?.email || 'you@gmail.com'}
            aria-describedby="set-email-hint"
          />
        </Row>
      </Section>

      <Section id="set-search" title="Job search" description="Every search query runs in every city, a few per fetch, so the free search quota lasts the month.">
        <Row label="Cities" hint="Any city, or Remote. These also rank higher and fill the digest." htmlFor="set-cities">
          <ChipInput id="set-cities" value={form.cities} onChange={set('cities')} placeholder="Bengaluru, Mumbai, Remote…" addLabel="Add a city" max={10} maxLength={60} describedBy="set-cities-hint" />
        </Row>
        <Row label="Search queries" hint="Job titles to look for, without a city." htmlFor="set-queries">
          <ChipInput
            id="set-queries"
            value={form.search_queries}
            onChange={set('search_queries')}
            placeholder="BIM intern…"
            addLabel="Add a search"
            max={20}
            splitOnComma={false}
            describedBy="set-queries-hint"
          />
        </Row>
        {form.extra_exclude_keywords !== undefined && (
          <Row label="Exclude roles mentioning" hint="For everyone, on top of the built-in list (software, cloud, data, AWS, Java…)." htmlFor="set-exclude">
            <ChipInput
              id="set-exclude"
              value={form.extra_exclude_keywords}
              onChange={set('extra_exclude_keywords')}
              placeholder="sales, marketing…"
              addLabel="Add a word"
              maxLength={60}
              describedBy="set-exclude-hint"
            />
          </Row>
        )}
      </Section>

      <Section id="set-digest" title="Daily digest" description="One email a day with new roles and follow-ups that are due.">
        <Row label="Send the digest" hint={form.digest_enabled ? 'On.' : 'Off. No daily email.'} htmlFor="set-digest-on">
          <Switch id="set-digest-on" checked={form.digest_enabled} onChange={set('digest_enabled')} describedBy="set-digest-on-hint" />
        </Row>
        <Row label="Time (IST)" hint="Sent at the first check after this time." htmlFor="set-time">
          <input
            id="set-time"
            className="input set-time"
            type="time"
            value={form.digest_time}
            onChange={setInput('digest_time')}
            disabled={!form.digest_enabled}
            required
            aria-describedby="set-time-hint"
          />
        </Row>
      </Section>

      <AnimatePresence>
        {(dirty || error) && (
          <motion.div
            className="save-bar"
            role="region"
            aria-label="Unsaved changes"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.25, ease: EASE }}
          >
            {error ? (
              <p className="save-bar-error" role="alert" aria-live="assertive">
                {error}
              </p>
            ) : (
              <p>Unsaved changes</p>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setForm(baseline);
                setError('');
              }}
              disabled={busy}
            >
              Discard
            </button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !dirty}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </form>
  );
}

/* ---------- Connections ---------- */

// Which feature spent the free AI quota over the last 7 days (server lib/aiBudget.js logUsage).
const FEATURE_LABELS = { tailor: 'CV writing', analysis: 'Job analysis', profile: 'Reading CVs and portfolios', fill: 'Form filling (ARCH)' };
function FeatureUsage({ byFeature }) {
  const rows = Object.entries(byFeature || {}).sort((a, b) => b[1].tokens - a[1].tokens);
  if (!rows.length) return null;
  const total = rows.reduce((n, [, u]) => n + u.tokens, 0) || 1;
  return (
    <div className="feature-usage">
      <p className="small muted">AI use by feature, last 7 days</p>
      <ul>
        {rows.map(([k, u]) => (
          <li key={k}>
            <span>{FEATURE_LABELS[k] || k}</span>
            <span className="small muted">
              {u.tokens.toLocaleString('en-IN')} tokens · {u.requests} call{u.requests === 1 ? '' : 's'} · {Math.round((u.tokens / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Usage({ label, period, used, limit, note }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const tone = pct >= 90 ? 'is-high' : pct >= 70 ? 'is-mid' : '';
  return (
    <div className="usage">
      <div className="usage-top">
        <span className="usage-label">{label}</span>
        <span className="usage-period">{period}</span>
      </div>
      <div className="usage-value">
        <strong>{used.toLocaleString('en-IN')}</strong>
        <span> / {limit.toLocaleString('en-IN')}</span>
      </div>
      <div className={`meter ${tone}`} role="progressbar" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-label={`${label} used ${period}`}>
        <motion.span initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 0.8, ease: EASE }} />
      </div>
      {note && <p className="usage-note">{note}</p>}
    </div>
  );
}

function ConnectionsPanel({ system, onRan }) {
  const { toast } = useToast();
  const { refreshMeta } = useMeta();
  const [running, setRunning] = useState('');

  async function run(task) {
    setRunning(task.name);
    try {
      const result = await api(`/tasks/${task.name}`, { method: 'POST' });
      toast({ message: summarize(result), duration: 7000 });
      refreshMeta();
    } catch (err) {
      toast({ message: err.message, error: true, duration: 7000 });
    } finally {
      setRunning('');
      onRan();
    }
  }

  if (!system) return <RowsSkeleton rows={6} label="Loading connections" />;
  const { configured, serpapi, ai } = system;
  const scheduler = configured.scheduler ? 'Runs inside the app' : configured.cron ? 'Hostinger cron jobs' : 'Nothing runs on its own yet';
  const connections = [
    { name: 'Google Jobs', detail: 'Job search via SerpApi', ok: configured.serpapi },
    { name: 'FreeLLMAPI', detail: `Main AI · ${ai.freellm.model.split(',').join(' → ')}`, ok: configured.freellm },
    ...(ai.mail ? [{ name: 'Mail AI', detail: `Reads Gmail, own quota · ${ai.mail.model.split(',').join(' → ')}`, ok: ai.mail.configured }] : []),
    // Groq and Gemini normally run inside FreeLLMAPI; list them only when called directly too.
    ...(configured.groq || !configured.freellm ? [{ name: 'Groq', detail: `Direct backup AI · ${ai.groq.model}`, ok: configured.groq }] : []),
    ...(configured.gemini || !configured.freellm ? [{ name: 'Gemini', detail: `Direct backup AI · ${ai.gemini.model}`, ok: configured.gemini }] : []),
    { name: 'Google sign-in', detail: 'Accounts, job alerts and application emails from Gmail (OAuth)', ok: configured.google },
    { name: 'Digest email', detail: 'Sending (SMTP)', ok: configured.smtp },
    { name: 'Schedule', detail: scheduler, ok: configured.scheduler || configured.cron, okLabel: 'Active' },
  ];

  return (
    <div className="set-stack">
      <Section id="set-usage" title="Usage" description="Free-tier budgets. Searches and AI pause on their own before a limit is reached.">
        <div className="usage-grid">
          <Usage label="Searches" period="this month" used={serpapi.searchesUsedThisMonth} limit={serpapi.monthlyLimit} note={`Pauses with ${serpapi.reserve} left`} />
          {ai.freellm.configured && (
            <Usage label="FreeLLMAPI tokens" period="today" used={ai.freellm.today.tokens} limit={ai.freellm.dailyTokens} note={`${ai.freellm.today.requests} of ${ai.freellm.dailyRequests} requests`} />
          )}
          {ai.mail?.configured && (
            <Usage label="Mail AI tokens" period="today" used={ai.mail.today.tokens} limit={ai.mail.dailyTokens} note={`${ai.mail.today.requests} of ${ai.mail.dailyRequests} requests`} />
          )}
          {ai.groq.configured && <Usage label="Groq tokens" period="today" used={ai.groq.today.tokens} limit={ai.groq.dailyTokens} note={`${ai.groq.today.requests} of ${ai.groq.dailyRequests} requests`} />}
          {ai.gemini.configured && (
            <Usage label="Gemini tokens" period="today" used={ai.gemini.today.tokens} limit={ai.gemini.dailyTokens} note={`${ai.gemini.today.requests} of ${ai.gemini.dailyRequests} requests`} />
          )}
        </div>
        <FeatureUsage byFeature={system.aiByFeature} />
      </Section>

      <Section id="set-connections" title="Connections" description="Keys and passwords live in the server's environment variables (hPanel on Hostinger).">
        <ul className="conn-list">
          {connections.map((c) => (
            <li key={c.name}>
              <span className={`conn-dot ${c.ok ? 'is-ok' : ''}`} aria-hidden="true" />
              <div className="grow">
                <div className="conn-name">{c.name}</div>
                <div className="conn-detail">{c.detail}</div>
              </div>
              <StatusBadge ok={c.ok} okLabel={c.okLabel} />
            </li>
          ))}
        </ul>
      </Section>

      <Section id="set-run" title="Run now" description="All of these also run on their own schedule.">
        <ul className="conn-list">
          {TASKS.map((task) => (
            <li key={task.name}>
              <div className="grow">
                <div className="conn-name">{task.label}</div>
                <div className="conn-detail">{task.hint}</div>
              </div>
              <button type="button" className="btn btn-sm" disabled={Boolean(running)} onClick={() => run(task)}>
                {running === task.name ? 'Running…' : 'Run'}
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

/* ---------- Activity ---------- */

function ActivityPanel({ system, onRefresh }) {
  if (!system) return <RowsSkeleton rows={6} label="Loading activity" />;
  const log = system.fetchLog;
  return (
    <Section
      id="set-activity"
      title="Recent runs"
      description="The last 40 fetches, inbox checks, AI re-labels and digests."
      action={
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh}>
          Refresh
        </button>
      }
    >
      {log.length === 0 ? (
        <p className="set-empty">Nothing has run yet. Runs appear here after the first scheduled fetch or a “Run now”.</p>
      ) : (
        <div className="table-wrap">
          <table className="table run-table" aria-label="Recent source runs">
            <thead>
              <tr>
                <th>When (IST)</th>
                <th>What</th>
                <th className="num">Found</th>
                <th className="num">New</th>
                <th className="num">Requests</th>
              </tr>
            </thead>
            <tbody>
              {log.map((row) => (
                <tr key={row.id} className={row.error ? 'has-error' : undefined}>
                  <td className="small nowrap">{formatDateTime(row.run_at)}</td>
                  <td>
                    <span className={`conn-dot ${row.error ? 'is-error' : 'is-ok'}`} aria-hidden="true" /> {LOG_LABELS[row.source] || row.source}
                    {row.error && <div className="log-error">{row.error}</div>}
                  </td>
                  <td className="num">{row.jobs_found}</td>
                  <td className="num">{row.jobs_new}</td>
                  <td className="num">{row.requests_used}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/* ---------- Filter review ---------- */

function ReviewPanel() {
  const { toast } = useToast();
  const { refreshMeta } = useMeta();
  const [data, setData] = useState(null);

  const load = useCallback(() => {
    api('/jobs/review')
      .then(setData)
      .catch(() => setData({ hidden: [], filtered: [] }));
  }, []);
  useEffect(load, [load]);

  async function act(path, message) {
    try {
      await api(path, { method: 'POST' });
      toast({ message });
      refreshMeta();
      load();
    } catch (err) {
      toast({ message: err.message, error: true });
    }
  }

  if (!data) return <RowsSkeleton rows={5} label="Loading filtered jobs" />;
  const list = (jobs, extraKey, button, path, message) =>
    jobs.length === 0 ? (
      <p className="set-empty">None.</p>
    ) : (
      <ul className="conn-list">
        {jobs.map((job) => (
          <li key={job.id}>
            <div className="grow">
              <div className="conn-name truncate">
                <a href={job.apply_url} target="_blank" rel="noopener noreferrer">
                  {job.title}
                </a>
              </div>
              <div className="conn-detail truncate">{[job.company, job.city, job[extraKey]].filter(Boolean).join(' · ')}</div>
            </div>
            <button type="button" className="btn btn-sm" onClick={() => act(path(job), message)}>
              {button}
            </button>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="set-stack">
      <Section id="set-filtered" title="Filtered out automatically" description="Roles the classifier judged not relevant in the last 30 days. Spot a mistake? Put it back in the feed.">
        {list(data.filtered, 'classify_reason', 'Show in feed', (j) => `/jobs/${j.id}/restore`, 'Moved to your feed.')}
      </Section>
      <Section id="set-hidden" title="Hidden by you" description="Roles you marked as not relevant, with your reason. Recurring patterns are worth adding to Exclude roles.">
        {list(data.hidden, 'hide_reason', 'Unhide', (j) => `/jobs/${j.id}/unhide`, 'Job restored.')}
      </Section>
    </div>
  );
}

/* ---------- Account ---------- */

const GMAIL_ERRORS = {
  cancelled: 'Gmail was not connected: the Google screen was closed or cancelled.',
  no_gmail: 'Gmail was not connected: tick the box that lets ArchJobs read your email, then try again.',
  other_account: 'Pick the same Google account you signed in with.',
  expired: 'That took too long. Please try again.',
  failed: "Gmail couldn't be connected. Please try again.",
};

function Avatar({ person, size = 44 }) {
  const [broken, setBroken] = useState(false);
  const label = person.name || person.email || '?';
  return (
    <span className="person-avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      {person.picture && !broken ? <img src={person.picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} /> : label.trim()[0]?.toUpperCase()}
    </span>
  );
}

function AccountPanel({ onLogout }) {
  const { toast } = useToast();
  const { me, refreshMe, refreshMeta } = useMeta();
  const [account, setAccount] = useState(null);
  const [google, setGoogle] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(() => {
    api('/account')
      .then((d) => setAccount(d.account))
      .catch(() => {});
    api('/me')
      .then((d) => setGoogle(d.google))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  async function act(kind) {
    setBusy(kind);
    try {
      const d = await api(`/account/gmail/${kind}`, { method: 'POST' });
      setAccount(d.account);
      refreshMe();
      if (kind === 'sync') {
        const r = d.result || {};
        toast({
          message: r.skipped
            ? `Skipped: ${r.skipped}`
            : r.errors?.length
              ? r.errors[0]
              : `${r.messages || 0} alert emails read, ${r.new || 0} new roles. ${r.emails || 0} application emails read, ${r.tracked || 0} tracker updates.`,
          error: Boolean(r.errors?.length),
          duration: 7000,
        });
        refreshMeta();
      } else {
        toast({ message: 'Gmail disconnected. ArchJobs can no longer read it.' });
      }
    } catch (err) {
      toast({ message: err.message, error: true });
    } finally {
      setBusy('');
    }
  }

  const person = account || me;
  if (!person) return <RowsSkeleton rows={3} label="Loading your account" />;
  const gmail = account?.gmail;

  return (
    <div className="set-stack">
      <Section
        id="set-account"
        title="Your account"
        description="Your tracker, firms, hidden jobs, searches and settings are yours alone. The job list is shared by everyone."
        action={
          <button type="button" className="btn btn-ghost btn-sm" onClick={onLogout}>
            Sign out
          </button>
        }
      >
        <div className="person-card">
          <Avatar person={person} size={52} />
          <div className="grow">
            <div className="person-name">{person.name || 'Owner'}</div>
            <div className="person-detail">
              {[person.email, person.isOwner ? 'Owner' : person.isAdmin ? 'Admin' : null].filter(Boolean).join(' · ') || 'Signed in with the owner password'}
            </div>
          </div>
        </div>
      </Section>

      <Section
        id="set-gmail"
        title="Gmail"
        description="Bring your LinkedIn job alerts into Jobs, and keep your Tracker up to date from the emails about your applications. Checked every 30 minutes."
        action={gmail && <StatusBadge ok={gmail.connected} okLabel="Connected" offLabel="Not connected" />}
      >
        {!google ? (
          <p className="set-empty">Google sign-in isn't set up on the server yet, so Gmail can't be connected.</p>
        ) : gmail?.connected ? (
          <>
            <p className="set-note">
              Connected{gmail.syncedAt ? ` · last checked ${formatDateTime(gmail.syncedAt)}` : ' · first check running'}. Read-only: ArchJobs opens
              LinkedIn job alerts and emails about your applications (sent, interview, test, offer, rejection), and never sends, deletes or changes
              anything. Application emails are read by AI to update your Tracker.
            </p>
            {gmail.error && (
              <p className="form-error" role="alert" aria-live="assertive">
                {gmail.error}
              </p>
            )}
            <div className="set-actions">
              <button type="button" className="btn btn-sm" disabled={Boolean(busy)} onClick={() => act('sync')}>
                {busy === 'sync' ? 'Checking…' : 'Check now'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(busy)} onClick={() => act('disconnect')}>
                {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
          </>
        ) : (
          <>
            {gmail?.error && (
              <p className="form-error" role="alert" aria-live="assertive">
                {gmail.error}
              </p>
            )}
            <ol className="set-steps">
              <li>On LinkedIn, create job alerts (for example “Architect” or “BIM intern” in your city) and set them to arrive by email.</li>
              <li>Connect Gmail below with {person.email ? <strong>{person.email}</strong> : 'the Google account you use'}. New alerts show up in Jobs within 30 minutes.</li>
              <li>Emails about your applications from the last 60 days fill your Tracker: roles you applied to, interviews, tests, offers and rejections.</li>
            </ol>
            <p className="set-note">
              Read-only: ArchJobs opens LinkedIn job alerts and emails about your applications, and never sends, deletes or changes anything. Application
              emails are read by AI (subject, sender and the start of the message) to update your Tracker. Google may say it “hasn't verified this
              app”: choose <em>Advanced</em>, then <em>Go to ArchJobs</em>. You can disconnect any time.
            </p>
            <div className="set-actions">
              <a className="btn btn-primary btn-sm" href="/api/auth/google/start?mode=gmail">
                Connect Gmail
              </a>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

/* ---------- Plan (Pro and the weekly free limits) ---------- */

const PLAN_FEATURES = [
  { id: 'tailor', label: 'Tailored CV + cover letter', hint: 'A CV and cover letter written for one job.' },
  { id: 'analysis', label: 'Job fit checks', hint: 'What a job really asks for, where you fall short and what to fix.' },
  { id: 'fill', label: 'ARCH form answers', hint: 'Written answers to open questions on application forms. Fields filled from your details are always free.' },
  { id: 'profile', label: 'Profile reads', hint: 'Reading your CV or portfolio after an upload.' },
];
const rupees = (paise) => `₹${(paise / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// Razorpay's Checkout script, loaded the first time someone presses Upgrade.
let checkoutScript = null;
function loadCheckout() {
  if (window.Razorpay) return Promise.resolve();
  checkoutScript ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.async = true;
    s.onload = resolve;
    s.onerror = () => {
      checkoutScript = null;
      s.remove();
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return checkoutScript;
}

function PlanPanel() {
  const { toast } = useToast();
  const { me } = useMeta();
  const [billing, setBilling] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [code, setCode] = useState('');
  const [coupon, setCoupon] = useState(null); // { code, prices: { planId: { amount, discount } } }
  const [couponError, setCouponError] = useState('');
  const [checking, setChecking] = useState(false);
  const [couponOpen, setCouponOpen] = useState(false);
  const [starting, setStarting] = useState(false);

  async function startTrial() {
    track('plan:trial');
    setStarting(true);
    try {
      await api('/billing/trial', { method: 'POST' });
      toast({ message: `Your ${billing.trial.days}-day Pro trial has started. No weekly limits until it ends.`, duration: 7000 });
      load();
    } catch (err) {
      toast({ message: err.message, error: true });
    } finally {
      setStarting(false);
    }
  }

  // Checks the code against every plan (a code can be for one plan only).
  async function applyCode(e) {
    e.preventDefault();
    const typed = code.trim();
    if (!typed || checking) return;
    track('coupon:apply');
    setChecking(true);
    setCouponError('');
    const results = await Promise.all(
      billing.plans.map((p) =>
        api('/billing/coupon', { method: 'POST', body: { plan: p.id, code: typed } })
          .then((d) => ({ id: p.id, d }))
          .catch((err) => ({ id: p.id, err })),
      ),
    );
    setChecking(false);
    const ok = results.filter((r) => r.d);
    if (!ok.length) {
      setCoupon(null);
      setCouponError(results[0]?.err?.message || 'That coupon code is not valid.');
      return;
    }
    setCoupon({ code: ok[0].d.code, prices: Object.fromEntries(ok.map((r) => [r.id, { amount: r.d.amount, discount: r.d.discount }])) });
  }

  function clearCode() {
    setCoupon(null);
    setCode('');
    setCouponError('');
    setCouponOpen(false);
  }

  const load = useCallback(() => {
    api('/billing')
      .then((d) => {
        setBilling(d);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  async function buy(planId) {
    track('plan:pay');
    setBusy(planId);
    try {
      const withCode = coupon?.prices[planId] ? coupon.code : undefined;
      const order = await api('/billing/order', { method: 'POST', body: { plan: planId, coupon: withCode } });
      // A coupon that makes Pro free needs no payment.
      if (order.free) {
        toast({ message: 'Coupon applied. You are on ArchJobs Pro: no weekly limits.', duration: 7000 });
        setBusy('');
        clearCode();
        load();
        return;
      }
      await loadCheckout();
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
      const checkout = new window.Razorpay({
        key: order.keyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: order.name,
        description: order.description,
        prefill: order.prefill,
        ...(accent.startsWith('#') ? { theme: { color: accent } } : {}),
        handler: async (paid) => {
          try {
            await api('/billing/verify', { method: 'POST', body: paid });
            toast({ message: 'Payment done. You are on ArchJobs Pro: no weekly limits.', duration: 7000 });
            clearCode();
          } catch (err) {
            toast({ message: `${err.message} If money left your account, Pro turns on within a few minutes.`, error: true, duration: 9000 });
          } finally {
            setBusy('');
            load();
          }
        },
        modal: { ondismiss: () => setBusy('') },
      });
      checkout.on('payment.failed', (r) => toast({ message: r?.error?.description || 'The payment did not go through. Nothing was charged.', error: true, duration: 7000 }));
      checkout.open();
    } catch (err) {
      toast({ message: err.message, error: true });
      setBusy('');
    }
  }

  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!billing) return <RowsSkeleton rows={3} label="Loading your plan" />;
  const { quota } = billing;
  const pro = billing.active;
  const unlimited = pro || quota.admin;
  const day = (iso, opts) => new Date(iso).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', ...opts });
  const resets = day(quota.resetsAt, { weekday: 'long', day: 'numeric', month: 'short' });
  const onSale = billing.enabled && billing.plans.length > 0;
  // Longest plan first: the yearly one is the better deal and leads.
  const plans = [...billing.plans].sort((a, b) => b.days - a.days);
  const monthly = billing.plans.find((p) => p.days <= 31);

  return (
    <div className="set-stack">
      <Section
        id="set-plan"
        title={pro ? (billing.plan === 'trial' ? 'Pro trial' : 'ArchJobs Pro') : quota.admin ? 'Admin' : 'Free plan'}
        description={
          pro
            ? `${billing.plan === 'trial' ? 'Your trial runs' : 'Pro'} until ${day(billing.expiresAt, { day: 'numeric', month: 'long', year: 'numeric' })}. No weekly limits.${billing.plan === 'trial' ? ' It ends by itself: nothing is charged.' : ''}`
            : quota.admin
              ? 'Admins have no weekly limits.'
              : `A few free uses of each tool every week. They come back on ${resets}.`
        }
        action={<StatusBadge ok={unlimited} okLabel={pro ? 'Pro' : 'Admin'} offLabel="Free" />}
      >
        <ul className="quota-grid" aria-label="This week's AI use">
          {PLAN_FEATURES.map((f) => {
            const q = quota.features[f.id];
            const left = q.limit == null ? null : Math.max(q.limit - q.used, 0);
            return (
              <li key={f.id} className="quota-tile">
                <span className="usage-name">{f.label}</span>
                {left == null ? (
                  <span className="usage-count">
                    <strong>Unlimited</strong> · {q.used} this week
                  </span>
                ) : (
                  <>
                    <span className="usage-count">
                      <strong>{left}</strong> of {q.limit} left
                    </span>
                    {/* A scale bar, as on a drawing: one segment per free use, filled while unused. */}
                    <span className="scale-bar" aria-hidden="true">
                      {Array.from({ length: q.limit }, (_, i) => (
                        <span key={i} className={i < left ? 'is-left' : ''} />
                      ))}
                    </span>
                  </>
                )}
                <span className="usage-hint">{f.hint}</span>
              </li>
            );
          })}
        </ul>
        {!unlimited && <p className="plan-note">Always free: job search, the morning digest, job emails, the tracker and Gmail reading.</p>}
      </Section>

      {!pro && (
        <Section id="set-pro" title="Go Pro" description="For the weeks you are applying everywhere. One payment, no auto-renewal.">
          {onSale ? (
            <div className="pro-body">
              <ul className="pro-perks">
                {[
                  'A CV and cover letter for every firm you apply to',
                  'Fit checks on as many jobs as you like',
                  'ARCH answers every open question on a form',
                  'Written only from your own CV and portfolio, nothing made up',
                ].map((t) => (
                  <li key={t}>
                    <IconCheck size={16} />
                    {t}
                  </li>
                ))}
              </ul>

              {billing.trial?.available && (
                <div className="trial-row">
                  <p>
                    <strong>Not sure yet?</strong> Try Pro free for {billing.trial.days} days. No card, no payment: it simply ends.
                  </p>
                  <button type="button" className="btn btn-primary" disabled={starting || Boolean(busy)} onClick={startTrial}>
                    {starting ? 'Starting…' : `Start ${billing.trial.days}-day trial`}
                  </button>
                </div>
              )}

              <div className="plan-grid">
                {plans.map((p) => {
                  const deal = coupon?.prices[p.id];
                  const price = deal ? deal.amount : p.amount;
                  const yearly = p.days >= 360;
                  const save = yearly && monthly ? Math.round((1 - p.amount / (monthly.amount * 12)) * 100) : 0;
                  const best = yearly && plans.length > 1;
                  return (
                    <div key={p.id} className={`plan-card${best ? ' is-best' : ''}`}>
                      <div className="plan-card-head">
                        <span className="plan-label">{yearly ? 'Yearly' : 'Monthly'}</span>
                        {save > 0 && <span className="plan-save">Save {save}%</span>}
                      </div>
                      <p className="plan-price">
                        <span>{price === 0 ? 'Free' : rupees(price)}</span>
                        {deal && <s className="plan-was">{rupees(p.amount)}</s>}
                      </p>
                      <p className="plan-per">
                        {deal
                          ? `${coupon.code} applied: ${rupees(deal.discount)} off`
                          : yearly
                            ? `₹${Math.round(p.amount / 1200)} a month for ${p.days} days`
                            : `for ${p.days} days`}
                      </p>
                      <button
                        type="button"
                        className={`btn ${(best || plans.length === 1 || deal) && !billing.trial?.available ? 'btn-primary' : ''} plan-buy`}
                        disabled={Boolean(busy)}
                        onClick={() => buy(p.id)}
                      >
                        {busy === p.id ? 'Opening payment…' : price === 0 ? 'Get Pro free' : `Pay ${rupees(price)}`}
                      </button>
                    </div>
                  );
                })}
              </div>

              <p className="plan-guarantee">
                <IconCheck size={16} /> Not useful? Ask within 7 days for a full refund. <a href="/refunds">How refunds work</a>
              </p>

              {coupon ? (
                <p className="coupon-applied">
                  Coupon <strong>{coupon.code}</strong> applied.
                  <button type="button" className="link-btn" onClick={clearCode}>
                    Remove
                  </button>
                </p>
              ) : couponOpen ? (
                <form className="coupon-row" onSubmit={applyCode}>
                  <label className="set-label" htmlFor="coupon-code">
                    Coupon code
                  </label>
                  <div className="coupon-controls">
                    <input
                      id="coupon-code"
                      className="input"
                      value={code}
                      onChange={(e) => setCode(e.target.value.toUpperCase())}
                      maxLength={24}
                      autoComplete="off"
                      spellCheck={false}
                      autoFocus
                      aria-describedby={couponError ? 'coupon-error' : undefined}
                      aria-invalid={Boolean(couponError)}
                    />
                    <button type="submit" className="btn" disabled={!code.trim() || checking}>
                      {checking ? 'Checking…' : 'Apply'}
                    </button>
                  </div>
                  {couponError && (
                    <p className="form-error" id="coupon-error" role="alert">
                      {couponError}
                    </p>
                  )}
                </form>
              ) : (
                <button type="button" className="link-btn coupon-open" onClick={() => setCouponOpen(true)}>
                  Have a coupon code?
                </button>
              )}

              <p className="plan-note">
                {billing.mode === 'test' ? 'Test mode: no real money is taken. ' : ''}Paid through Razorpay with UPI, cards or net banking. Pro does not renew by
                itself.
              </p>
            </div>
          ) : (
            <p className="plan-note pro-body">Pro is not on sale yet.</p>
          )}
        </Section>
      )}

      {me?.isAdmin && <CouponsSection plans={billing.plans} />}
    </div>
  );
}

const EMPTY_COUPON = { code: '', kind: 'percent', value: '', plan: '', maxUses: '', expiresOn: '' };

// Admins make and switch off coupon codes.
function CouponsSection({ plans }) {
  const { toast } = useToast();
  const [coupons, setCoupons] = useState(null);
  const [form, setForm] = useState(EMPTY_COUPON);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const loadCoupons = useCallback(
    () =>
      api('/billing/coupons')
        .then((d) => setCoupons(d.coupons))
        .catch((err) => setError(err.message)),
    [],
  );
  useEffect(() => {
    loadCoupons();
  }, [loadCoupons]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: key === 'code' ? e.target.value.toUpperCase() : e.target.value }));

  async function create(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const { coupon } = await api('/billing/coupons', {
        method: 'POST',
        body: {
          code: form.code,
          [form.kind === 'percent' ? 'percentOff' : 'rupeesOff']: form.value,
          plan: form.plan || null,
          maxUses: form.maxUses,
          expiresOn: form.expiresOn,
        },
      });
      setCoupons((list) => [coupon, ...(list || [])]);
      setForm(EMPTY_COUPON);
      toast({ message: `Coupon ${coupon.code} made.` });
    } catch (err) {
      setError(err.message);
      // The code exists already: show the list as it is now (another tab may have changed it).
      if (err.status === 409) loadCoupons();
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c) {
    try {
      const { coupon } = await api(`/billing/coupons/${encodeURIComponent(c.code)}`, { method: 'PATCH', body: { active: !c.active } });
      setCoupons((list) => list.map((x) => (x.code === coupon.code ? coupon : x)));
    } catch (err) {
      toast({ message: err.message, error: true });
    }
  }

  const planName = (id) => plans.find((p) => p.id === id)?.label || id;
  const off = (c) => (c.percentOff != null ? `${c.percentOff}% off` : `${rupees(c.amountOff)} off`);

  return (
    <Section id="set-coupons" title="Coupon codes" description="Codes people type in the coupon box above. Each person can use a code once. 100% off turns Pro on with no payment.">
      <form className="coupon-form" onSubmit={create}>
        <label>
          <span className="set-label">Code</span>
          <input className="input" value={form.code} onChange={set('code')} maxLength={24} placeholder="DIWALI50" required autoComplete="off" spellCheck={false} />
        </label>
        <label>
          <span className="set-label">Discount</span>
          <span className="coupon-controls">
            <input className="input" type="number" min="1" max={form.kind === 'percent' ? 100 : 100000} value={form.value} onChange={set('value')} required aria-label="Discount amount" />
            <select className="input" value={form.kind} onChange={set('kind')} aria-label="Discount type">
              <option value="percent">% off</option>
              <option value="rupees">₹ off</option>
            </select>
          </span>
        </label>
        <label>
          <span className="set-label">Plan</span>
          <select className="input" value={form.plan} onChange={set('plan')}>
            <option value="">Every plan</option>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="set-label">Uses (blank: no limit)</span>
          <input className="input" type="number" min="1" value={form.maxUses} onChange={set('maxUses')} />
        </label>
        <label>
          <span className="set-label">Last day (blank: never ends)</span>
          <input className="input" type="date" value={form.expiresOn} onChange={set('expiresOn')} />
        </label>
        <div className="coupon-submit">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {busy ? 'Making…' : 'Make coupon'}
          </button>
        </div>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {coupons?.length > 0 && (
        <ul className="coupon-list">
          {coupons.map((c) => (
            <li key={c.code} className={c.active ? '' : 'is-off'}>
              <div>
                <strong>{c.code}</strong> · {off(c)}
                {c.plan ? ` · ${planName(c.plan)}` : ''}
                <span className="set-hint">
                  {' '}
                  Used {c.uses}
                  {c.maxUses != null ? ` of ${c.maxUses}` : ''}
                  {c.expiresAt ? ` · until ${new Date(c.expiresAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}` : ''}
                  {c.active ? '' : ' · off'}
                </span>
                {c.usedBy?.length > 0 && (
                  <span className="coupon-used-by">
                    Used by{' '}
                    {c.usedBy
                      .map((u) => `${u.name || u.email || `account ${u.id}`}${u.name && u.email ? ` (${u.email})` : ''}, ${new Date(u.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}`)
                      .join(' · ')}
                  </span>
                )}
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggle(c)}>
                {c.active ? 'Turn off' : 'Turn on'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* ---------- People (admins) ---------- */

function PeoplePanel() {
  const { toast } = useToast();
  const { me } = useMeta();
  const [data, setData] = useState(null);
  const [allowed, setAllowed] = useState([]);
  const [busy, setBusy] = useState(false);

  const show = useCallback((d) => {
    setData(d);
    setAllowed(d.allowed);
  }, []);
  useEffect(() => {
    api('/people')
      .then(show)
      .catch((err) => toast({ message: err.message, error: true }));
  }, [show, toast]);

  async function saveAllowed() {
    setBusy(true);
    try {
      show(await api('/people/allowed', { method: 'PUT', body: { emails: allowed } }));
      toast({ message: 'Saved. They can now sign in with Google.' });
    } catch (err) {
      toast({ message: err.message, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function remove(person) {
    try {
      show(await api(`/people/${person.id}`, { method: 'DELETE' }));
      toast({ message: `${person.name || person.email} was removed.` });
    } catch (err) {
      toast({ message: err.message, error: true });
    }
  }

  if (!data) return <RowsSkeleton rows={4} label="Loading people" />;
  const dirty = JSON.stringify(allowed) !== JSON.stringify(data.allowed);

  return (
    <div className="set-stack">
      <Section id="set-people" title="People" description="Everyone with an account. Removing someone deletes their tracker, firms and searches; jobs stay.">
        <ul className="conn-list">
          {data.users.map((u) => (
            <li key={u.id}>
              <Avatar person={u} size={36} />
              <div className="grow">
                <div className="conn-name truncate">
                  {u.name || u.email || 'Owner'}
                  {u.isOwner ? ' · Owner' : u.isAdmin ? ' · Admin' : ''}
                  {u.proUntil && (
                    <span className="people-pro">
                      {u.plan === 'trial' ? 'Pro trial' : 'Pro'} until {new Date(u.proUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}
                    </span>
                  )}
                </div>
                <div className="conn-detail truncate">
                  {[u.email, u.gmail ? 'Gmail connected' : null, `${u.tracked} tracked`, u.lastLoginAt ? `last in ${formatDateTime(u.lastLoginAt)}` : null]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              {!u.isOwner && u.id !== me?.id && (
                <ConfirmRemove person={u} onConfirm={() => remove(u)} />
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section
        id="set-allowed"
        title="Who can join"
        description={
          data.openToAnyone
            ? 'Anyone with a Google account can sign in (ALLOWED_EMAILS is * on the server).'
            : 'Google accounts that may sign in. They get their own account the first time they do.'
        }
      >
        <Row label="Emails" hint={data.fromServer.length ? `Also allowed by the server settings: ${data.fromServer.join(', ')}.` : 'Their Gmail addresses.'} htmlFor="set-allowed-emails">
          <ChipInput id="set-allowed-emails" value={allowed} onChange={setAllowed} placeholder="friend@gmail.com" addLabel="Add an email" max={200} maxLength={254} describedBy="set-allowed-emails-hint" />
        </Row>
        <div className="set-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={saveAllowed}>
            {busy ? 'Saving…' : 'Save list'}
          </button>
        </div>
      </Section>
    </div>
  );
}

// Two taps to remove someone: no browser dialog.
function ConfirmRemove({ person, onConfirm }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return undefined;
    const t = setTimeout(() => setAsking(false), 4000);
    return () => clearTimeout(t);
  }, [asking]);
  return asking ? (
    <button type="button" className="btn btn-sm btn-danger" onClick={onConfirm}>
      Remove {person.name?.split(' ')[0] || 'them'}?
    </button>
  ) : (
    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAsking(true)}>
      Remove
    </button>
  );
}

/* ---------- Page ---------- */

// #/settings?tab=account opens a tab directly (the account button in the header does).
function loadTab(tabs) {
  const asked = new URLSearchParams(window.location.hash.split('?')[1] || '').get('tab');
  if (tabs.some((x) => x.id === asked)) return asked;
  try {
    const t = localStorage.getItem(TAB_KEY);
    return tabs.some((x) => x.id === t) ? t : 'account';
  } catch {
    return 'account';
  }
}

export default function SettingsPage() {
  const { toast } = useToast();
  const { me } = useMeta();
  const isAdmin = Boolean(me?.isAdmin);
  const showPlans = Boolean(me?.plans) || isAdmin;
  const TABS = useMemo(() => ALL_TABS.filter((t) => (!t.admin || isAdmin) && (!t.plans || showPlans)), [isAdmin, showPlans]);
  const [tab, setTab] = useState(() => loadTab(TABS));
  const [system, setSystem] = useState(null);
  const tabRefs = useRef({});

  useEffect(() => {
    if (!TABS.some((t) => t.id === tab)) setTab('account');
  }, [TABS, tab]);

  // The header's account button while already on this page.
  useEffect(() => {
    const onHash = () => {
      const asked = new URLSearchParams(window.location.hash.split('?')[1] || '').get('tab');
      if (asked && TABS.some((t) => t.id === asked)) setTab(asked);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [TABS]);

  // Back from Google's Gmail consent screen (?gmail=connected or ?gmail_error=...).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ok = params.get('gmail');
    const failed = params.get('gmail_error');
    if (!ok && !failed) return;
    window.history.replaceState(null, '', `/${window.location.hash}`);
    setTab('account');
    if (ok) toast({ message: 'Gmail connected. Your job alerts and application emails are being read now.', duration: 7000 });
    else toast({ message: GMAIL_ERRORS[failed] || GMAIL_ERRORS.failed, error: true, duration: 9000 });
  }, [toast]);

  const loadSystem = useCallback(() => {
    if (!isAdmin) return;
    api('/system')
      .then(setSystem)
      .catch((err) => toast({ message: err.message, error: true }));
  }, [toast, isAdmin]);
  useEffect(loadSystem, [loadSystem]);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // not remembered in private mode
    }
  }, [tab]);

  // Arrow keys move between tabs (the standard tablist pattern).
  function onTabKey(e) {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : null;
    if (next == null) return;
    e.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length];
    setTab(t.id);
    tabRefs.current[t.id]?.focus();
  }

  async function logout() {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.reload();
  }

  const panels = {
    account: <AccountPanel onLogout={logout} />,
    plan: showPlans ? <PlanPanel /> : null,
    people: isAdmin ? <PeoplePanel /> : null,
    preferences: <PreferencesPanel />,
    connections: <ConnectionsPanel system={system} onRan={loadSystem} />,
    activity: <ActivityPanel system={system} onRefresh={loadSystem} />,
    review: <ReviewPanel />,
  };

  return (
    <div className="page-narrow settings">
      <header className="settings-head">
        <div>
          <h1>Settings</h1>
          <p>Your account, search and alerts.</p>
        </div>
        {isAdmin && (
          <a className="btn btn-sm" href="#/admin">
            Admin console
          </a>
        )}
      </header>

      <div className="tabs" role="tablist" aria-label="Settings sections" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => (tabRefs.current[t.id] = el)}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className="tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {tab === t.id && <motion.span layoutId="settings-tab" className="tab-indicator" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
          </button>
        ))}
      </div>

      {/* All panels stay mounted so unsaved edits survive a tab switch; only the active one shows. */}
      {TABS.map((t) => (
        <motion.div
          key={t.id}
          role="tabpanel"
          id={`panel-${t.id}`}
          aria-labelledby={`tab-${t.id}`}
          hidden={tab !== t.id}
          initial={false}
          animate={tab === t.id ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
          transition={{ duration: 0.25, ease: EASE }}
        >
          {panels[t.id]}
        </motion.div>
      ))}
    </div>
  );
}
