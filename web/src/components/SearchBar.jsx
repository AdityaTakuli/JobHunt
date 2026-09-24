import { useEffect, useRef, useState } from 'react';
import { IconLinkedIn, IconMapPin, IconSearch } from '../icons.jsx';

// "What" and "where", like Glassdoor's search. Submitting runs that exact search on Google Jobs.
// The LinkedIn switch narrows the list (feed or search results) to LinkedIn jobs.
export default function SearchBar({ cities, busy, onSearch, linkedinOnly, onLinkedin }) {
  const [what, setWhat] = useState('');
  const [where, setWhere] = useState('');
  const touchedWhere = useRef(false);

  // Start with her first city once Settings has loaded, unless she already typed a place.
  useEffect(() => {
    if (!touchedWhere.current && cities.length) setWhere(cities[0]);
  }, [cities]);

  const ready = what.trim().length >= 2;

  return (
    <form
      className="searchbar"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready && !busy) onSearch({ q: what.trim(), location: where.trim() });
      }}
    >
      <label className="sb-field sb-what">
        <IconSearch size={19} />
        <span className="visually-hidden">Job title, keyword or company</span>
        <input value={what} onChange={(e) => setWhat(e.target.value)} placeholder="Job title, keyword or company" enterKeyHint="search" maxLength={120} />
      </label>
      <span className="sb-divider" aria-hidden="true" />
      <label className="sb-field sb-where">
        <IconMapPin size={19} />
        <span className="visually-hidden">City</span>
        <input
          value={where}
          onChange={(e) => {
            touchedWhere.current = true;
            setWhere(e.target.value);
          }}
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
