import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatDateTime } from '../format.js';
import { IconCheck, IconRefresh, IconSparkle } from '../icons.jsx';

// "Analyse with AI" in the job details: what the posting asks for, how well a B.Arch student
// fits, and what to lead with. Stored per job on the server, so the second person to open it
// gets it instantly. The keyword list above stays as the non-AI version of the same help.

const EASE = [0.22, 1, 0.36, 1];

// What the model is doing, in order, so the wait reads as work rather than a stall.
const STEPS = ['Reading the requirements', 'Checking what a B.Arch student can show', 'Picking what to lead with', 'Drafting a cover-note opening'];

const VERDICT_TONE = { 'good fit': 'is-good', stretch: 'is-stretch', 'long shot': 'is-far' };

// The fit score as an architect's scale bar: alternating blocks with ticks at 0, 25, 50, 75, 100.
function FitScale({ score, verdict }) {
  return (
    <figure className={`fit ${VERDICT_TONE[verdict] || ''}`}>
      <figcaption className="fit-head">
        <span className="fit-verdict">{verdict[0].toUpperCase() + verdict.slice(1)}</span>
        <span className="fit-score">{score}</span>
      </figcaption>
      <div className="fit-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={score} aria-label={`Fit ${score} out of 100`}>
        <span className="fit-blocks" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} />
          ))}
        </span>
        <motion.span className="fit-marker" aria-hidden="true" initial={{ left: '0%' }} animate={{ left: `${score}%` }} transition={{ duration: 0.6, ease: EASE }} />
      </div>
      <div className="fit-ticks" aria-hidden="true">
        <span>0</span>
        <span>25</span>
        <span>50</span>
        <span>75</span>
        <span>100</span>
      </div>
    </figure>
  );
}

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

function Result({ a, onRefresh, busy }) {
  return (
    <motion.div className="ai-result" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: EASE }}>
      <p className="ai-summary">{a.summary}</p>
      <FitScale score={a.fit_score} verdict={a.fit_verdict} />
      <p className="ai-reason">
        {a.fit_reason}
        {a.experience ? <span className="muted"> Asks for {a.experience}.</span> : null}
      </p>
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
          <p>Get a plain reading of this posting: what it really asks for, how well you fit, what to lead with in your CV and portfolio, and a cover-note opening.</p>
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
