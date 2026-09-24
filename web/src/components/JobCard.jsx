import { IconBookmark, IconBookmarkFilled, IconExternal, IconEyeOff } from '../icons.jsx';
import { STATUS_LABELS } from '../format.js';
import { JobBadges, postedLabel, Salary } from './JobBits.jsx';

export default function JobCard({ job, selected, onOpen, actions }) {
  const saved = Boolean(job.application_status);
  const saveLabel = !saved ? 'Save' : job.application_status === 'saved' ? 'Saved' : STATUS_LABELS[job.application_status];

  return (
    <li
      className={`card job-card${selected ? ' is-selected' : ''}`}
      onClick={(e) => {
        // Clicks on the card open details, but not clicks on its buttons and links.
        if (!e.target.closest('a, button')) onOpen(job);
      }}
    >
      <div className="job-card-top">
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 className="job-title">
            <button type="button" onClick={() => onOpen(job)}>
              {job.title}
            </button>
          </h2>
          <p className="job-sub">{[job.company, job.city || job.location_text].filter(Boolean).join(' · ')}</p>
        </div>
      </div>
      <div className="job-meta">
        <Salary job={job} />
        <span>{postedLabel(job)}</span>
      </div>
      <JobBadges job={job} />
      <div className="job-actions">
        <button
          type="button"
          className={`btn btn-sm${saved ? ' is-on' : ''}`}
          onClick={() => actions.toggleSave(job)}
          aria-pressed={saved}
          title={saved && job.application_status !== 'saved' ? 'Open tracker' : undefined}
        >
          {saved ? <IconBookmarkFilled size={16} /> : <IconBookmark size={16} />}
          {saveLabel}
        </button>
        <button type="button" className="icon-btn" onClick={() => actions.hide(job)} aria-label={`Hide ${job.title}`} title="Not relevant — hide">
          <IconEyeOff size={18} />
        </button>
        <span className="spacer" />
        <a
          className="btn btn-primary btn-sm"
          href={job.apply_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => actions.promptApplied(job)}
        >
          Apply <IconExternal size={16} />
        </a>
      </div>
    </li>
  );
}
