import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDateTime } from '../format.js';
import { IconCheck, IconRefresh, IconSparkle } from '../icons.jsx';

// "Analyse with AI" in the job details: what this posting asks for and what to lead with at this
// firm, written from the posting itself (the server reads it from the job page when needed). It has
// no score of its own: "Your fit" above is the one score. Stored per job on the server, so the
// second person to open it gets it instantly.

const EASE = [0.22, 1, 0.36, 1];

// What the model is doing, in order, so the wait reads as work rather than a stall.
const STEPS = ['Reading the posting from the job page', 'Pulling out what this firm asks for', 'Matching it to what to lead with', 'Drafting a cover-note opening'];

function List({ title, items, tone }) {
  if (!items?.length) return null;
  return (
    <div className={`ai-list${tone ? ` ${tone}` : ''}`}>
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function CoverNote({ text }) {
  const [copied, setCopied] = useState(false);
  if (!text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked: the text is on screen to select by hand.
    }
  };
  return (
    <div className="ai-cover">
      <div className="ai-cover-head">
        <h4>Cover-note opening</h4>
        <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>
          {copied ? <IconCheck size={15} /> : null}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <blockquote>{text}</blockquote>
      <p className="small muted">A starting point: change it to sound like you and add one real project.</p>
    </div>
  );
}

// What the analysis was written from, so a thin one is never mistaken for a full one.
function Basis({ basedOn }) {
  if (!basedOn) return null;
  if (basedOn.posting) {
    return <p className="small muted ai-basis">Written from the posting{basedOn.host ? ` on ${basedOn.host}` : ''}{basedOn.firm ? ' and what is known about the firm' : ''}.</p>;
  }
  return (
    <p className="ai-basis is-thin" role="note">
      The job site would not let ArchJobs read this posting, so this is based on the title{basedOn.firm ? ' and the firm' : ''} only. Open the posting for the real requirements.
    </p>
  );
}

function Result({ a, onRefresh, busy }) {
  return (
    <motion.div className="ai-result" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}>
      <Basis basedOn={a.based_on} />
      <p className="ai-summary">{a.summary}</p>
      {a.company && (
        <p className="ai-reason">
          <strong>The firm:</strong> {a.company}
        </p>
      )}
      {a.experience && <p className="ai-reason muted">Asks for {a.experience}.</p>}
      {a.red_flags?.length > 0 && <List title="Watch out" items={a.red_flags} tone="is-warn" />}
      <div className="ai-columns">
        <List title="Must have" items={a.must_have} />
        <List title="Nice to have" items={a.nice_to_have} />
      </div>
      <List title="Lead with" items={a.highlight} />
      <List title="Show in your portfolio" items={a.portfolio} />
      <List title="Gaps and how to cover them" items={a.gaps} />
      <CoverNote text={a.cover_note} />
      <List title="Prepare for the interview" items={a.interview} />
      <footer className="ai-foot">
        <span className="small muted">
          Written by AI ({a.model} via {a.gateway}) {a.created_at ? `on ${formatDateTime(a.created_at)}` : ''}. It can get details wrong: check the posting before you rely on it.
        </span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={busy}>
          <IconRefresh size={15} /> Analyse again
        </button>
      </footer>
    </motion.div>
  );
}

function Working() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 3500);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="ai-working" role="status" aria-live="polite">
      <span className="ai-pulse" aria-hidden="true" />
      <AnimatePresence mode="wait">
        <motion.span key={step} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}>
          {STEPS[step]}…
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export default function JobAnalysis({ jobId }) {
  const [state, setState] = useState({ loading: true });

  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    api(`/jobs/${jobId}/analysis`)
      .then((d) => alive && setState({ analysis: d.analysis, available: d.available }))
      .catch(() => alive && setState({ available: false }));
    return () => {
      alive = false;
    };
  }, [jobId]);

  const run = async (refresh = false) => {
    setState((s) => ({ ...s, busy: true, error: '' }));
    try {
      const d = await api(`/jobs/${jobId}/analysis`, { method: 'POST', body: { refresh } });
      setState((s) => ({ ...s, busy: false, analysis: d.analysis }));
    } catch (err) {
      setState((s) => ({ ...s, busy: false, error: err.message }));
    }
  };

  if (state.loading || (!state.available && !state.analysis)) return null;

  return (
    <section className="detail-section ai-analysis" aria-labelledby={`ai-${jobId}`}>
      <h3 id={`ai-${jobId}`}>
        <IconSparkle size={15} /> AI analysis
      </h3>
      {!state.analysis && !state.busy && (
        <div className="ai-start">
          <p>Read this posting and firm with AI: what they really ask for, what to lead with in your CV and portfolio for them, and a cover-note opening. Your fit score is above.</p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => run(false)}>
            <IconSparkle size={16} /> Analyse this job
          </button>
        </div>
      )}
      {state.busy && <Working />}
      {state.error && (
        <p className="form-error" role="alert">
          {state.error}
        </p>
      )}
      {state.analysis && !state.busy && <Result a={state.analysis} busy={state.busy} onRefresh={() => run(true)} />}
    </section>
  );
}
