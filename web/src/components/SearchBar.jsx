import { useState } from 'react';
import { IconLinkedIn, IconMapPin, IconSearch } from '../icons.jsx';

// Offered while typing "what", after her own recent searches.
const SUGGESTIONS = [
  'Architecture intern',
  'Junior architect',
  'BIM intern',
  'BIM modeler',
  'Revit architect',
  'Interior designer',
  'Architectural assistant',
  'Architectural visualiser',
  'Landscape architect',
  'Urban design intern',
  'AutoCAD draftsman',
  'Graduate architect',
];
const RECENT_KEY = 'aj-recent-searches';

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string').slice(0, 6) : [];
  } catch {
    return [];
  }
}

// "What" and "where", like Glassdoor's search. Submitting searches Google Jobs; the server tidies
// the words first (spelling, short forms, "architecture" added to a bare keyword).
// "Where" is shared with the location filter (the page keeps them in step).
// The LinkedIn switch narrows the list (feed or search results) to LinkedIn jobs.
export default function SearchBar({ cities, where, onWhereChange, busy, onSearch, linkedinOnly, onLinkedin }) {
  const [what, setWhat] = useState('');
  const [recent, setRecent] = useState(loadRecent);

  const ready = what.trim().length >= 2;
  const suggestions = [...new Map([...recent, ...SUGGESTIONS].map((s) => [s.toLowerCase(), s])).values()];

  function remember(q) {
    const next = [q, ...recent.filter((s) => s.toLowerCase() !== q.toLowerCase())].slice(0, 6);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // not kept in private mode
    }
  }

  return (
    <form
      className="searchbar"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        remember(what.trim());
        onSearch({ q: what.trim(), location: where.trim() });
      }}
    >
      <label className="sb-field sb-what">
        <IconSearch size={19} />
        <span className="visually-hidden">Job title, keyword or company</span>
        <input
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          placeholder="Role, skill or software: revit, BIM intern…"
          list="sb-what"
          enterKeyHint="search"
          maxLength={120}
        />
        <datalist id="sb-what">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </label>
      <span className="sb-divider" aria-hidden="true" />
      <label className="sb-field sb-where">
        <IconMapPin size={19} />
        <span className="visually-hidden">City</span>
        <input
          value={where}
          onChange={(e) => onWhereChange(e.target.value)}
          placeholder="City, or Remote"
          list="sb-cities"
          maxLength={80}
        />
        <datalist id="sb-cities">
          {[...new Set([...cities, 'Remote'])].map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </label>
      <button
        type="button"
        className={`sb-linkedin${linkedinOnly ? ' is-on' : ''}`}
        aria-pressed={linkedinOnly}
        onClick={onLinkedin}
        title={linkedinOnly ? 'Showing LinkedIn jobs only. Tap to show all.' : 'Show only LinkedIn jobs'}
      >
        <IconLinkedIn size={16} />
        LinkedIn only
      </button>
      <button type="submit" className="btn btn-primary sb-go" disabled={!ready || busy}>
        {busy ? 'Searching…' : 'Search'}
      </button>
    </form>
  );
}
