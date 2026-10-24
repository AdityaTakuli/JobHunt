import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { brandOf } from '../brands.js';
import { RowsSkeleton } from '../components/Skeleton.jsx';
import { formatDateTime } from '../format.js';
import { IconExternal } from '../icons.jsx';

// Global firms with India offices that take architecture interns and freshers. The ones marked
// "Checked daily" are read from their own careers feed every morning; for the rest, the button
// opens their careers site. Stored openings live on Jobs — this page only says how many each
// firm has, and puts those firms first.

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
        {company.openRoles > 0 && (
          <a className="badge co-open" href="#/jobs" title="See these roles on Jobs">
            {company.openRoles} open
          </a>
        )}
      </div>
      {company.note && <p className="co-note">{company.note}</p>}
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

  // Hiring first, then the rest in the same order the server sent.
  const listed = useMemo(() => {
    if (!companies) return null;
    return [...companies].sort((a, b) => b.openRoles - a.openRoles);
  }, [companies]);

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
      {!listed && !error && <RowsSkeleton rows={6} label="Loading companies" />}
      {listed && (
        <ul className="co-grid">
          {listed.map((c) => (
            <CompanyCard key={c.slug} company={c} />
          ))}
        </ul>
      )}
    </div>
  );
}
