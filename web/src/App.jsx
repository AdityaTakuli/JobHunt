import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { IconBriefcase, IconBuilding, IconColumns, IconMonitor, IconMoon, IconSettings, IconSun } from './icons.jsx';
import FirmsPage from './pages/FirmsPage.jsx';
import JobsPage from './pages/JobsPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import TrackerPage from './pages/TrackerPage.jsx';

const ROUTES = [
  { path: 'jobs', label: 'Jobs', Icon: IconBriefcase, Page: JobsPage },
  { path: 'tracker', label: 'Tracker', Icon: IconColumns, Page: TrackerPage },
  { path: 'firms', label: 'Firms', Icon: IconBuilding, Page: FirmsPage },
  { path: 'settings', label: 'Settings', Icon: IconSettings, Page: SettingsPage },
];

const MetaContext = createContext({ meta: null, refreshMeta: () => {} });
export const useMeta = () => useContext(MetaContext);

function currentRoute() {
  const path = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  return ROUTES.find((r) => r.path === path) || ROUTES[0];
}

function useRoute() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const onHash = () => {
      setRoute(currentRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}

const THEMES = ['system', 'light', 'dark'];

function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('aj-theme') || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('aj-theme', theme);
    } catch {
      // private mode: theme just won't persist
    }
  }, [theme]);
  const cycle = () => setTheme((t) => THEMES[(THEMES.indexOf(t) + 1) % THEMES.length]);
  return [theme, cycle];
}

function Counter({ meta }) {
  if (!meta) return <div className="counter" />;
  return (
    <div className="counter" aria-live="polite">
      <strong>{meta.newToday}</strong> new<span className="long"> today</span>
      {' · '}
      <span className={meta.followUpsDue ? 'due' : undefined}>
        <strong>{meta.followUpsDue}</strong>
        <span className="long"> follow-up{meta.followUpsDue === 1 ? '' : 's'}</span> due
      </span>
    </div>
  );
}

export default function App() {
  const [auth, setAuth] = useState('checking'); // checking | in | out
  const [meta, setMeta] = useState(null);
  const route = useRoute();
  const [theme, cycleTheme] = useTheme();

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api('/me')
      .then((me) => setAuth(me.authenticated ? 'in' : 'out'))
      .catch(() => setAuth('out'));
  }, []);

  const refreshMeta = useCallback(() => {
    api('/jobs/meta')
      .then(setMeta)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (auth !== 'in') return undefined;
    refreshMeta();
    const id = setInterval(refreshMeta, 5 * 60_000);
    return () => clearInterval(id);
  }, [auth, refreshMeta]);

  useEffect(() => {
    document.title = `${route.label} · ArchJobs`;
  }, [route]);

  if (auth === 'checking') return <p className="center-note">Loading…</p>;
  if (auth === 'out') return <LoginPage onLogin={() => setAuth('in')} />;

  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconMonitor;
  const { Page } = route;

  return (
    <MetaContext.Provider value={{ meta, refreshMeta }}>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          // Keep the hash route intact; just move focus.
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="app-header">
        <div className="app-header-inner">
          <a className="brand" href="#/jobs">
            <span className="brand-mark" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 26 16 6l10 20M10.5 19h11" />
              </svg>
            </span>
            ArchJobs
          </a>
          <nav className="top-nav" aria-label="Main">
            {ROUTES.map(({ path, label, Icon }) => (
              <a key={path} href={`#/${path}`} aria-current={route.path === path ? 'page' : undefined}>
                <Icon size={18} />
                {label}
              </a>
            ))}
          </nav>
          <Counter meta={meta} />
          <button type="button" className="icon-btn" onClick={cycleTheme} aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`}>
            <ThemeIcon />
          </button>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <Page />
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {ROUTES.map(({ path, label, Icon }) => (
          <a key={path} href={`#/${path}`} aria-current={route.path === path ? 'page' : undefined}>
            <Icon size={22} />
            {label}
          </a>
        ))}
      </nav>
    </MetaContext.Provider>
  );
}
