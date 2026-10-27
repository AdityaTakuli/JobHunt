import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { brandOf } from '../brands.js';
import { RowsSkeleton } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { formatDate, ROLE_LABELS, timeAgo } from '../format.js';
import { IconExternal, IconRefresh } from '../icons.jsx';

// Global firms with India offices that take architecture interns and freshers. The ones with a
// careers feed are read every morning, and on request with "Check now"; for the rest, the button
// opens their careers site. Firms that already have openings in the feed sit at the top, with
// those roles listed under the name.

const POLL_MS = 3000;

function RoleMeta({ role }) {
  const chips = [role.city, ROLE_LABELS[role.role_type], role.posted_at && formatDate(role.posted_at)].filter(Boolean);
  if (!chips.length) return null;
  return (
    <span className="co-role-meta">
      {chips.map((chip) => (
        <span className="co-chip" key={`${role.id}-${chip}`}>
          {chip}
        </span>
      ))}
    </span>
  );
}

function RoleList({ company }) {
  if (!company.roles?.length) return null;
  const more = company.openRoles - company.roles.length;
  return (
    <div className="co-open-roles">
      <p className="co-roles-label">Open roles</p>
      <ul className="co-roles">
        {company.roles.map((r) => (
          <li className="co-role" key={r.id}>
            <a href={r.apply_url} target="_blank" rel="noopener noreferrer">
              {r.title}
            </a>
            <RoleMeta role={r} />
          </li>
        ))}
        {more > 0 && (
          <li className="small muted co-more">
            and {more} more in <a href="#/jobs">Jobs</a>
          </li>
        )}
      </ul>
    </div>
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

// When the feed was last read and what it held. Errors say what happens next.
function FeedStatus({ company, checking }) {
  if (checking) return <span className="small muted co-status">Reading their careers feed…</span>;
  if (company.lastError) {
    return (
      <span className="small co-status is-error" title={company.lastError}>
        Feed did not answer at the last check. Try again, or open their careers site.
      </span>
    );
  }
  if (!company.lastCheckedAt) return <span className="small muted co-status">Not checked yet</span>;
  const found = company.lastFound ?? null;
  return (
    <span className="small muted co-status">
      Checked {timeAgo(company.lastCheckedAt)}
      {found != null ? ` · ${found} design role${found === 1 ? '' : 's'} in India` : ''}
      {company.lastNew ? ` · ${company.lastNew} new` : ''}
    </span>
  );
}

function CompanyCard({ company, checking, busy, onCheck }) {
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
      <RoleList company={company} />
      <div className="co-foot">
        {company.tracked && <FeedStatus company={company} checking={checking} />}
        {company.tracked && (
          <button type="button" className="btn btn-ghost btn-sm co-check" onClick={() => onCheck(company.slug)} disabled={checking || busy} aria-label={`Check ${company.name} now`}>
            <IconRefresh size={15} className={checking ? 'is-spinning' : undefined} />
            {checking ? 'Checking' : 'Check now'}
          </button>
        )}
        <a className="btn btn-sm co-careers" href={company.careersUrl} target="_blank" rel="noopener noreferrer">
          Careers site <IconExternal size={14} />
        </a>
      </div>
    </li>
  );
}

export default function CompaniesPage() {
  const { toast } = useToast();
  const [companies, setCompanies] = useState(null);
  const [checking, setChecking] = useState([]);
  const [error, setError] = useState('');
  const before = useRef(null); // open-role total when a check started, for the "done" toast

  const load = useCallback(
    () =>
      api('/companies')
        .then((d) => {
          setCompanies(d.companies);
          setChecking(d.checking || []);
          return d;
        })
        .catch((err) => setError(err.message)),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);

  // While a check runs on the server, refresh every few seconds; say what changed when it ends.
  useEffect(() => {
    if (!checking.length) return undefined;
    const t = setInterval(async () => {
      const d = await load();
      if (d && !d.checking?.length && before.current != null) {
        const total = d.companies.reduce((n, c) => n + c.openRoles, 0);
        const added = total - before.current;
        before.current = null;
        toast({ message: added > 0 ? `Check done: ${added} new role${added === 1 ? '' : 's'} added.` : 'Check done: no new roles since the last check.' });
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [checking.length, load, toast]);

  const check = async (slug) => {
    try {
      before.current = (companies || []).reduce((n, c) => n + c.openRoles, 0);
      const d = await api('/companies/check', { method: 'POST', body: slug ? { slug } : {} });
      if (d.fresh) {
        before.current = null;
        toast({ message: slug ? 'Checked a few minutes ago. Nothing to read again yet.' : 'Every feed was checked in the last few minutes.' });
      }
      setChecking(d.checking || []);
    } catch (err) {
      before.current = null;
      toast({ message: err.message, error: true });
    }
  };

  // Hiring first, then the rest in the same order the server sent.
  const listed = useMemo(() => {
    if (!companies) return null;
    return [...companies].sort((a, b) => b.openRoles - a.openRoles);
  }, [companies]);

  const tracked = companies?.filter((c) => c.tracked).length || 0;
  const busy = checking.length > 0;
  return (
    <div>
      <div className="page-head">
        <h1>Companies</h1>
        {tracked > 0 && (
          <button type="button" className="btn btn-sm" onClick={() => check(null)} disabled={busy}>
            <IconRefresh size={16} className={busy ? 'is-spinning' : undefined} />
            {busy ? `Checking ${checking.length} firm${checking.length === 1 ? '' : 's'}…` : 'Check all now'}
          </button>
        )}
      </div>
      <p className="muted co-intro">
        Global firms with offices in India that hire architecture interns and freshers. {tracked ? `${tracked} have a careers feed that is read every morning, or right away with Check now. Their roles show up in Jobs too. ` : ''}
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
            <CompanyCard key={c.slug} company={c} checking={checking.includes(c.slug)} busy={busy} onCheck={check} />
          ))}
        </ul>
      )}
    </div>
  );
}
