import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../App.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDateTime, SOURCE_LABELS } from '../format.js';

const TASKS = [
  { name: 'fetch-jobs', label: 'Fetch jobs now', note: 'Uses SerpApi searches' },
  { name: 'read-inbox', label: 'Check LinkedIn inbox' },
  { name: 'retry-classify', label: 'Re-run AI on rule-labeled jobs', note: 'Uses Groq/Gemini tokens' },
  { name: 'send-digest', label: 'Send digest now' },
];

const LOG_LABELS = { ...SOURCE_LABELS, groq: 'AI re-label', digest: 'Digest email' };

const lines = (text) =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
const commaList = (text) =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

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
  if (result.errors?.length || result.error) parts.push('with errors (see log)');
  return parts.join(', ') || 'Done.';
}

// Today's AI spend against the daily token budget. Past it, jobs get keyword rules until tomorrow
// and the hourly re-label upgrades them.
function AiBudget({ label, ai }) {
  const used = ai.today.tokens;
  const pct = Math.min(100, Math.round((used / ai.dailyTokens) * 100));
  return (
    <div className="quota">
      <span>
        {label} tokens today: <strong>{used.toLocaleString('en-IN')}</strong> of {ai.dailyTokens.toLocaleString('en-IN')}
        <span className="muted">
          {' '}
          · {ai.today.requests} of {ai.dailyRequests} requests
        </span>
      </span>
      <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={ai.dailyTokens} aria-valuenow={used} aria-label={`${label} tokens used today`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SettingsForm() {
  const { toast } = useToast();
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api('/settings')
      .then(({ settings }) =>
        setForm({
          search_queries: settings.search_queries.join('\n'),
          cities: settings.cities.join(', '),
          digest_enabled: settings.digest_enabled,
          digest_time: settings.digest_time,
          notification_email: settings.notification_email,
          extra_exclude_keywords: settings.extra_exclude_keywords.join(', '),
        }),
      )
      .catch((err) => setError(err.message));
  }, []);

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/settings', {
        method: 'PUT',
        body: {
          search_queries: lines(form.search_queries),
          cities: commaList(form.cities),
          digest_enabled: form.digest_enabled,
          digest_time: form.digest_time,
          notification_email: form.notification_email,
          extra_exclude_keywords: commaList(form.extra_exclude_keywords),
        },
      });
      toast({ message: 'Settings saved.' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (!form) return <section className="card section">{error ? <p className="form-error">{error}</p> : <p className="muted">Loading…</p>}</section>;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  return (
    <section className="card section" aria-labelledby="prefs-title">
      <h2 id="prefs-title">Search & alerts</h2>
      <p>What to look for, and when to email you.</p>
      <form className="form-grid two" onSubmit={save}>
        {error && (
          <p className="form-error span-2" role="alert">
            {error}
          </p>
        )}
        <label className="field span-2">
          <span>Search queries</span>
          <textarea className="textarea" value={form.search_queries} onChange={set('search_queries')} rows={6} />
          <small>One per line, without a city: each one is searched in every city you pick. Each fetch runs up to 3 searches in rotation to stay within the SerpApi quota.</small>
        </label>
        <label className="field">
          <span>Cities to search</span>
          <input className="input" value={form.cities} onChange={set('cities')} placeholder="Bengaluru, Mumbai, Pune, Remote" />
          <small>Comma-separated, any city (or Remote). New jobs come in from the next fetch; these cities rank higher and fill the daily digest.</small>
        </label>
        <label className="field">
          <span>Notification email</span>
          <input className="input" type="email" value={form.notification_email} onChange={set('notification_email')} placeholder="you@example.com" />
        </label>
        <div className="field">
          <span className="field-label">Daily digest</span>
          <label className="check">
            <input type="checkbox" checked={form.digest_enabled} onChange={set('digest_enabled')} />
            Email me new roles every day
          </label>
        </div>
        <label className="field">
          <span>Digest time (IST)</span>
          <input className="input" type="time" value={form.digest_time} onChange={set('digest_time')} disabled={!form.digest_enabled} required />
        </label>
        <label className="field span-2">
          <span>Also exclude roles mentioning</span>
          <input className="input" value={form.extra_exclude_keywords} onChange={set('extra_exclude_keywords')} placeholder="sales, marketing, civil site engineer" />
          <small>Comma-separated. Added to the built-in list (software, cloud, data, AWS, Java…).</small>
        </label>
        <div className="span-2">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </section>
  );
}

function SourcesSection() {
  const { toast } = useToast();
  const { refreshMeta } = useMeta();
  const [system, setSystem] = useState(null);
  const [running, setRunning] = useState('');

  const load = useCallback(() => {
    api('/system')
      .then(setSystem)
      .catch((err) => toast({ message: err.message, error: true }));
  }, [toast]);

  useEffect(load, [load]);

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
      load();
    }
  }

  if (!system) return null;
  const { configured, serpapi } = system;
  const pct = Math.min(100, Math.round((serpapi.searchesUsedThisMonth / serpapi.monthlyLimit) * 100));
  const items = [
    ['SerpApi (Google Jobs)', configured.serpapi],
    [`Groq (${system.groqModel})`, configured.groq],
    [`Gemini (${system.ai.gemini.model})`, configured.gemini],
    ['LinkedIn inbox (IMAP)', configured.imap],
    ['Digest email (SMTP)', configured.smtp],
    ['Scheduler', configured.scheduler || configured.cron],
  ];

  return (
    <section className="card section" aria-labelledby="sources-title">
      <h2 id="sources-title">Sources</h2>
      <p>Connections are set in the server's .env file.</p>
      <div className="status-grid">
        {items.map(([label, ok]) => (
          <div key={label} className="status-item">
            <span className={`dot ${ok ? 'ok' : 'off'}`} aria-hidden="true" />
            <span>
              {label}
              <span className="visually-hidden">{ok ? ': connected' : ': not configured'}</span>
            </span>
          </div>
        ))}
      </div>

      <div className="quota">
        <span>
          SerpApi searches this month: <strong>{serpapi.searchesUsedThisMonth}</strong> of {serpapi.monthlyLimit}
          <span className="muted"> · pauses with {serpapi.reserve} left</span>
        </span>
        <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={serpapi.monthlyLimit} aria-valuenow={serpapi.searchesUsedThisMonth} aria-label="SerpApi searches used">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      {Object.entries(system.ai)
        .filter(([, ai]) => ai.configured)
        .map(([name, ai]) => (
          <AiBudget key={name} label={name === 'groq' ? 'Groq' : 'Gemini'} ai={ai} />
        ))}

      <div className="button-row" style={{ marginBottom: 20 }}>
        {TASKS.map((task) => (
          <button key={task.name} type="button" className="btn btn-sm" disabled={Boolean(running)} onClick={() => run(task)} title={task.note}>
            {running === task.name ? 'Running…' : task.label}
          </button>
        ))}
      </div>

      <h3 className="field-label" style={{ marginBottom: 8 }}>
        Recent runs
      </h3>
      {system.fetchLog.length === 0 ? (
        <p className="small muted">Nothing has run yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When (IST)</th>
                <th>Source</th>
                <th>Found</th>
                <th>New</th>
                <th>Requests</th>
              </tr>
            </thead>
            <tbody>
              {system.fetchLog.map((row) => (
                <tr key={row.id}>
                  <td className="small">{formatDateTime(row.run_at)}</td>
                  <td>
                    {LOG_LABELS[row.source] || row.source}
                    {row.error && <div className="log-error">{row.error}</div>}
                  </td>
                  <td>{row.jobs_found}</td>
                  <td>{row.jobs_new}</td>
                  <td>{row.requests_used}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ReviewSection() {
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

  if (!data) return null;
  const item = (job, extra) => (
    <>
      <div className="grow">
        <div className="truncate" style={{ fontWeight: 600 }}>
          <a href={job.apply_url} target="_blank" rel="noopener noreferrer">
            {job.title}
          </a>
        </div>
        <div className="small muted truncate">{[job.company, job.city, extra].filter(Boolean).join(' · ')}</div>
      </div>
    </>
  );

  return (
    <section className="card section" aria-labelledby="review-title">
      <h2 id="review-title">Tune the filter</h2>
      <p>Roles you hid and roles the classifier filtered out. Spot a pattern? Add it to the exclude list above.</p>

      <h3 className="field-label" style={{ marginBottom: 8 }}>
        Filtered out automatically (last 30 days)
      </h3>
      {data.filtered.length === 0 ? (
        <p className="small muted">None.</p>
      ) : (
        <ul className="review-list" style={{ marginBottom: 20 }}>
          {data.filtered.map((job) => (
            <li key={job.id}>
              {item(job, job.classify_reason)}
              <button type="button" className="btn btn-sm" onClick={() => act(`/jobs/${job.id}/restore`, 'Moved to your feed.')}>
                Show in feed
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="field-label" style={{ margin: '16px 0 8px' }}>
        Hidden by you
      </h3>
      {data.hidden.length === 0 ? (
        <p className="small muted">None.</p>
      ) : (
        <ul className="review-list">
          {data.hidden.map((job) => (
            <li key={job.id}>
              {item(job, job.hide_reason)}
              <button type="button" className="btn btn-sm" onClick={() => act(`/jobs/${job.id}/unhide`, 'Job restored.')}>
                Unhide
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function SettingsPage() {
  async function logout() {
    await api('/logout', { method: 'POST' }).catch(() => {});
    window.location.reload();
  }

  return (
    <div className="page-narrow">
      <div className="page-head">
        <h1>Settings</h1>
        <button type="button" className="btn btn-sm" onClick={logout}>
          Log out
        </button>
      </div>
      <div className="stack">
        <SettingsForm />
        <SourcesSection />
        <ReviewSection />
      </div>
    </div>
  );
}
