import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, toQuery } from '../api.js';
import { useMeta } from '../App.jsx';
import JobCard from '../components/JobCard.jsx';
import JobDetail, { JobDetailPane } from '../components/JobDetail.jsx';
import JobFilters from '../components/JobFilters.jsx';
import SearchBar from '../components/SearchBar.jsx';
import { JobListSkeleton } from '../components/Skeleton.jsx';
import { useToast } from '../components/Toast.jsx';
import { quoteOfTheDay } from '../quotes.js';
import { useJobActions } from '../useJobActions.js';

// Only drawn in the empty state, so GSAP loads only if the feed is ever empty.
const Blueprint = lazy(() => import('../components/Blueprint.jsx'));

const PAGE = 30;
const STORAGE_KEY = 'aj-job-filters-v2';
// Experience filter on by default at "up to 1 year": the point of the app is entry-level roles.
const DEFAULT_FILTERS = {
  city: 'mine',
  expOn: true,
  exp: 1,
  role: '',
  within: '',
  software: [],
  bim: false,
  source: '',
  apply: '',
  hideApplied: false,
  sort: 'recent',
};

function loadFilters() {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
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
  const { meta, refreshMeta } = useMeta();
  const { toast } = useToast();
  const [filters, setFilters] = useState(loadFilters);
  const [jobs, setJobs] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  // A live Google search: { q, location, ids, found, new, cached }. While set, the list shows
  // exactly those results (the other filters still apply).
  const [search, setSearch] = useState(null);
  const [searching, setSearching] = useState(false);
  // Bumped on every fresh (offset 0) load: the list remounts and its cards stagger in again.
  const [batch, setBatch] = useState(0);
  const requestRef = useRef(0);
  const desktop = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // not persisted in private mode
    }
  }, [filters]);

  const params = useMemo(
    () => ({
      ...(search ? { ids: search.ids.join(',') } : { city: filters.city }),
      exp: filters.expOn ? filters.exp : 'any',
      role: filters.role,
      software: filters.software,
      within: filters.within,
      source: filters.source,
      apply: filters.apply,
      bim: filters.bim,
      hideApplied: filters.hideApplied,
      sort: filters.sort,
    }),
    [search, filters],
  );

  const load = useCallback(
    async (offset = 0) => {
      const id = ++requestRef.current;
      if (search && !search.ids.length) {
        // Google found nothing: there is nothing to ask the server for.
        setJobs([]);
        setTotal(0);
        setStatus('ready');
        return;
      }
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
    [params, search],
  );

  useEffect(() => {
    load(0);
  }, [load]);

  const reload = useCallback(() => load(0), [load]);

  // New results are labelled by keyword rules first; the AI re-label runs right after on the
  // server, so refresh once it has had time to finish.
  useEffect(() => {
    if (!search?.new) return undefined;
    const t = setTimeout(reload, 30_000);
    return () => clearTimeout(t);
  }, [search, reload]);

  // Desktop shows details beside the list, so keep something selected there.
  useEffect(() => {
    if (desktop && jobs.length && !jobs.some((j) => j.id === selectedId)) setSelectedId(jobs[0].id);
  }, [desktop, jobs, selectedId]);

  async function runSearch({ q, location }) {
    setSearching(true);
    try {
      const result = await api('/search', { method: 'POST', body: { q, location } });
      setSelectedId(null);
      setSearch({ q, location, ...result });
      refreshMeta();
    } catch (err) {
      toast({ message: err.message, error: true, duration: 8000 });
    } finally {
      setSearching(false);
    }
  }

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

  // Her chosen cities first (even before they have jobs), then every other city in the feed.
  const cityOptions = useMemo(() => {
    const names = [...new Set([...(meta?.myCities || []), ...(meta?.cities || []).map((c) => c.city)])];
    if (filters.city && !['all', 'mine'].includes(filters.city) && !names.includes(filters.city)) names.unshift(filters.city);
    return names;
  }, [meta, filters.city]);

  const otherFilters = filters.role || filters.software.length || filters.within || filters.source || filters.apply || filters.bim || filters.hideApplied;
  const closeDetail = useCallback(() => setSelectedId(null), []);
  const selectedJob = jobs.find((j) => j.id === selectedId);
  const hiddenByFilters = search ? Math.max(0, search.ids.length - total) : 0;
  const showAllLevels = () => setFilters((f) => ({ ...f, expOn: false }));

  let list;
  if (searching) {
    list = <JobListSkeleton count={4} label="Searching Google Jobs" />;
  } else if (status === 'loading') {
    list = <JobListSkeleton count={4} />;
  } else if (status === 'error') {
    list = (
      <div className="card empty" role="alert">
        <h2>Couldn't load jobs</h2>
        <p>{error}</p>
        <button type="button" className="btn" onClick={reload}>
          Try again
        </button>
      </div>
    );
  } else if (jobs.length === 0) {
    list = (
      <div className="card empty is-centered">
        <Suspense fallback={null}>
          <Blueprint className="empty-drawing" duration={1.4} />
        </Suspense>
        {search ? (
          hiddenByFilters ? (
            <>
              <h2>
                All {hiddenByFilters} result{hiddenByFilters === 1 ? '' : 's'} are hidden by your filters
              </h2>
              <p>Google found roles for this search, but none match the experience level or other filters you picked.</p>
              <button type="button" className="btn btn-sm" onClick={showAllLevels}>
                Show all experience levels
              </button>
            </>
          ) : (
            <>
              <h2>Google Jobs found nothing for this search</h2>
              <p>Try a broader title (for example "architect" instead of "junior BIM architect"), or another city.</p>
            </>
          )
        ) : otherFilters ? (
          <>
            <h2>No roles match these filters</h2>
            <p>Try a wider time range, another job type, or fewer software filters.</p>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setFilters((f) => ({ ...DEFAULT_FILTERS, city: f.city, expOn: f.expOn, exp: f.exp, sort: f.sort }))}
            >
              Clear filters
            </button>
          </>
        ) : (
          <>
            <FirmSuggestions />
            {filters.expOn && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={showAllLevels}>
                Show all experience levels
              </button>
            )}
          </>
        )}
      </div>
    );
  } else {
    list = (
      <>
        <ul key={batch} className="job-list">
          <AnimatePresence mode="popLayout">
            {jobs.map((job, i) => (
              <JobCard key={job.id} job={job} order={i % PAGE} selected={job.id === selectedId} onOpen={(j) => setSelectedId(j.id)} actions={actions} />
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
          !search && <FeedEnd />
        )}
      </>
    );
  }

  return (
    <div className="jobs-page">
      <h1 className="visually-hidden">Jobs</h1>
      <SearchBar cities={meta?.myCities || []} busy={searching} onSearch={runSearch} />
      <p className="search-hint">
        {meta?.search?.configured === false
          ? 'Google search is not set up on the server yet.'
          : `Searches Google Jobs live${meta?.search ? ` · ${meta.search.leftToday} search${meta.search.leftToday === 1 ? '' : 'es'} left today` : ''}. The same search again within 6 hours is free.`}
      </p>

      <JobFilters filters={filters} setFilters={setFilters} cityOptions={cityOptions} searchMode={Boolean(search)} />

      <AnimatePresence initial={false}>
        {search && (
          <motion.div
            className="search-banner"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
          >
            <div className="search-banner-inner">
              <p>
                <strong>
                  {search.found} result{search.found === 1 ? '' : 's'}
                </strong>{' '}
                for “{search.q}”{search.location && <> in {search.location}</>}
                <span className="muted">
                  {' '}
                  · {search.cached ? 'saved from an earlier search today' : `from Google Jobs just now${search.new ? `, ${search.new} new` : ''}`}
                  {hiddenByFilters > 0 && jobs.length > 0 && ` · ${hiddenByFilters} hidden by your filters`}
                </span>
              </p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSearch(null)}>
                Back to your feed
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className={`jobs-layout${desktop ? ' is-split' : ''}`}>
        <div className="jobs-list-col">
          {!searching && status === 'ready' && jobs.length > 0 && (
            <div className="result-line">
              <span aria-live="polite">
                {total} role{total === 1 ? '' : 's'}
                {filters.expOn ? ' for your experience' : ''}
              </span>
              <label className="sort">
                <span className="visually-hidden">Sort by</span>
                <select className="select select-sm" value={filters.sort} onChange={(e) => setFilters((f) => ({ ...f, sort: e.target.value }))}>
                  <option value="recent">Most recent</option>
                  <option value="match">Best match</option>
                  <option value="direct">Direct apply first</option>
                </select>
              </label>
            </div>
          )}
          {list}
        </div>

        {desktop && (
          <div className="jobs-detail-col">
            {selectedId && jobs.length > 0 && !searching ? (
              <JobDetailPane jobId={selectedId} listJob={selectedJob} actions={actions} />
            ) : (
              <div className="detail-pane card detail-placeholder">
                <p>Pick a role to see the details here.</p>
              </div>
            )}
          </div>
        )}
      </div>

      {!desktop && (
        <AnimatePresence>
          {selectedId && <JobDetail key="detail" jobId={selectedId} listJob={selectedJob} onClose={closeDetail} actions={actions} />}
        </AnimatePresence>
      )}
    </div>
  );
}
