import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../App.jsx';
import ChipInput from '../components/ChipInput.jsx';
import { RowsSkeleton } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDateTime, SOURCE_LABELS } from '../format.js';

const TABS = [
  { id: 'preferences', label: 'Preferences' },
  { id: 'connections', label: 'Connections' },
  { id: 'activity', label: 'Activity' },
  { id: 'review', label: 'Review' },
];
const TAB_KEY = 'aj-settings-tab';

const TASKS = [
  { name: 'fetch-jobs', label: 'Fetch jobs', hint: "Search Google Jobs now. Uses up to 3 of this month's searches." },
  { name: 'read-inbox', label: 'Check LinkedIn inbox', hint: 'Read new job-alert emails in the jobs mailbox.' },
  { name: 'retry-classify', label: 'Re-label with AI', hint: 'Send keyword-labelled jobs to Groq or Gemini. Uses AI tokens.' },
  { name: 'send-digest', label: 'Send digest', hint: "Email today's digest right away." },
];

const LOG_LABELS = { ...SOURCE_LABELS, groq: 'AI re-label', digest: 'Digest email' };
const EASE = [0.22, 1, 0.36, 1];

function summarize(result) {
  if (result.skipped) return `Skipped: ${result.skipped}`;
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
  const { refreshMeta } = useMeta();
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
      <p className="form-error" role="alert">
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
          <input id="set-name" className="input" value={form.display_name} onChange={setInput('display_name')} maxLength={40} placeholder="Kothu" aria-describedby="set-name-hint" />
        </Row>
        <Row label="Digest email" hint="Where the daily list of new roles goes." htmlFor="set-email">
          <input
            id="set-email"
            className="input"
            type="email"
            value={form.notification_email}
            onChange={setInput('notification_email')}
            placeholder="you@gmail.com"
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
        <Row label="Exclude roles mentioning" hint="On top of the built-in list (software, cloud, data, AWS, Java…)." htmlFor="set-exclude">
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
              <p className="save-bar-error" role="alert">
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
    { name: 'Groq', detail: `Main AI · ${ai.groq.model}`, ok: configured.groq },
    { name: 'Gemini', detail: `Backup AI · ${ai.gemini.model}`, ok: configured.gemini },
    { name: 'LinkedIn alerts', detail: 'Jobs mailbox (IMAP)', ok: configured.imap },
    { name: 'Digest email', detail: 'Sending (SMTP)', ok: configured.smtp },
    { name: 'Schedule', detail: scheduler, ok: configured.scheduler || configured.cron, okLabel: 'Active' },
  ];

  return (
    <div className="set-stack">
      <Section id="set-usage" title="Usage" description="Free-tier budgets. Searches and AI pause on their own before a limit is reached.">
        <div className="usage-grid">
          <Usage label="Searches" period="this month" used={serpapi.searchesUsedThisMonth} limit={serpapi.monthlyLimit} note={`Pauses with ${serpapi.reserve} left`} />
          {ai.groq.configured && <Usage label="Groq tokens" period="today" used={ai.groq.today.tokens} limit={ai.groq.dailyTokens} note={`${ai.groq.today.requests} of ${ai.groq.dailyRequests} requests`} />}
          {ai.gemini.configured && (
            <Usage label="Gemini tokens" period="today" used={ai.gemini.today.tokens} limit={ai.gemini.dailyTokens} note={`${ai.gemini.today.requests} of ${ai.gemini.dailyRequests} requests`} />
          )}
        </div>
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
          <table className="table run-table">
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

/* ---------- Page ---------- */

function loadTab() {
  try {
    const t = localStorage.getItem(TAB_KEY);
    return TABS.some((x) => x.id === t) ? t : 'preferences';
  } catch {
    return 'preferences';
  }
}

export default function SettingsPage() {
  const { toast } = useToast();
  const [tab, setTab] = useState(loadTab);
  const [system, setSystem] = useState(null);
  const tabRefs = useRef({});

  const loadSystem = useCallback(() => {
    api('/system')
      .then(setSystem)
      .catch((err) => toast({ message: err.message, error: true }));
  }, [toast]);
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
          <p>Your search, alerts and connections.</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={logout}>
          Log out
        </button>
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
