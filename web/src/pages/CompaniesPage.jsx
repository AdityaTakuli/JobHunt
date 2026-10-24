import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { brandOf } from '../brands.js';
import { RowsSkeleton } from '../components/Skeleton.jsx';
import { formatDate, formatDateTime, ROLE_LABELS } from '../format.js';
import { IconExternal } from '../icons.jsx';

// Global firms with India offices that take architecture interns and freshers. The ones marked
// "Checked daily" are read from their own careers feed every morning; for the rest, the button
// opens their careers site. Campus hiring at these firms mostly runs September to December.

// Three is enough to show what a firm is hiring for, and keeps the cards in a row the same
// height; the rest are a tap away in Jobs.
const ROLES_SHOWN = 3;

function RoleList({ company }) {
  if (!company.roles.length) {
    return <p className="small muted co-none">{company.tracked ? 'No open architecture roles in India right now.' : 'No roles seen yet. Check their careers site.'}</p>;
  }
  const roles = company.roles.slice(0, ROLES_SHOWN);
  const more = company.openRoles - roles.length;
  return (
    <ul className="co-roles">
      {roles.map((r) => (
        <li key={r.id}>
          <a href={r.apply_url} target="_blank" rel="noopener noreferrer">
            {r.title}
          </a>
          <span className="small muted">
            {[r.city, ROLE_LABELS[r.role_type], r.posted_at && formatDate(r.posted_at)].filter(Boolean).join(' · ')}
          </span>
        </li>
      ))}
      {more > 0 && (
        <li className="small muted co-more">
          and {more} more in <a href="#/jobs">Jobs</a>
        </li>
      )}
    </ul>
  );
}

// The firm's logo on a tile of its own colour; its monogram while the logo is missing or blocked.
function CompanyLogo({ brand }) {
  const [failed, setFailed] = useState(false);
  const showLogo = brand.logo && !failed;
  return (
    <span className={`co-logo${showLogo ? ' has-logo' : ''}`} aria-hidden="true">
      {showLogo ? (
        <img src={brand.logo} alt="" width="30" height="30" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        brand.monogram
      )}
    </span>
  );
}

function CompanyCard({ company }) {
  const brand = brandOf(company);
  return (
    <li className="card co-card" style={{ '--brand': brand.color }}>
      <div className="co-head">
        <CompanyLogo brand={brand} />
        <div className="grow">
          <h2>{company.name}</h2>
          <div className="small muted">{[company.kind, company.cities].filter(Boolean).join(' · ')}</div>
        </div>
        {company.openRoles > 0 && <span className="badge co-open">{company.openRoles} open</span>}
      </div>
      {company.note && <p className="co-note">{company.note}</p>}
      <RoleList company={company} />
      {/* Only the firms read from a feed say anything here: "not checked automatically" was a line
          of grey noise on every other card, and the Careers site button says it well enough. */}
      <div className="co-foot">
        {company.tracked && (
          <span className="small muted" title={company.lastError || undefined}>
            {company.lastError
              ? 'Feed failed at the last check. Retried tomorrow.'
              : company.lastCheckedAt
                ? `Checked daily · last ${formatDateTime(company.lastCheckedAt)}`
                : 'Checked daily · first check pending'}
          </span>
        )}
        <a className="btn btn-sm co-careers" href={company.careersUrl} target="_blank" rel="noopener noreferrer">
          Careers site <IconExternal size={14} />
        </a>
      </div>
    </li>
  );
}

export default function CompaniesPage() {
  const [companies, setCompanies] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api('/companies')
      .then((d) => setCompanies(d.companies))
      .catch((err) => setError(err.message));
  }, []);
  useEffect(load, [load]);

  const tracked = companies?.filter((c) => c.tracked).length || 0;
  return (
    <div>
      <div className="page-head">
        <h1>Companies</h1>
      </div>
      <p className="muted co-intro">
        Global firms with offices in India that hire architecture interns and freshers. {tracked ? `${tracked} are checked every morning and their roles show up in Jobs too. ` : ''}
        Campus hiring mostly runs September to December: look for “Graduate Architect”, “Architect Intern” or “BIM Trainee”.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!companies && !error && <RowsSkeleton rows={6} label="Loading companies" />}
      {companies && (
        <ul className="co-grid">
          {companies.map((c) => (
            <CompanyCard key={c.slug} company={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
