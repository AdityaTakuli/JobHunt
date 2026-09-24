import { motion } from 'motion/react';
import { SOFTWARE_FILTERS, SOURCE_LABELS } from '../format.js';
import { IconMapPin, IconSparkle } from '../icons.jsx';
import { CheckList, FilterPill, OptionList } from './FilterPill.jsx';

export const EXPERIENCE_LEVELS = [
  { value: 0, label: 'Freshers only', short: 'Freshers' },
  { value: 1, label: 'Up to 1 year', short: '0–1 yr' },
  { value: 2, label: 'Up to 2 years', short: '0–2 yrs' },
  { value: 3, label: 'Up to 3 years', short: '0–3 yrs' },
  { value: 5, label: 'Up to 5 years', short: '0–5 yrs' },
];

const JOB_TYPES = [
  { value: '', label: 'Internships and jobs' },
  { value: 'internship', label: 'Internships' },
  { value: 'job', label: 'Full-time jobs' },
];

const POSTED = [
  { value: '', label: 'Any time' },
  { value: '24', label: 'Last 24 hours' },
  { value: '72', label: 'Last 3 days' },
  { value: '168', label: 'Last 7 days' },
  { value: '720', label: 'Last 30 days' },
];

const SOURCES = [
  { value: '', label: 'All sources' },
  { value: 'google_jobs', label: SOURCE_LABELS.google_jobs },
  { value: 'linkedin_email', label: SOURCE_LABELS.linkedin_email },
];

const APPLY_ON = [
  { value: '', label: 'Any site', short: 'Apply on' },
  { value: 'trusted', label: 'Company sites, LinkedIn & job boards', short: 'Trusted sites' },
  { value: 'direct', label: 'Company sites & LinkedIn', short: 'Company & LinkedIn' },
  { value: 'company', label: 'Company sites only', short: 'Company sites' },
];

const labelOf = (list, value) => list.find((o) => o.value === value)?.label;

// Split pill: the switch turns the experience filter on or off in one tap; the rest opens the
// levels. Off keeps the chosen level, so switching back on restores it.
function ExperiencePill({ on, level, onToggle, onLevel }) {
  const current = EXPERIENCE_LEVELS.find((l) => l.value === level) || EXPERIENCE_LEVELS[1];
  return (
    <div className={`exp-pill${on ? ' is-on' : ''}`}>
      <button type="button" role="switch" aria-checked={on} className="exp-switch" onClick={onToggle} title={on ? 'Showing roles for your experience. Tap to show all levels.' : 'Tap to show only roles for your experience.'}>
        <span className="exp-track" aria-hidden="true">
          <motion.span className="exp-thumb" layout transition={{ type: 'spring', stiffness: 700, damping: 40 }} />
        </span>
        <IconSparkle size={15} />
        <span className="exp-label">Fresher-friendly</span>
      </button>
      <FilterPill label={on ? current.short : 'Any level'} active={on} panelLabel="Experience level">
        {(close) => (
          <div className="exp-panel">
            <p className="panel-title">How much experience do you have?</p>
            <OptionList
              label="Experience level"
              options={EXPERIENCE_LEVELS}
              value={on ? level : null}
              onChange={(v) => onLevel(v)}
              onDone={close}
            />
            <p className="panel-note">Roles that don't mention years count when they are internships or fresher roles.</p>
          </div>
        )}
      </FilterPill>
    </div>
  );
}

export default function JobFilters({ filters, setFilters, cityOptions, searchMode }) {
  const set = (key) => (value) => setFilters((f) => ({ ...f, [key]: value }));
  const toggleSoftware = (name) =>
    setFilters((f) => ({ ...f, software: f.software.includes(name) ? f.software.filter((s) => s !== name) : [...f.software, name] }));

  const cityLabel = filters.city === 'mine' ? 'My cities' : filters.city === 'all' ? 'All cities' : filters.city;
  const softwareCount = filters.software.length + (filters.bim ? 1 : 0);
  const anyActive =
    filters.role || filters.within || softwareCount || filters.source || filters.apply || filters.hideApplied || (!searchMode && filters.city !== 'mine');

  return (
    <div className="filter-bar" role="group" aria-label="Filters">
      <ExperiencePill
        on={filters.expOn}
        level={filters.exp}
        onToggle={() => setFilters((f) => ({ ...f, expOn: !f.expOn }))}
        onLevel={(v) => setFilters((f) => ({ ...f, exp: v, expOn: true }))}
      />

      {!searchMode && (
        <FilterPill
          label={
            <>
              <IconMapPin size={15} /> {cityLabel}
            </>
          }
          active={filters.city !== 'mine'}
          panelLabel="Location"
        >
          {(close) => (
            <OptionList
              label="Location"
              options={[{ value: 'mine', label: 'My cities' }, { value: 'all', label: 'All cities' }, ...cityOptions.map((c) => ({ value: c, label: c }))]}
              value={filters.city}
              onChange={set('city')}
              onDone={close}
            />
          )}
        </FilterPill>
      )}

      <FilterPill label={APPLY_ON.find((o) => o.value === filters.apply)?.short || 'Apply on'} active={Boolean(filters.apply)} panelLabel="Apply on">
        {(close) => (
          <div>
            <p className="panel-title">Where can you apply?</p>
            <OptionList label="Apply on" options={APPLY_ON} value={filters.apply} onChange={set('apply')} onDone={close} />
            <p className="panel-note">Company sites include their official hiring pages. Reposting sites copy listings from elsewhere and are left out of every option except "Any site".</p>
          </div>
        )}
      </FilterPill>

      <FilterPill label={filters.role ? labelOf(JOB_TYPES, filters.role) : 'Job type'} active={Boolean(filters.role)} panelLabel="Job type">
        {(close) => <OptionList label="Job type" options={JOB_TYPES} value={filters.role} onChange={set('role')} onDone={close} />}
      </FilterPill>

      <FilterPill label={filters.within ? labelOf(POSTED, filters.within) : 'Date posted'} active={Boolean(filters.within)} panelLabel="Date posted">
        {(close) => <OptionList label="Date posted" options={POSTED} value={filters.within} onChange={set('within')} onDone={close} />}
      </FilterPill>

      <FilterPill label={softwareCount ? `Software · ${softwareCount}` : 'Software'} active={softwareCount > 0} panelLabel="Software">
        <CheckList label="Software" options={SOFTWARE_FILTERS.map((s) => ({ value: s, label: s }))} values={filters.software} onToggle={toggleSoftware} />
        <div className="panel-divider" />
        <CheckList label="BIM" options={[{ value: 'bim', label: 'BIM roles only' }]} values={filters.bim ? ['bim'] : []} onToggle={() => set('bim')(!filters.bim)} />
      </FilterPill>

      <FilterPill label={filters.source ? labelOf(SOURCES, filters.source) : 'Source'} active={Boolean(filters.source)} panelLabel="Source">
        {(close) => <OptionList label="Source" options={SOURCES} value={filters.source} onChange={set('source')} onDone={close} />}
      </FilterPill>

      <button type="button" className={`pill${filters.hideApplied ? ' is-active' : ''}`} aria-pressed={filters.hideApplied} onClick={() => set('hideApplied')(!filters.hideApplied)}>
        Hide applied
      </button>

      {anyActive && (
        <button
          type="button"
          className="btn btn-ghost btn-sm clear-filters"
          onClick={() => setFilters((f) => ({ ...f, city: 'mine', role: '', within: '', software: [], bim: false, source: '', apply: '', hideApplied: false }))}
        >
          Clear
        </button>
      )}
    </div>
  );
}
