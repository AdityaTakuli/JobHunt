import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, toQuery } from '../api.js';
import { useMeta } from '../App.jsx';
import JobCard from '../components/JobCard.jsx';
import JobDetail from '../components/JobDetail.jsx';
import { JobListSkeleton } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { SOFTWARE_FILTERS, SOURCE_LABELS } from '../format.js';
import { IconSearch } from '../icons.jsx';
import { quoteOfTheDay } from '../quotes.js';
import { useJobActions } from '../useJobActions.js';

// Only drawn in the empty state, so GSAP loads only if the feed is ever empty.
const Blueprint = lazy(() => import('../components/Blueprint.jsx'));

const PAGE = 30;
const STORAGE_KEY = 'aj-job-filters';
const DEFAULT_FILTERS = { q: '', city: 'mine', role: '', software: [], within: '', source: '', bim: false, hideApplied: false };

function loadFilters() {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

function FirmSuggestions() {
  const [firms, setFirms] = useState(null);
  const { toast } = useToast();

  useEffect(() => {
    api('/firms/suggestions')
      .then((d) => setFirms(d.firms))
      .catch(() => setFirms([]));
  }, []);

  if (!firms) return null;
  if (!firms.length) {
    return (
      <>
        <h2>No new roles right now</h2>
        <p>
          New roles arrive with the morning and evening search. Meanwhile, add studios you'd love to work at to your Firms list, and quiet days
          will suggest who to cold-email.
        </p>
        <a className="btn btn-sm" href="#/firms">
          Open Firms
        </a>
      </>
    );
  }
  return (
    <>
      <h2>
        No new roles today. Here {firms.length === 1 ? 'is 1 firm' : `are ${firms.length} firms`} to cold-email.
      </h2>
      <ul className="suggest-list">
        {firms.map((f) => (
          <li key={f.id}>
            <div className="grow">
              <div className="truncate" style={{ fontWeight: 600 }}>
                {f.website ? (
                  <a href={f.website} target="_blank" rel="noopener noreferrer">
                    {f.name}
                  </a>
                ) : (
                  f.name
                )}
              </div>
              <div className="small muted truncate">{[f.city, f.type, f.contact_email].filter(Boolean).join(' · ')}</div>
            </div>
            {f.contact_email && (
              <a className="btn btn-sm" href={`mailto:${f.contact_email}`}>
                Email
              </a>
            )}
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                try {
                  await api(`/firms/${f.id}/emailed`, { method: 'POST' });
                  setFirms((list) => list.filter((x) => x.id !== f.id));
                  toast({ message: `Marked ${f.name} as emailed.` });
                } catch (err) {
                  toast({ message: err.message, error: true });
                }
              }}
            >
              Mark emailed
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

// End of the feed: a quiet "all caught up" and the quote of the day.
function FeedEnd() {
  const quote = quoteOfTheDay();
  return (
    <motion.div className="feed-end" initial={{ opacity: 0 }} whileInView={{ opacity: 1 }} viewport={{ once: true }} transition={{ duration: 0.6 }}>
      <span className="feed-end-rule" aria-hidden="true" />
      <p>You're all caught up.</p>
      <p className="feed-end-quote">
        “{quote.text}”{quote.by && <span> — {quote.by}</span>}
      </p>
    </motion.div>
  );
}

export default function JobsPage() {
  const { meta } = useMeta();
  const [filters, setFilters] = useState(loadFilters);
  const q = useDebounced(filters.q, 300);
  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  // Bumped on every fresh (offset 0) load: the list remounts and its cards stagger in again.
  const [batch, setBatch] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // not persisted in private mode
    }
  }, [filters]);

  const params = useMemo(
    () => ({
      q,
      city: filters.city,
      role: filters.role,
      software: filters.software,
      within: filters.within,
      source: filters.source,
      bim: filters.bim,
      hideApplied: filters.hideApplied,
    }),
    [q, filters.city, filters.role, filters.software, filters.within, filters.source, filters.bim, filters.hideApplied],
  );

  const load = useCallback(
    async (offset = 0) => {
      const id = ++requestRef.current;
      if (offset === 0) setStatus((s) => (s === 'ready' ? 'ready' : 'loading'));
      else setLoadingMore(true);
      try {
        const data = await api(`/jobs${toQuery({ ...params, limit: PAGE, offset })}`);
        if (id !== requestRef.current) return;
        setJobs((list) => (offset === 0 ? data.jobs : [...list, ...data.jobs]));
        if (offset === 0) setBatch((b) => b + 1);
        setTotal(data.total);
        setStatus('ready');
        setError('');
      } catch (err) {
        if (id !== requestRef.current) return;
        setError(err.message);
        setStatus('error');
      } finally {
        if (id === requestRef.current) setLoadingMore(false);
      }
    },
    [params],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const reload = useCallback(() => load(0), [load]);

  const updateJob = useCallback((jobId, patch) => {
    setJobs((list) => {
      if (patch.hidden) return list.filter((j) => j.id !== jobId);
      return list.map((j) => (j.id === jobId ? { ...j, ...patch } : j));
    });
    if (patch.hidden) {
      setTotal((t) => Math.max(0, t - 1));
      setSelectedId((id) => (id === jobId ? null : id));
    }
  }, []);

  const baseActions = useJobActions(updateJob);
  const actions = useMemo(() => ({ ...baseActions, hide: (job, reason) => baseActions.hide(job, reason, reload) }), [baseActions, reload]);

  const set = (key, value) => setFilters((f) => ({ ...f, [key]: value }));
  const toggleSoftware = (name) =>
    setFilters((f) => ({ ...f, software: f.software.includes(name) ? f.software.filter((s) => s !== name) : [...f.software, name] }));

  // Her chosen cities first (even before they have jobs), then every other city in the feed.
  const cityOptions = useMemo(() => {
    const names = [...new Set([...(meta?.myCities || []), ...(meta?.cities || []).map((c) => c.city)])];
    if (filters.city && !['all', 'mine'].includes(filters.city) && !names.includes(filters.city)) names.unshift(filters.city);
    return names;
  }, [meta, filters.city]);

  const filtersActive =
    filters.q || filters.role || filters.software.length || filters.within || filters.source || filters.bim || filters.hideApplied;
  const closeDetail = useCallback(() => setSelectedId(null), []);
  const selectedJob = jobs.find((j) => j.id === selectedId);

  return (
    <div className="page-narrow">
      <h1 className="visually-hidden">Jobs</h1>
      <div className="filters">
        <label className="search">
          <span className="visually-hidden">Search roles or firms</span>
          <IconSearch size={18} />
          <input
            className="input"
            type="search"
            placeholder="Search roles or firms"
            value={filters.q}
            onChange={(e) => set('q', e.target.value)}
          />
        </label>
        <div className="filter-row" role="group" aria-label="Filters">
          <label>
            <span className="visually-hidden">City</span>
            <select className="select select-sm" value={filters.city} onChange={(e) => set('city', e.target.value)}>
              <option value="mine">My cities</option>
              <option value="all">All cities</option>
              {cityOptions.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="visually-hidden">Role type</span>
            <select className="select select-sm" value={filters.role} onChange={(e) => set('role', e.target.value)}>
              <option value="">Intern + fresher</option>
              <option value="internship">Internships</option>
              <option value="fresher">Fresher jobs</option>
              <option value="experienced">Experienced</option>
              <option value="all">All levels</option>
            </select>
          </label>
          <label>
            <span className="visually-hidden">Posted within</span>
            <select className="select select-sm" value={filters.within} onChange={(e) => set('within', e.target.value)}>
              <option value="">Any time</option>
              <option value="24">Last 24 hours</option>
              <option value="72">Last 3 days</option>
              <option value="168">Last 7 days</option>
              <option value="720">Last 30 days</option>
            </select>
          </label>
          <label>
            <span className="visually-hidden">Source</span>
            <select className="select select-sm" value={filters.source} onChange={(e) => set('source', e.target.value)}>
              <option value="">All sources</option>
              <option value="google_jobs">{SOURCE_LABELS.google_jobs}</option>
              <option value="linkedin_email">{SOURCE_LABELS.linkedin_email}</option>
            </select>
          </label>
          <button type="button" className={`btn btn-sm${filters.bim ? ' is-on' : ''}`} aria-pressed={filters.bim} onClick={() => set('bim', !filters.bim)}>
            BIM only
          </button>
          {SOFTWARE_FILTERS.map((name) => {
            const on = filters.software.includes(name);
            return (
              <button key={name} type="button" className={`btn btn-sm${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => toggleSoftware(name)}>
                {name}
              </button>
            );
          })}
          <button
            type="button"
            className={`btn btn-sm${filters.hideApplied ? ' is-on' : ''}`}
            aria-pressed={filters.hideApplied}
            onClick={() => set('hideApplied', !filters.hideApplied)}
          >
            Hide applied
          </button>
        </div>
      </div>

      {status === 'loading' && <JobListSkeleton count={4} />}

      {status === 'error' && (
        <div className="card empty" role="alert">
          <h2>Couldn't load jobs</h2>
          <p>{error}</p>
          <button type="button" className="btn" onClick={reload}>
            Try again
          </button>
        </div>
      )}

      {status === 'ready' && jobs.length === 0 && (
        <div className="card empty is-centered">
          <Suspense fallback={null}>
            <Blueprint className="empty-drawing" duration={1.4} />
          </Suspense>
          {filtersActive ? (
            <>
              <h2>No roles match these filters</h2>
              <p>Try a wider time range or another city.</p>
              <button type="button" className="btn" onClick={() => setFilters({ ...DEFAULT_FILTERS, city: filters.city })}>
                Clear filters
              </button>
            </>
          ) : (
            <FirmSuggestions />
          )}
        </div>
      )}

      {status === 'ready' && jobs.length > 0 && (
        <>
          <p className="result-line" aria-live="polite">
            <span>
              {total} role{total === 1 ? '' : 's'}
            </span>
          </p>
          <ul key={batch} className="job-list">
            <AnimatePresence mode="popLayout">
              {jobs.map((job, i) => (
                <JobCard
                  key={job.id}
                  job={job}
                  order={i % PAGE}
                  selected={job.id === selectedId}
                  onOpen={(j) => setSelectedId(j.id)}
                  actions={actions}
                />
              ))}
            </AnimatePresence>
          </ul>
          {jobs.length < total ? (
            <div className="load-more">
              <button type="button" className="btn" onClick={() => load(jobs.length)} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show more'}
              </button>
            </div>
          ) : (
            <FeedEnd />
          )}
        </>
      )}

      <AnimatePresence>
        {selectedId && <JobDetail key="detail" jobId={selectedId} listJob={selectedJob} onClose={closeDetail} actions={actions} />}
      </AnimatePresence>
    </div>
  );
}
