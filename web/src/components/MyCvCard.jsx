import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDateTime } from '../format.js';
import { IconRefresh, IconSparkle } from '../icons.jsx';

// Profile page: "My CV", a detailed, ATS-friendly CV written from her CV, portfolio and
// application details (server lib/tailor.js with no posting). ARCH in Chrome attaches it when no
// CV was uploaded, so a student with only a portfolio still has a CV to send.

export default function MyCvCard({ hasResume, ready }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    api('/tailor?general=1')
      .then((d) => alive && setState({ cv: d.tailored, available: d.available, today: d.today, limit: d.limit }))
      .catch(() => alive && setState({ available: false }));
    return () => {
      alive = false;
    };
  }, []);

  const make = async () => {
    setState((s) => ({ ...s, busy: true, error: '' }));
    try {
      const d = await api('/tailor', { method: 'POST', body: { general: true, refresh: Boolean(state.cv) } });
      setState((s) => ({ ...s, busy: false, cv: d.tailored, today: d.reused ? s.today : (s.today || 0) + 1 }));
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err.message }));
    }
  };

  if (state.loading || !ready || (!state.available && !state.cv)) return null;
  const cv = state.cv;
  return (
    <section className="card profile-section">
      <div className="profile-section-head">
        <h3>
          <IconSparkle size={15} /> My CV
        </h3>
        {cv && !state.busy && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={make} title="Write it again from your latest files and details">
            <IconRefresh size={14} /> Make again
          </button>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        A detailed CV that hiring software (ATS) reads cleanly: one column of real text, standard headings, your tools named the way you wrote them. Written only from your
        {hasResume ? ' CV,' : ''} portfolio and application details: nothing you don't have is added.
        {!hasResume && ' You have no CV uploaded, so ARCH in Chrome attaches this one to application forms.'}
      </p>
      {state.busy && (
        <div className="ai-working" role="status" aria-live="polite">
          <span className="ai-pulse" aria-hidden="true" /> Writing your CV… (up to a minute)
        </div>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {!cv && !state.busy && (
        <button type="button" className="btn btn-primary btn-sm" onClick={make}>
          <IconSparkle size={16} /> Make my CV
        </button>
      )}
      {cv && !state.busy && (
        <>
          {cv.resume?.headline && <p className="small">{cv.resume.headline}</p>}
          <div className="tailor-actions">
            <a className="btn btn-primary btn-sm" href={cv.cv_url} target="_blank" rel="noopener noreferrer">
              View CV (PDF)
            </a>
            <a className="btn btn-sm" href={`${cv.cv_url}?download=1`}>
              Download
            </a>
          </div>
          {cv.dropped?.length > 0 && (
            <details className="small tailor-dropped">
              <summary>
                {cv.dropped.length} thing{cv.dropped.length === 1 ? '' : 's'} the AI wrote that your files don't back up, removed
              </summary>
              <ul>
                {cv.dropped.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="small muted">
            Made {formatDateTime(cv.created_at)}. {state.limit ? `${state.today ?? 0}/${state.limit} CVs made today.` : ''} Tailored versions for each job are on the job's page.
          </p>
        </>
      )}
    </section>
  );
}
