import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../App.jsx';
import { formatDate, MAIL_KIND_LABELS, STATUS_LABELS, timeAgo } from '../format.js';
import { IconMail } from '../icons.jsx';
import { Dialog } from './Dialog.jsx';
import { useToast } from './Toast.jsx';

// Gmail on the Jobs page: check it now, and see what was read from it, day by day. Connecting and
// disconnecting stay in Settings.

const KIND_CLASS = { offer: 'badge-accent', interview: 'badge-accent', assessment: 'badge-accent', rejected: 'badge-red', other: 'badge-outline' };

// 'YYYY-MM-DD' in IST, the same day keys the server groups by.
const istDay = (date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);

function dayLabel(day) {
  const today = istDay(new Date());
  const yesterday = istDay(new Date(Date.now() - 86_400_000));
  if (day === today) return 'Today';
  if (day === yesterday) return 'Yesterday';
  return formatDate(`${day}T12:00:00+05:30`, { weekday: 'short', day: 'numeric', month: 'short' });
}

function EmailRow({ email }) {
  const what =
    email.kind === 'alert'
      ? `${email.jobsFound || 0} job${email.jobsFound === 1 ? '' : 's'} added to Jobs`
      : [email.company, email.role].filter(Boolean).join(' · ');
  return (
    <li className="mail-row">
      <span className={`badge ${KIND_CLASS[email.kind] || ''}`}>{MAIL_KIND_LABELS[email.kind] || email.kind}</span>
      <div className="mail-body">
        <div className="mail-subject">{email.subject || '(no subject)'}</div>
        <div className="small muted">
          {[email.from, formatDate(email.receivedAt, { hour: 'numeric', minute: '2-digit' })].filter(Boolean).join(' · ')}
        </div>
        {what && <div className="small">{what}</div>}
        {email.tracker && (
          <a className="small" href="#/tracker">
            In your Tracker: {email.tracker.title} ({STATUS_LABELS[email.tracker.status] || email.tracker.status})
          </a>
        )}
      </div>
    </li>
  );
}

function EmailsDialog({ open, onClose, days, loading }) {
  return (
    <Dialog open={open} title="Emails read from Gmail" onClose={onClose}>
      <p className="small muted" style={{ margin: 0 }}>
        The last 30 days: LinkedIn alerts and emails about your applications. Nothing else in your mailbox is opened.
      </p>
      {loading && <p className="muted">Loading…</p>}
      {!loading && days && !days.length && <p className="muted">No emails read yet. New ones show up here after the next check.</p>}
      {!loading &&
        days?.map((d) => (
          <section key={d.day} className="mail-day">
            <h3>
              {dayLabel(d.day)} <span className="muted">· {d.emails.length}</span>
            </h3>
            <ul>
              {d.emails.map((e) => (
                <EmailRow key={e.id} email={e} />
              ))}
            </ul>
          </section>
        ))}
    </Dialog>
  );
}

export default function GmailBar({ onSynced }) {
  const { me, refreshMe, refreshMeta } = useMeta();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(null);
  const [loading, setLoading] = useState(false);
  const gmail = me?.gmail;

  const loadEmails = useCallback(async () => {
    setLoading(true);
    try {
      setDays((await api('/account/gmail/emails?days=30')).days);
    } catch (err) {
      toast({ message: err.message, error: true });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  async function check() {
    setBusy(true);
    try {
      const { result: r = {} } = await api('/account/gmail/sync', { method: 'POST' });
      const parts = [`${r.messages || 0} new alert${r.messages === 1 ? '' : 's'} (${r.new || 0} new jobs)`, `${r.emails || 0} application email${r.emails === 1 ? '' : 's'} (${r.tracked || 0} tracker updates)`];
      toast({ message: r.skipped ? `Skipped: ${r.skipped}` : r.errors?.length ? r.errors[0] : `Gmail checked: ${parts.join(', ')}.`, error: Boolean(r.errors?.length), duration: 7000 });
      refreshMe();
      refreshMeta();
      onSynced?.();
      if (open) loadEmails();
    } catch (err) {
      toast({ message: err.message, error: true });
    } finally {
      setBusy(false);
    }
  }

  if (!gmail) return null;
  if (!gmail.connected) {
    return (
      <p className="gmail-bar muted">
        <IconMail size={16} /> Connect Gmail to bring in your LinkedIn alerts and keep your Tracker up to date. <a href="#/settings">Connect in Settings</a>
      </p>
    );
  }
  return (
    <div className="gmail-bar">
      <IconMail size={16} />
      <span className="grow small muted">
        Gmail {gmail.error ? <span className="form-error">· {gmail.error}</span> : gmail.syncedAt ? `· checked ${timeAgo(gmail.syncedAt)}` : '· first check running'}
      </span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={() => {
          setOpen(true);
          loadEmails();
        }}
      >
        Emails read
      </button>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={check}>
        {busy ? 'Checking…' : 'Check now'}
      </button>
      <EmailsDialog open={open} onClose={() => setOpen(false)} days={days} loading={loading} />
    </div>
  );
}
