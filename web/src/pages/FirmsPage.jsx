import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, toQuery } from '../api.js';
import { Dialog } from '../components/Dialog.jsx';
import { RowsSkeleton } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { firmsFromCsv } from '../csv.js';
import { FIRM_STATUSES, FIRM_TYPES, formatDate } from '../format.js';
import { IconEdit, IconMail, IconPlus, IconSearch } from '../icons.jsx';

const EMPTY = { name: '', city: '', type: 'design studio', website: '', contact_email: '', status: 'not contacted', notes: '' };

function FirmDialog({ firm, onClose, onSaved, onDeleted }) {
  const isNew = !firm.id;
  const [form, setForm] = useState(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(firm).map(([k, v]) => [k, v ?? ''])) }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit() {
    setBusy(true);
    setError('');
    const body = {
      name: form.name,
      city: form.city,
      type: form.type,
      website: form.website,
      contact_email: form.contact_email,
      status: form.status,
      notes: form.notes,
    };
    try {
      const res = isNew ? await api('/firms', { method: 'POST', body }) : await api(`/firms/${firm.id}`, { method: 'PATCH', body });
      onSaved(res.firm);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(`/firms/${firm.id}`, { method: 'DELETE' });
      onDeleted(firm);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={isNew ? 'Add a firm' : 'Edit firm'}
      onClose={onClose}
      onSubmit={submit}
      error={error}
      actions={
        <>
          {!isNew && (
            <button type="button" className="btn btn-ghost btn-danger left" onClick={remove} disabled={busy}>
              Delete
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
        <label className="field span-2">
          <span>Firm name</span>
          <input className="input" value={form.name} onChange={set('name')} required maxLength={200} />
        </label>
        <label className="field">
          <span>City</span>
          <input className="input" value={form.city} onChange={set('city')} maxLength={120} />
        </label>
        <label className="field">
          <span>Type</span>
          <select className="select" style={{ width: '100%' }} value={form.type} onChange={set('type')}>
            {FIRM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Website</span>
          <input className="input" value={form.website} onChange={set('website')} placeholder="studio.in" maxLength={500} />
        </label>
        <label className="field">
          <span>Contact email</span>
          <input className="input" type="email" value={form.contact_email} onChange={set('contact_email')} maxLength={200} />
        </label>
        <label className="field span-2">
          <span>Status</span>
          <select className="select" style={{ width: '100%' }} value={form.status} onChange={set('status')}>
            {FIRM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="field span-2">
          <span>Notes</span>
          <textarea className="textarea" value={form.notes} onChange={set('notes')} maxLength={5000} />
        </label>
      </div>
    </Dialog>
  );
}

function ImportDialog({ onClose, onImported }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firms = useMemo(() => firmsFromCsv(text), [text]);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const res = await api('/firms/import', { method: 'POST', body: { firms } });
      onImported(res);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title="Import firms"
      onClose={onClose}
      onSubmit={submit}
      error={error}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !firms.length}>
            {busy ? 'Importing…' : `Import ${firms.length || ''}`}
          </button>
        </>
      }
    >
      <label className="field">
        <span>Paste CSV from a spreadsheet</span>
        <textarea
          className="textarea"
          style={{ minHeight: 180, fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'name, city, type, website, email\nStudio Example, Bengaluru, design studio, example.in, hello@example.in'}
        />
        <small>
          Columns: name, city, type, website, email, notes. A header row is optional. Firms already in your list are skipped.
        </small>
      </label>
      {text && (
        <p className="small muted" style={{ margin: 0 }}>
          {firms.length} firm{firms.length === 1 ? '' : 's'} found.
        </p>
      )}
    </Dialog>
  );
}

export default function FirmsPage() {
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [firms, setFirms] = useState(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null);
  const [importing, setImporting] = useState(false);

  const load = useCallback(() => {
    api(`/firms${toQuery({ q, status })}`)
      .then((d) => {
        setFirms(d.firms);
        setError('');
      })
      .catch((err) => setError(err.message));
  }, [q, status]);

  useEffect(() => {
    const id = setTimeout(load, 250);
    return () => clearTimeout(id);
  }, [load]);

  const replace = (firm) => setFirms((list) => (list.some((f) => f.id === firm.id) ? list.map((f) => (f.id === firm.id ? firm : f)) : [firm, ...list]));

  async function markEmailed(firm) {
    try {
      const res = await api(`/firms/${firm.id}/emailed`, { method: 'POST' });
      replace(res.firm);
      toast({ message: `Marked ${firm.name} as emailed today.` });
    } catch (err) {
      toast({ message: err.message, error: true });
    }
  }

  async function changeStatus(firm, value) {
    try {
      const res = await api(`/firms/${firm.id}`, { method: 'PATCH', body: { status: value } });
      replace(res.firm);
    } catch (err) {
      toast({ message: err.message, error: true });
    }
  }

  const statusSelect = (firm) => (
    <label>
      <span className="visually-hidden">Status for {firm.name}</span>
      <select className="select select-sm" value={firm.status} onChange={(e) => changeStatus(firm, e.target.value)}>
        {FIRM_STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );

  const nameCell = (firm) =>
    firm.website ? (
      <a href={firm.website} target="_blank" rel="noopener noreferrer">
        {firm.name}
      </a>
    ) : (
      firm.name
    );

  return (
    <div>
      <div className="page-head">
        <h1>Firms</h1>
        <button type="button" className="btn btn-sm" onClick={() => setImporting(true)}>
          Import CSV
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
          <IconPlus size={16} /> Add firm
        </button>
      </div>

      <div className="filters" style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
        <label className="search">
          <span className="visually-hidden">Search firms</span>
          <IconSearch size={18} />
          <input className="input" type="search" placeholder="Search firms, cities, notes" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label>
          <span className="visually-hidden">Status</span>
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {FIRM_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!firms && !error && <RowsSkeleton rows={6} label="Loading firms" />}
      {firms && firms.length === 0 && (
        <div className="card empty">
          <h2>{q || status ? 'No firms match' : 'Your cold-email list is empty'}</h2>
          <p>Add studios and BIM consultancies you want to reach out to, or paste a list from a spreadsheet.</p>
        </div>
      )}

      {firms && firms.length > 0 && (
        <>
          <div className="card table-wrap only-desktop">
            <table className="table">
              <thead>
                <tr>
                  <th>Firm</th>
                  <th>City</th>
                  <th>Type</th>
                  <th>Contact</th>
                  <th>Last emailed</th>
                  <th>Status</th>
                  <th>
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {firms.map((firm) => (
                  <tr key={firm.id}>
                    <td className="title-cell">{nameCell(firm)}</td>
                    <td>{firm.city || '—'}</td>
                    <td className="small">{firm.type || '—'}</td>
                    <td className="small">{firm.contact_email ? <a href={`mailto:${firm.contact_email}`}>{firm.contact_email}</a> : '—'}</td>
                    <td className="small">{firm.last_emailed_at ? formatDate(firm.last_emailed_at, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}</td>
                    <td>{statusSelect(firm)}</td>
                    <td>
                      <div className="cell-actions">
                        <button type="button" className="btn btn-sm" onClick={() => markEmailed(firm)}>
                          <IconMail size={16} /> Emailed
                        </button>
                        <button type="button" className="icon-btn" onClick={() => setEditing(firm)} aria-label={`Edit ${firm.name}`}>
                          <IconEdit size={18} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <ul className="firm-cards only-mobile">
            {firms.map((firm) => (
              <li key={firm.id} className="card firm-card">
                <strong>{nameCell(firm)}</strong>
                <div className="small muted">
                  {[firm.city, firm.type, firm.last_emailed_at && `emailed ${formatDate(firm.last_emailed_at)}`].filter(Boolean).join(' · ')}
                </div>
                {firm.contact_email && (
                  <a className="small" href={`mailto:${firm.contact_email}`}>
                    {firm.contact_email}
                  </a>
                )}
                <div className="row">
                  {statusSelect(firm)}
                  <button type="button" className="btn btn-sm" onClick={() => markEmailed(firm)}>
                    <IconMail size={16} /> Emailed
                  </button>
                  <button type="button" className="icon-btn" onClick={() => setEditing(firm)} aria-label={`Edit ${firm.name}`}>
                    <IconEdit size={18} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {editing && (
        <FirmDialog
          firm={editing}
          onClose={() => setEditing(null)}
          onSaved={(firm) => {
            replace(firm);
            setEditing(null);
          }}
          onDeleted={(firm) => {
            setFirms((list) => list.filter((f) => f.id !== firm.id));
            setEditing(null);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={(res) => {
            setImporting(false);
            load();
            toast({
              message: `Imported ${res.imported} firm${res.imported === 1 ? '' : 's'}${res.skipped ? `, skipped ${res.skipped} already listed` : ''}${res.errors.length ? `, ${res.errors.length} with errors` : ''}.`,
              duration: 6000,
            });
          }}
        />
      )}
    </div>
  );
}
