import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { APP_STATUSES, formatDateTime, ROLE_LABELS, STATUS_LABELS } from '../format.js';
import { IconBookmark, IconBookmarkFilled, IconExternal, IconX } from '../icons.jsx';
import { APPLY_KIND_LABELS, CompanyAvatar, experience, JobBadges, postedLabel, Salary } from './JobBits.jsx';
import { extractKeywords, highlightParts } from '../keywords.js';
import { DetailSkeleton } from './Skeleton.jsx';

const EASE = [0.22, 1, 0.36, 1];

const HIDE_REASONS = ['Not architecture/BIM', 'Too senior', 'Wrong city', 'Already applied elsewhere', 'Other'];
const COLLAPSE_AT = 480;

// Loads the full job (with description) and keeps its tracker status in sync with the list.
function useJobDetail(jobId, listJob) {
  const [job, setJob] = useState(listJob || null);
  const [error, setError] = useState('');
  const listRef = useRef(listJob);
  listRef.current = listJob;

  useEffect(() => {
    let alive = true;
    setError('');
    setJob(listRef.current || null); // show what the list already knows right away
    api(`/jobs/${jobId}`)
      .then(({ job: full }) => alive && setJob(full))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [jobId]);

  useEffect(() => {
    if (listJob) setJob((j) => (j ? { ...j, application_id: listJob.application_id, application_status: listJob.application_status } : listJob));
  }, [listJob]);

  return { job, error };
}

function applyLabel(job) {
  if (job.apply_kind === 'company') return 'Apply on company site';
  if (job.apply_kind === 'linkedin') return 'Apply on LinkedIn';
  const publisher = job.apply_options?.[0]?.publisher;
  return publisher && publisher !== 'Google Jobs' ? `Apply on ${publisher}` : 'Apply';
}

// Every place this role can be applied to, best first, and a way to find the firm's own
// careers page when Google did not list it.
function WhereToApply({ job, actions }) {
  const options = job.apply_options?.length ? job.apply_options : [{ url: job.apply_url, publisher: 'Apply link', kind: job.apply_kind || 'site' }];
  const hasCompany = options.some((o) => o.kind === 'company');
  const onlyReposts = options.every((o) => o.kind === 'aggregator' || o.kind === 'site');
  const careersSearch = `https://www.google.com/search?q=${encodeURIComponent(`${job.company} careers ${job.title}`)}`;
  return (
    <section className="detail-section">
      <h3>Where to apply</h3>
      <ul className="apply-list">
        {options.map((o, i) => (
          <li key={o.url}>
            <a href={o.url} target="_blank" rel="noopener noreferrer" onClick={() => actions.promptApplied(job)}>
              {o.publisher}
            </a>
            <span className={`apply-kind is-${o.kind}`}>{APPLY_KIND_LABELS[o.kind]}</span>
            {i === 0 && options.length > 1 && <span className="muted small">best option</span>}
          </li>
        ))}
      </ul>
      {!hasCompany && job.company && (
        <p className="apply-tip">
          {onlyReposts ? 'These sites repost listings from elsewhere. ' : ''}
          <a href={careersSearch} target="_blank" rel="noopener noreferrer">
            Look for it on {job.company}'s own careers page
          </a>{' '}
          to apply at the source.
        </p>
      )}
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        First seen {formatDateTime(job.created_at)} IST
      </p>
    </section>
  );
}

function Actions({ job, actions, className = '' }) {
  const saved = Boolean(job.application_status);
  return (
    <div className={`detail-actions ${className}`}>
      <a className="btn btn-primary" href={job.apply_url} target="_blank" rel="noopener noreferrer" onClick={() => actions.promptApplied(job)}>
        {applyLabel(job)} <IconExternal size={17} />
      </a>
      <button type="button" className={`btn${saved ? ' is-on' : ''}`} onClick={() => actions.toggleSave(job)} aria-pressed={saved}>
        {saved ? <IconBookmarkFilled size={17} /> : <IconBookmark size={17} />}
        {saved ? STATUS_LABELS[job.application_status] : 'Save'}
      </button>
    </div>
  );
}

// The tools, skills and requirements the posting mentions: what to put first on her CV and
// portfolio for this application. The same words are highlighted in the description.
function FocusKeywords({ keywords }) {
  if (!keywords.groups.length) return null;
  return (
    <section className="detail-section focus-keywords">
      <h3>Keywords to focus on</h3>
      <p className="focus-hint">Mention these in your CV, cover note and portfolio for this role.</p>
      <dl>
        {keywords.groups.map((g) => (
          <div key={g.name} className="kw-group">
            <dt>{g.name}</dt>
            <dd>
              {g.items.map((item) => (
                <span key={item} className="kw-chip">
                  {item}
                </span>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function Description({ text, pattern }) {
  return highlightParts(text, pattern).map((part, i) =>
    typeof part === 'string' ? (
      part
    ) : (
      <mark key={i} className="kw-mark">
        {part.mark}
      </mark>
    ),
  );
}

// Key facts in a small grid, like Glassdoor's job overview.
function Facts({ job }) {
  const exp = experience(job);
  const facts = [
    ['Experience', exp ? exp.label : 'Not stated'],
    ['Job type', job.role_type ? ROLE_LABELS[job.role_type] : 'Not stated'],
    ['Posted', postedLabel(job).replace(/^(Posted|Found) /, '')],
    ['Match', `${job.match_score}%`],
  ];
  return (
    <dl className="facts">
      {facts.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd className={k === 'Experience' && exp ? `is-${exp.tone}` : undefined}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Body({ job, actions, onHidden, headingId, actionsSlot }) {
  const [expanded, setExpanded] = useState(false);
  const saved = Boolean(job.application_status);
  const description = job.description || '';
  const long = description.length > COLLAPSE_AT;
  const keywords = useMemo(() => extractKeywords(`${job.title}\n${description}`, job.software || []), [job.title, description, job.software]);

  useEffect(() => setExpanded(false), [job.id]);

  return (
    <>
      <header className="detail-head">
        <CompanyAvatar name={job.company} size={48} />
        <div className="detail-head-text">
          <p className="detail-company">{job.company || 'Company not listed'}</p>
          <h2 id={headingId} className="detail-title">
            {job.title}
          </h2>
          <p className="detail-sub">
            {job.location_text || job.city || 'Location not listed'} · <Salary job={job} />
          </p>
        </div>
      </header>

      {actionsSlot}
      <Facts job={job} />
      {job.salary_estimate && !job.salary_text && (
        <p className="small muted" style={{ margin: 0 }}>
          Pay is a market estimate from {job.salary_estimate.samples} stipends/salaries posted for similar roles, not from this posting.
        </p>
      )}
      <JobBadges job={job} showSources={false} />

      <FocusKeywords keywords={keywords} />

      {job.classify_reason && (
        <section className="detail-section">
          <h3>Why it's here</h3>
          <p className="small" style={{ margin: 0 }}>
            {job.classify_reason}{' '}
            <span className="muted">({job.classifier === 'groq' || job.classifier === 'gemini' ? 'AI' : job.classifier === 'manual' ? 'you' : 'keyword rules'})</span>
          </p>
        </section>
      )}

      {description && (
        <section className="detail-section">
          <h3>Job description</h3>
          <div className={`description${long && !expanded ? ' is-collapsed' : ''}`} id={`desc-${job.id}`}>
            <Description text={description} pattern={keywords.pattern} />
          </div>
          {long && (
            <button
              type="button"
              className="btn btn-ghost btn-sm read-more"
              aria-expanded={expanded}
              aria-controls={`desc-${job.id}`}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Read more'}
            </button>
          )}
        </section>
      )}

      <WhereToApply job={job} actions={actions} />

      <section className="detail-section">
        <h3>Tracker</h3>
        {saved ? (
          <label className="field">
            <span className="visually-hidden">Application status</span>
            <select className="select" value={job.application_status} onChange={(e) => actions.setStatus(job, e.target.value)}>
              {APP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Not tracked yet. Save it, or mark it applied after you apply.
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
                onHidden?.();
              }}
            >
              {reason}
            </button>
          ))}
        </div>
      </section>
    </>
  );
}

// Desktop: details sit beside the list (Glassdoor's right-hand pane).
export function JobDetailPane({ jobId, listJob, actions }) {
  const { job, error } = useJobDetail(jobId, listJob);
  const scrollRef = useRef(null);
  useEffect(() => scrollRef.current?.scrollTo({ top: 0 }), [jobId]);

  return (
    <section className="detail-pane card" aria-labelledby="pane-title" ref={scrollRef}>
      {error && <p className="form-error">{error}</p>}
      {!job && !error && <DetailSkeleton />}
      {job && (
        <motion.div key={job.id} className="detail-pane-inner" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: EASE }}>
          <Body job={job} actions={actions} headingId="pane-title" actionsSlot={<Actions job={job} actions={actions} />} />
        </motion.div>
      )}
    </section>
  );
}

// Phones and tablets: details slide in over the list.
export default function JobDetail({ jobId, listJob, onClose, actions }) {
  const { job, error } = useJobDetail(jobId, listJob);
  const closeRef = useRef(null);

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

  // Portaled to <body>: page transitions transform <main>, which would otherwise break
  // position: fixed for the panel while they run.
  return createPortal(
    <>
      <motion.div className="overlay" onClick={onClose} aria-hidden="true" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }} />
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
          {job && <Body job={job} actions={actions} onHidden={onClose} headingId="job-detail-title" />}
        </div>

        {job && <Actions job={job} actions={actions} className="panel-foot" />}
      </motion.aside>
    </>,
    document.body,
  );
}
