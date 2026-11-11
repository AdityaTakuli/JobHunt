import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDateTime } from '../format.js';
import { IconCheck, IconRefresh, IconSparkle } from '../icons.jsx';

// Job details: a one-page CV and a cover letter tailored to this posting, made from her own CV
// (server lib/tailor.js). Shows the keyword match before and after, what the posting asks for
// that she doesn't have (left out, never invented), and what the checks removed.

function letterText(letter) {
  return letter ? [letter.greeting, ...letter.paragraphs, letter.sign_off].join('\n\n') : '';
}

export default function TailorSection({ jobId }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    api(`/tailor?jobId=${jobId}`)
      .then((d) => alive && setState({ tailored: d.tailored, available: d.available, today: d.today, limit: d.limit }))
      .catch(() => alive && setState({ available: false }));
    return () => {
      alive = false;
    };
  }, [jobId]);

  const make = async (refresh = false) => {
    setState((s) => ({ ...s, busy: true, error: '' }));
    try {
      const d = await api('/tailor', { method: 'POST', body: { jobId, refresh } });
      setState((s) => ({ ...s, busy: false, tailored: d.tailored, today: d.reused ? s.today : (s.today || 0) + 1 }));
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err.message }));
    }
  };

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(letterText(state.tailored?.cover_letter));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard blocked: the letter is open in the PDF too
    }
  };

  if (state.loading || (!state.available && !state.tailored)) return null;
  const t = state.tailored;
  const m = t?.match;

  return (
    <section className="detail-section tailor-section" aria-labelledby={`tailor-${jobId}`}>
      <h3 id={`tailor-${jobId}`}>
        <IconSparkle size={15} /> CV and cover letter for this job
      </h3>
      {!t && !state.busy && (
        <div className="ai-start">
          <p>
            A one-page CV reordered and reworded for this posting, and a cover letter that names the firm and your real projects. Made only from your CV: nothing is added that you
            don't have.
          </p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => make(false)}>
            <IconSparkle size={16} /> Tailor my CV
          </button>
        </div>
      )}
      {state.busy && (
        <div className="ai-working" role="status" aria-live="polite">
          <span className="ai-pulse" aria-hidden="true" /> Tailoring your CV and writing the letter…
        </div>
      )}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {t && !state.busy && (
        <div className="tailor-result">
          {m?.before != null && (
            <p className="tailor-match">
              Keywords from the posting on your CV: <strong>{m.before}%</strong> → <strong>{m.after}%</strong>
              {m.shown?.length > 0 && <span className="small muted"> ({m.shown.join(', ')})</span>}
            </p>
          )}
          {m?.missing?.length > 0 && (
            <p className="small">
              <strong>Asked for, not on your CV:</strong> {m.missing.join(', ')}. Left out rather than claimed; see "Your fit" for how to cover them.
            </p>
          )}
          {t.resume?.summary && <p className="small muted tailor-summary">“{t.resume.summary}”</p>}
          <div className="tailor-actions">
            <a className="btn btn-primary btn-sm" href={t.cv_url} target="_blank" rel="noopener noreferrer">
              View CV (PDF)
            </a>
            {t.letter_url && (
              <a className="btn btn-sm" href={t.letter_url} target="_blank" rel="noopener noreferrer">
                View cover letter
              </a>
            )}
            {t.cover_letter && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
                {copied ? <IconCheck size={15} /> : null}
                {copied ? 'Copied' : 'Copy letter text'}
              </button>
            )}
          </div>
          {t.dropped?.length > 0 && (
            <details className="small tailor-dropped">
              <summary>
                {t.dropped.length} thing{t.dropped.length === 1 ? '' : 's'} the AI wrote that your CV doesn't back up, removed
              </summary>
              <ul>
                {t.dropped.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </details>
          )}
          <footer className="ai-foot">
            <span className="small muted">
              Made {formatDateTime(t.created_at)} from your CV. ARCH in Chrome attaches this CV when you apply. {state.limit ? `${state.today ?? 0}/${state.limit} today.` : ''}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => make(true)}>
              <IconRefresh size={15} /> Make again
            </button>
          </footer>
        </div>
      )}
    </section>
  );
}
