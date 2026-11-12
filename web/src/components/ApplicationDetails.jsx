import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from './Dialog.jsx';
import { useToast } from './Toast.jsx';

// "Application details": the popup form with what application forms ask for. ARCH in Chrome types
// these into forms exactly as saved here (server lib/details.js). It starts from what the AI read
// from the CV; whatever is typed here wins. Pay, notice, marks and gender are filled ONLY from here.

const SECTIONS = [
  {
    title: 'About you',
    fields: [
      ['name', 'Full name', 'text', 'name', 'Asha Kumar', true],
      ['email', 'Email', 'email', 'email', 'you@example.com', true],
      ['phone', 'Phone', 'tel', 'tel', '+91 98765 43210', true],
      ['date_of_birth', 'Date of birth', 'date', 'bday', ''],
      ['gender', 'Gender', 'select:genders', 'sex', ''],
      ['nationality', 'Nationality', 'text', 'off', 'Indian'],
    ],
  },
  {
    title: 'Address',
    fields: [
      ['address', 'Street address', 'text', 'street-address', 'House, street, area'],
      ['city', 'City', 'text', 'address-level2', 'Bengaluru', true],
      ['state', 'State', 'text', 'address-level1', 'Karnataka'],
      ['pincode', 'PIN code', 'text', 'postal-code', '560001'],
      ['country', 'Country', 'text', 'country-name', 'India'],
    ],
  },
  {
    title: 'Education',
    fields: [
      ['discipline', 'Field', 'list:disciplines', 'off', 'Architecture, Civil engineering…'],
      ['degree', 'Degree', 'text', 'off', 'B.Arch, B.Tech, B.Des, Diploma…', true],
      ['specialization', 'Specialisation / branch', 'text', 'off', 'Structures, Thermal, Interiors…'],
      ['institution', 'College / university', 'text', 'organization', 'Your college', true],
      ['graduation_year', 'Graduation year', 'number', 'off', '2027', true],
      ['score', 'CGPA or percentage', 'text', 'off', '8.2 CGPA or 76%'],
    ],
  },
  {
    title: 'Links',
    fields: [
      ['linkedin', 'LinkedIn', 'url', 'url', 'linkedin.com/in/you'],
      ['website', 'Portfolio / website', 'url', 'url', 'behance.net/you or issuu.com/you'],
      ['github', 'GitHub', 'url', 'url', 'github.com/you'],
    ],
  },
  {
    title: 'Work and availability',
    fields: [
      ['current_company', 'Current company', 'text', 'organization', 'Leave empty if studying'],
      ['current_title', 'Current role', 'text', 'organization-title', 'Junior Architect'],
      ['current_ctc', 'Current CTC / stipend', 'text', 'off', '₹15,000 a month or 3 LPA'],
      ['expected_ctc', 'Expected CTC / stipend', 'text', 'off', '₹20,000 a month or 4 LPA'],
      ['notice_period', 'Notice period', 'text', 'off', 'Immediate, 15 days, 1 month'],
      ['available_from', 'Can start from', 'date', 'off', ''],
      ['relocate', 'Willing to relocate', 'select:relocate', 'off', ''],
      ['preferred_cities', 'Preferred cities', 'text', 'off', 'Bengaluru, Pune, Remote'],
      ['languages', 'Languages', 'text', 'off', 'English, Hindi'],
      ['heard_from', '"How did you hear about us?"', 'text', 'off', 'LinkedIn, Naukri, College'],
    ],
  },
];

const ALL = SECTIONS.flatMap((s) => s.fields);

export function ApplicationDetailsDialog({ open, onClose, state, onSaved }) {
  const { toast } = useToast();
  const [form, setForm] = useState(() => ({ ...(state?.details || {}) }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      setForm({ ...(state?.details || {}) });
      setError('');
    }
  }, [open, state?.details]);

  const opts = { genders: state?.details_options?.genders || [], relocate: ['Yes', 'No'], disciplines: state?.details_options?.disciplines || [] };

  async function save() {
    setSaving(true);
    setError('');
    try {
      const d = await api('/profile/details', { method: 'PUT', body: form });
      onSaved?.(d);
      const labels = (d.rejected || []).map((k) => ALL.find(([key]) => key === k)?.[1] || k);
      toast({ message: labels.length ? `Saved. These did not look right and were left empty: ${labels.join(', ')}.` : 'Saved. ARCH in Chrome fills application forms with these.', error: labels.length > 0, duration: 6000 });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Dialog
      open={open}
      title="Application details"
      onClose={onClose}
      onSubmit={save}
      error={error}
      actions={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save details'}
          </button>
        </>
      }
    >
      <p className="small muted details-intro">
        What job application forms ask for. ARCH in Chrome types these in exactly as written when you press Fill. Started from your CV; correct anything. Leave a box empty and
        ARCH leaves that field for you. Pay, notice period, marks and gender are only ever filled from here.
      </p>
      <datalist id="details-disciplines">
        {opts.disciplines.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <div className="details-form">
        {SECTIONS.map((section) => (
          <fieldset key={section.title} className="details-section">
            <legend>{section.title}</legend>
            <div className="profile-grid contact-grid">
              {section.fields.map(([key, label, type, autoComplete, placeholder, essential]) => {
                const value = form[key] ?? '';
                const id = `details-${key}`;
                const missing = essential && !value;
                let input;
                if (type.startsWith('select:')) {
                  input = (
                    <select id={id} className="select" value={value} onChange={set(key)} autoComplete={autoComplete}>
                      <option value="">Not given</option>
                      {opts[type.slice(7)].map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  );
                } else {
                  input = (
                    <input
                      id={id}
                      className="input"
                      type={type.startsWith('list:') ? 'text' : type}
                      list={type.startsWith('list:') ? `details-${type.slice(5)}` : undefined}
                      value={value}
                      onChange={set(key)}
                      autoComplete={autoComplete}
                      placeholder={placeholder}
                      min={type === 'number' ? 1980 : undefined}
                      max={type === 'number' ? 2040 : undefined}
                      maxLength={key === 'address' ? 200 : 120}
                      aria-invalid={missing || undefined}
                    />
                  );
                }
                return (
                  <label key={key} className="field" htmlFor={id}>
                    <span>
                      {label}
                      {essential && <span className="details-req"> · needed by most forms</span>}
                    </span>
                    {input}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </Dialog>
  );
}

// The card on the Profile page: what is saved at a glance, and the button that opens the form.
export function ApplicationDetailsCard({ state, onOpen }) {
  const d = state?.details || {};
  const missing = state?.details_missing || [];
  const label = (k) => ALL.find(([key]) => key === k)?.[1] || k;
  const shown = ['name', 'email', 'phone', 'city', 'degree', 'institution', 'graduation_year', 'expected_ctc', 'notice_period'].filter((k) => d[k]);
  return (
    <section className="card profile-section details-card">
      <div className="profile-section-head">
        <h3>Application details</h3>
        <button type="button" className="btn btn-primary btn-sm" onClick={onOpen}>
          {state?.details_saved ? 'Edit details' : 'Fill in details'}
        </button>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        Name, contact, address, college, marks, pay and notice period: what application forms ask for. ARCH in Chrome fills forms from these when you press Fill.
      </p>
      {shown.length > 0 && (
        <dl className="details-summary small">
          {shown.map((k) => (
            <div key={k}>
              <dt>{label(k)}</dt>
              <dd>{d[k]}</dd>
            </div>
          ))}
        </dl>
      )}
      {missing.length > 0 && (
        <p className="small details-missing" role="status">
          Still needed: {missing.map(label).join(', ')}.
        </p>
      )}
    </section>
  );
}
