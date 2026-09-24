import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useMeta } from '../App.jsx';
import { Dialog } from '../components/Dialog.jsx';
import { useToast } from '../components/Toast.jsx';
import { APP_STATUSES, dayToIso, followUpState, formatDate, formatSalary, istDay, STATUS_LABELS } from '../format.js';
import { IconEdit, IconExternal, IconPlus } from '../icons.jsx';

const VIEW_KEY = 'aj-tracker-view';

function FollowUp({ app }) {
  if (!app.follow_up_at || !['applied', 'interview'].includes(app.status)) return null;
  const state = followUpState(app.follow_up_at, app.status);
  const label = state === 'overdue' ? 'Follow-up overdue' : state === 'due' ? 'Follow up today' : 'Follow up';
  const cls = state === 'overdue' ? 'badge-red' : state === 'due' ? 'badge-amber' : '';
  return (
    <span className={`badge ${cls}`}>
      {label} · {formatDate(app.follow_up_at)}
    </span>
  );
}

function StatusSelect({ app, onMove, small = true }) {
  return (
    <label>
      <span className="visually-hidden">Status for {app.title}</span>
      <select className={`select${small ? ' select-sm' : ''}`} value={app.status} onChange={(e) => onMove(app, e.target.value)}>
        {APP_STATUSES.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  );
}

function AppCard({ app, onMove, onEdit }) {
  return (
    <li
      className="card app-card"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(app.id));
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      <h3>
        <button type="button" onClick={() => onEdit(app)}>
          {app.title}
        </button>
      </h3>
      <div className="small muted">{[app.company, app.city].filter(Boolean).join(' · ')}</div>
      {(formatSalary(app) || app.applied_at) && (
        <div className="small muted">
          {[formatSalary(app), app.applied_at && `Applied ${formatDate(app.applied_at)}`].filter(Boolean).join(' · ')}
        </div>
      )}
      <FollowUp app={app} />
      <div className="row">
        <StatusSelect app={app} onMove={onMove} />
        {app.apply_url && (
          <a className="icon-btn" href={app.apply_url} target="_blank" rel="noopener noreferrer" aria-label={`Open posting for ${app.title}`}>
            <IconExternal size={18} />
          </a>
        )}
      </div>
    </li>
  );
}

function Board({ apps, onMove, onEdit }) {
  const [over, setOver] = useState(null);
  return (
    <div className="kanban">
      {APP_STATUSES.map((status) => {
        const items = apps.filter((a) => a.status === status);
        return (
          <section
            key={status}
            className={`column${over === status ? ' is-over' : ''}`}
            aria-label={`${STATUS_LABELS[status]} (${items.length})`}
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              setOver(status);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setOver(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const app = apps.find((a) => String(a.id) === e.dataTransfer.getData('text/plain'));
              if (app && app.status !== status) onMove(app, status);
            }}
          >
            <div className="column-head">
              <span>{STATUS_LABELS[status]}</span>
              <span className="badge">{items.length}</span>
            </div>
            {items.length ? (
              <ul className="column-list">
                {items.map((app) => (
                  <AppCard key={app.id} app={app} onMove={onMove} onEdit={onEdit} />
                ))}
              </ul>
            ) : (
              <p className="column-empty">{status === 'saved' ? 'Save roles from the Jobs feed.' : 'Drag cards here.'}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Table({ apps, onMove, onEdit }) {
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Role</th>
            <th>Status</th>
            <th>Applied</th>
            <th>Follow-up</th>
            <th>Contact</th>
            <th>
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => (
            <tr key={app.id}>
              <td>
                <div className="title-cell">{app.title}</div>
                <div className="small muted">{[app.company, app.city].filter(Boolean).join(' · ')}</div>
              </td>
              <td>
                <StatusSelect app={app} onMove={onMove} />
              </td>
              <td className="small">{app.applied_at ? formatDate(app.applied_at) : '—'}</td>
              <td className="small">
                {!app.follow_up_at ? '—' : ['applied', 'interview'].includes(app.status) ? <FollowUp app={app} /> : formatDate(app.follow_up_at)}
              </td>
              <td className="small">
                {app.contact_name || app.contact_email ? (
                  <>
                    {app.contact_name}
                    {app.contact_email && (
                      <div>
                        <a href={`mailto:${app.contact_email}`}>{app.contact_email}</a>
                      </div>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td>
                <div className="cell-actions">
                  {app.apply_url && (
                    <a className="icon-btn" href={app.apply_url} target="_blank" rel="noopener noreferrer" aria-label={`Open posting for ${app.title}`}>
                      <IconExternal size={18} />
                    </a>
                  )}
                  <button type="button" className="icon-btn" onClick={() => onEdit(app)} aria-label={`Edit ${app.title}`}>
                    <IconEdit size={18} />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EMPTY_FORM = { title: '', company: '', apply_url: '', status: 'saved', applied_at: '', follow_up_at: '', contact_name: '', contact_email: '', notes: '' };

function toForm(app) {
  return {
    ...EMPTY_FORM,
    ...Object.fromEntries(Object.entries(app).map(([k, v]) => [k, v ?? ''])),
    applied_at: app.applied_at ? istDay(app.applied_at) : '',
    follow_up_at: app.follow_up_at ? istDay(app.follow_up_at) : '',
  };
}

function AppDialog({ app, onClose, onSaved, onDeleted }) {
  const isNew = !app.id;
  const manual = isNew || !app.job_id;
  const [form, setForm] = useState(() => toForm(app));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    setError('');
    const body = {
      status: form.status,
      applied_at: dayToIso(form.applied_at),
      follow_up_at: dayToIso(form.follow_up_at),
      contact_name: form.contact_name,
      contact_email: form.contact_email,
      notes: form.notes,
      ...(manual && { title: form.title, company: form.company, apply_url: form.apply_url }),
    };
    // Let the server stamp dates when moving to Applied without explicit dates.
    if (!form.applied_at) delete body.applied_at;
    if (!form.follow_up_at && !app.follow_up_at) delete body.follow_up_at;
    try {
      const res = isNew
        ? await api('/applications', { method: 'POST', body })
        : await api(`/applications/${app.id}`, { method: 'PATCH', body });
      onSaved(res.application);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/applications/${app.id}`, { method: 'DELETE' });
      onDeleted(app);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={isNew ? 'Add a role' : 'Edit application'}
      onClose={onClose}
      onSubmit={submit}
      error={error}
      actions={
        <>
          {!isNew && (
            <button type="button" className="btn btn-ghost btn-danger left" onClick={remove} disabled={busy}>
              Remove
            </button>
          )}
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="form-grid two">
        {manual ? (
          <>
            <label className="field span-2">
              <span>Role</span>
              <input className="input" value={form.title} onChange={set('title')} required maxLength={300} placeholder="e.g. BIM Intern" />
            </label>
            <label className="field">
              <span>Firm</span>
              <input className="input" value={form.company} onChange={set('company')} maxLength={200} />
            </label>
            <label className="field">
              <span>Link</span>
              <input className="input" type="url" value={form.apply_url} onChange={set('apply_url')} placeholder="https://" />
            </label>
          </>
        ) : (
          <p className="span-2" style={{ margin: 0 }}>
            <strong>{app.title}</strong>
            <br />
            <span className="muted">{[app.company, app.city].filter(Boolean).join(' · ')}</span>
          </p>
        )}
        <label className="field">
          <span>Status</span>
          <select className="select" style={{ width: '100%' }} value={form.status} onChange={set('status')}>
            {APP_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Date applied</span>
          <input className="input" type="date" value={form.applied_at} onChange={set('applied_at')} />
        </label>
        <label className="field">
          <span>Follow up on</span>
          <input className="input" type="date" value={form.follow_up_at} onChange={set('follow_up_at')} />
          <small>Set automatically 7 days after applying.</small>
        </label>
        <label className="field">
          <span>Contact name</span>
          <input className="input" value={form.contact_name} onChange={set('contact_name')} maxLength={150} />
        </label>
        <label className="field span-2">
          <span>Contact email</span>
          <input className="input" type="email" value={form.contact_email} onChange={set('contact_email')} maxLength={200} />
        </label>
        <label className="field span-2">
          <span>Notes</span>
          <textarea className="textarea" value={form.notes} onChange={set('notes')} maxLength={5000} />
        </label>
      </div>
    </Dialog>
  );
}

export default function TrackerPage() {
  const { refreshMeta } = useMeta();
  const { toast } = useToast();
  const [apps, setApps] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [view, setView] = useState(() => {
    try {
      return localStorage.getItem(VIEW_KEY) || 'board';
    } catch {
      return 'board';
    }
  });

  const load = useCallback(() => {
    api('/applications')
      .then((d) => setApps(d.applications))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const chooseView = (v) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // ignore
    }
  };

  const replace = (app) => setApps((list) => [app, ...list.filter((a) => a.id !== app.id)]);

  const move = useCallback(
    async (app, status) => {
      setApps((list) => list.map((a) => (a.id === app.id ? { ...a, status } : a)));
      try {
        const { application } = await api(`/applications/${app.id}`, { method: 'PATCH', body: { status } });
        setApps((list) => list.map((a) => (a.id === app.id ? application : a)));
        refreshMeta();
        if (status === 'applied' && application.follow_up_at) {
          toast({ message: `Follow-up set for ${formatDate(application.follow_up_at)}.` });
        }
      } catch (err) {
        setApps((list) => list.map((a) => (a.id === app.id ? app : a)));
        toast({ message: err.message, error: true });
      }
    },
    [refreshMeta, toast],
  );

  const due = apps?.filter((a) => followUpState(a.follow_up_at, a.status)).length || 0;

  return (
    <div>
      <div className="page-head">
        <h1>Tracker</h1>
        <div className="segmented" role="group" aria-label="View">
          <button type="button" aria-pressed={view === 'board'} onClick={() => chooseView('board')}>
            Board
          </button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => chooseView('table')}>
            Table
          </button>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
          <IconPlus size={16} /> Add role
        </button>
      </div>

      {due > 0 && (
        <p className="small" style={{ marginTop: -6 }}>
          <span className="badge badge-amber">
            {due} follow-up{due === 1 ? '' : 's'} due
          </span>
        </p>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!apps && !error && <p className="center-note">Loading…</p>}
      {apps && apps.length === 0 && view === 'table' && (
        <div className="card empty">
          <h2>Nothing tracked yet</h2>
          <p>Save roles from the Jobs feed, or add one you found elsewhere.</p>
        </div>
      )}
      {apps && view === 'board' && <Board apps={apps} onMove={move} onEdit={setEditing} />}
      {apps && apps.length > 0 && view === 'table' && <Table apps={apps} onMove={move} onEdit={setEditing} />}

      {editing && (
        <AppDialog
          app={editing}
          onClose={() => setEditing(null)}
          onSaved={(app) => {
            replace(app);
            setEditing(null);
            refreshMeta();
          }}
          onDeleted={(app) => {
            setApps((list) => list.filter((a) => a.id !== app.id));
            setEditing(null);
            refreshMeta();
          }}
        />
      )}
    </div>
  );
}
