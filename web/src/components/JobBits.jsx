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

// Glassdoor-style age: "5h", "3d", "2mo".
export function shortAge(job) {
  return timeAgo(job.posted_at || job.created_at).replace(' ago', '');
}

// "Freshers welcome", "0–1 yrs", "2+ yrs" or null, with a tone for colouring:
// fresh (0-1 years), mid (2 years), senior (3+).
export function experience(job) {
  const { exp_min: min, exp_max: max, role_type: role } = job;
  if (min == null) return null;
  let label;
  if (min === 0 && (max === 0 || (max == null && (role === 'internship' || role === 'fresher')))) label = 'Freshers welcome';
  else if (max != null && max !== min) label = `${min}–${max} yrs`;
  else label = `${min}+ yrs`;
  return { label, tone: min <= 1 ? 'fresh' : min === 2 ? 'mid' : 'senior' };
}

export function ExperienceBadge({ job }) {
  const exp = experience(job);
  if (!exp) return null;
  return <span className={`badge badge-exp is-${exp.tone}`}>{exp.label}</span>;
}

// Initials on a colour picked from the company name, standing in for a logo.
export function CompanyAvatar({ name, size = 40 }) {
  const clean = String(name || '?').replace(/\b(pvt|ltd|llp|inc|private|limited)\b\.?/gi, '').trim() || '?';
  const initials = clean
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
  let hash = 0;
  for (const ch of clean.toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="avatar" style={{ '--h': hash, width: size, height: size, fontSize: size * 0.38 }} aria-hidden="true">
      {initials}
    </span>
  );
}
