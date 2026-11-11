import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from './Toast.jsx';

// Profile page: the contact details ARCH in Chrome fills application forms with, and where to get
// the extension. The details start as what the AI read from the CV; whatever is typed here wins.

const FIELDS = [
  ['name', 'Full name', 'text', 'name', 'Asha Kumar'],
  ['email', 'Email', 'email', 'email', 'you@example.com'],
  ['phone', 'Phone', 'tel', 'tel', '+91 98765 43210'],
  ['city', 'City you live in', 'text', 'address-level2', 'Bengaluru'],
  ['linkedin', 'LinkedIn', 'url', 'url', 'linkedin.com/in/you'],
  ['website', 'Portfolio link', 'url', 'url', 'behance.net/you or issuu.com/you'],
  ['date_of_birth', 'Date of birth', 'date', 'bday', ''],
  ['address', 'Postal address', 'text', 'street-address', 'One line, as forms ask for it'],
];

const fromProfile = (profile) => ({ name: profile.name || '', ...Object.fromEntries(FIELDS.slice(1).map(([k]) => [k, profile.contact?.[k] || ''])) });

export function ContactCard({ profile, onSaved }) {
  const { toast } = useToast();
  const [form, setForm] = useState(() => fromProfile(profile));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setForm(fromProfile(profile));
  }, [profile]);
  const saved = fromProfile(profile);
  const dirty = FIELDS.some(([k]) => form[k] !== saved[k]);

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const { name, ...contact } = form;
      const d = await api('/profile', { method: 'PATCH', body: { name, contact } });
      onSaved(d);
      const now = fromProfile(d.profile);
      const dropped = FIELDS.filter(([k]) => form[k] && !now[k]).map(([, label]) => label);
      toast({ message: dropped.length ? `Saved. These did not look right and were left empty: ${dropped.join(', ')}.` : 'Saved. ARCH in Chrome fills forms with these.', error: dropped.length > 0, duration: 6000 });
    } catch (err) {
      toast({ message: err.message, error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="card profile-section" onSubmit={save}>
      <h3>Details for application forms</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        Read from your CV; correct or add anything missing. ARCH in Chrome types these into application forms exactly as they are here. Leave a box empty and ARCH leaves that field for you.
      </p>
      <div className="profile-grid contact-grid">
        {FIELDS.map(([key, label, type, autoComplete, placeholder]) => (
          <label key={key} className="field">
            <span>{label}</span>
            <input
              className="input"
              type={type}
              value={form[key]}
              autoComplete={autoComplete}
              placeholder={placeholder}
              maxLength={key === 'address' ? 200 : 120}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
            />
          </label>
        ))}
      </div>
      <div className="dialog-actions">
        <button type="submit" className="btn btn-primary btn-sm" disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save details'}
        </button>
      </div>
    </form>
  );
}

export function ExtensionCard({ fillsToday, fillsPerDay }) {
  return (
    <section className="card profile-section extension-card">
      <div className="extension-head">
        <span className="extension-mark" aria-hidden="true">
          A
        </span>
        <div>
          <h3>ARCH in Chrome</h3>
          <p className="small muted" style={{ margin: 0 }}>
            Fills job applications on any site from this profile. You check every field and press submit yourself.
          </p>
        </div>
      </div>
      <ul className="small extension-points">
        <li>
          <strong>Name, email, phone, college, degree, LinkedIn, portfolio link</strong> come straight from the details above (blue outline).
        </li>
        <li>
          <strong>Your CV and portfolio PDFs</strong> are attached to the upload boxes for you.
        </li>
        <li>
          <strong>Open questions</strong> ("Why this firm?", "Your Revit experience") are drafted by AI from your CV and that posting (amber outline: read them). Pay, notice period, marks and
          personal details are always left to you.
        </li>
        <li>
          <strong>Postings ArchJobs can't read</strong> (Glassdoor): open one with ARCH installed and it sends the posting here, so "Analyse" reads the real requirements.
        </li>
      </ul>
      <ol className="small extension-steps">
        <li>
          <a className="btn btn-primary btn-sm" href="/api/extension.zip" download>
            Download ARCH in Chrome
          </a>{' '}
          and unzip it.
        </li>
        <li>
          Open <code>chrome://extensions</code>, switch on <strong>Developer mode</strong> (top right), click <strong>Load unpacked</strong> and pick the <code>arch-in-chrome</code> folder.
        </li>
        <li>
          Stay signed in to ArchJobs in Chrome. On an application form, click <strong>Fill with ARCH</strong> or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>.
        </li>
      </ol>
      {fillsPerDay ? (
        <p className="small muted" style={{ margin: 0 }}>
          AI answers today: {fillsToday} of {fillsPerDay}. Fields filled straight from your details don't count.
        </p>
      ) : null}
    </section>
  );
}
