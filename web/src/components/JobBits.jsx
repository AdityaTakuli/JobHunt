import { formatRange, formatSalary, isNew, ROLE_LABELS, SOURCE_LABELS, timeAgo } from '../format.js';
import { IconAlert } from '../icons.jsx';

export function sourceLabels(sources = []) {
  const labels = sources.map((s) => (s.source === 'google_jobs' ? s.publisher || SOURCE_LABELS.google_jobs : SOURCE_LABELS[s.source] || s.source));
  return [...new Set(labels.filter(Boolean))];
}

export function Salary({ job }) {
  const posted = formatSalary(job);
  if (posted) return <span className="salary">{posted}</span>;
  const est = job.salary_estimate;
  if (est) {
    return (
      <span className="salary-est" title={`Market estimate from ${est.samples} posted stipends/salaries for similar roles`}>
        Est. {formatRange(est.min, est.max, est.period)}
      </span>
    );
  }
  return <span className="muted">Pay not listed</span>;
}

export function JobBadges({ job, showSources = true }) {
  const sources = showSources ? sourceLabels(job.sources).slice(0, 3) : [];
  return (
    <div className="badges">
      {isNew(job.created_at) && <span className="badge badge-new">New</span>}
      {job.role_type && <span className="badge">{ROLE_LABELS[job.role_type]}</span>}
      {job.is_bim && <span className="badge badge-accent">BIM</span>}
      {job.link_status === 'broken' && (
        <span className="badge badge-amber">
          <IconAlert size={14} /> Link may be expired
        </span>
      )}
      {sources.map((s) => (
        <span key={s} className="badge badge-outline">
          {s}
        </span>
      ))}
    </div>
  );
}

export function postedLabel(job) {
  return job.posted_at ? `Posted ${timeAgo(job.posted_at)}` : `Found ${timeAgo(job.created_at)}`;
}
