import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { APP_STATUSES, formatDateTime, STATUS_LABELS } from '../format.js';
import { IconBookmark, IconBookmarkFilled, IconExternal, IconX } from '../icons.jsx';
import { JobBadges, postedLabel, Salary, sourceLabels } from './JobBits.jsx';
import { DetailSkeleton } from './Skeleton.jsx';

const EASE = [0.22, 1, 0.36, 1];

const HIDE_REASONS = ['Not architecture/BIM', 'Too senior', 'Wrong city', 'Already applied elsewhere', 'Other'];
const COLLAPSE_AT = 480;

export default function JobDetail({ jobId, listJob, onClose, actions }) {
  const [job, setJob] = useState(listJob || null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(false);
  const closeRef = useRef(null);

  useEffect(() => {
    let alive = true;
    setExpanded(false);
    setError('');
    api(`/jobs/${jobId}`)
      .then(({ job: full }) => alive && setJob(full))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [jobId]);

  // Keep the panel in sync with save/apply changes made from here or the list.
  useEffect(() => {
    if (listJob) setJob((j) => (j ? { ...j, application_id: listJob.application_id, application_status: listJob.application_status } : listJob));
  }, [listJob]);

  useEffect(() => {
    const previous = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previous?.focus?.();
    };
  }, [onClose]);

  const saved = Boolean(job?.application_status);
  const description = job?.description || '';
  const long = description.length > COLLAPSE_AT;

  // Portaled to <body>: page transitions transform <main>, which would otherwise break
  // position: fixed for the panel while they run.
  return createPortal(
    <>
      <motion.div
        className="overlay"
        onClick={onClose}
        aria-hidden="true"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
      <motion.aside
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="job-detail-title"
        initial={{ x: 48, opacity: 0 }}
        animate={{ x: 0, opacity: 1, transition: { duration: 0.38, ease: EASE } }}
        exit={{ x: 48, opacity: 0, transition: { duration: 0.2, ease: 'easeIn' } }}
      >
        <div className="panel-head">
          <h2>Job details</h2>
          <button ref={closeRef} type="button" className="icon-btn" onClick={onClose} aria-label="Close details">
            <IconX />
          </button>
        </div>

        <div className="panel-body">
          {error && <p className="form-error">{error}</p>}
          {!job && !error && <DetailSkeleton />}
          {job && (
            <>
              <div>
                <h3 id="job-detail-title" className="detail-title">
                  {job.title}
                </h3>
                <p className="job-sub">{[job.company, job.location_text || job.city].filter(Boolean).join(' · ')}</p>
              </div>

              <div className="job-meta">
                <Salary job={job} />
                <span>{postedLabel(job)}</span>
              </div>
              {job.salary_estimate && !job.salary_text && (
                <p className="small muted" style={{ margin: 0 }}>
                  Market estimate: middle range of {job.salary_estimate.samples} stipends/salaries posted for similar roles. Not from this posting.
                </p>
              )}

              <JobBadges job={job} showSources={false} />

              {job.software?.length > 0 && (
                <section className="detail-section">
                  <h3>Software</h3>
                  <div className="badges">
                    {job.software.map((s) => (
                      <span key={s} className="badge">
                        {s}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {job.classify_reason && (
                <section className="detail-section">
                  <h3>Why it's here</h3>
                  <p className="small" style={{ margin: 0 }}>
                    {job.classify_reason}{' '}
                    <span className="muted">
                      ({job.classifier === 'groq' || job.classifier === 'gemini' ? 'AI' : job.classifier === 'manual' ? 'you' : 'keyword rules'} · match {job.match_score})
                    </span>
                  </p>
                </section>
              )}

              {description && (
                <section className="detail-section">
                  <h3>Description</h3>
                  <div className={`description${long && !expanded ? ' is-collapsed' : ''}`} id="job-description">
                    {description}
                  </div>
                  {long && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      style={{ marginTop: 6, paddingLeft: 0 }}
                      aria-expanded={expanded}
                      aria-controls="job-description"
                      onClick={() => setExpanded((v) => !v)}
                    >
                      {expanded ? 'Show less' : 'Read more'}
                    </button>
                  )}
                </section>
              )}

              {job.sources?.length > 0 && (
                <section className="detail-section">
                  <h3>Found on</h3>
                  <ul className="link-list">
                    {job.sources.map((s, i) => (
                      <li key={`${s.url}-${i}`}>
                        <a href={s.url} target="_blank" rel="noopener noreferrer" onClick={() => actions.promptApplied(job)}>
                          {sourceLabels([s])[0]}
                        </a>
                        {s.source === 'google_jobs' && <span className="muted small"> via Google Jobs</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="small muted" style={{ margin: '8px 0 0' }}>
                    First seen {formatDateTime(job.created_at)} IST
                  </p>
                </section>
              )}

              <section className="detail-section">
                <h3>Tracker</h3>
                {saved ? (
                  <label className="field">
                    <span className="visually-hidden">Application status</span>
                    <select
                      className="select"
                      value={job.application_status}
                      onChange={(e) => actions.setStatus(job, e.target.value)}
                    >
                      {APP_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABELS[s]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="small muted" style={{ margin: 0 }}>
                    Not tracked yet. Save it or mark it applied after you apply.
                  </p>
                )}
              </section>

              <section className="detail-section">
                <h3>Not relevant?</h3>
                <div className="reason-chips">
                  {HIDE_REASONS.map((reason) => (
                    <button
                      key={reason}
                      type="button"
                      className="btn btn-sm"
                      onClick={async () => {
                        await actions.hide(job, reason);
                        onClose();
                      }}
                    >
                      {reason}
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>

        {job && (
          <div className="panel-foot">
            <button type="button" className={`btn${saved ? ' is-on' : ''}`} onClick={() => actions.toggleSave(job)} aria-pressed={saved}>
              {saved ? <IconBookmarkFilled size={18} /> : <IconBookmark size={18} />}
              {saved ? STATUS_LABELS[job.application_status] : 'Save'}
            </button>
            <a className="btn btn-primary" href={job.apply_url} target="_blank" rel="noopener noreferrer" onClick={() => actions.promptApplied(job)}>
              Apply <IconExternal size={18} />
            </a>
          </div>
        )}
      </motion.aside>
    </>,
    document.body,
  );
}
