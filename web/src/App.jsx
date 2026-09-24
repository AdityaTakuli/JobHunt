import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { LoadingQuote } from './components/Skeleton.jsx';
import { IconBriefcase, IconBuilding, IconColumns, IconMonitor, IconMoon, IconSettings, IconSun } from './icons.jsx';
import FirmsPage from './pages/FirmsPage.jsx';
import JobsPage from './pages/JobsPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import TrackerPage from './pages/TrackerPage.jsx';

// GSAP and the drawings are only needed on these two screens, so they load on demand and the
// everyday job list stays light.
const LoginPage = lazy(() => import('./pages/LoginPage.jsx'));
const Welcome = lazy(() => import('./components/Welcome.jsx'));

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

// The welcome plays after every sign-in and on the first visit of each (IST) day.
const WELCOME_KEY = 'aj-welcomed-on';
const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

function welcomedToday() {
  try {
    return localStorage.getItem(WELCOME_KEY) === istToday();
  } catch {
    return true; // storage blocked: don't replay it on every load
  }
}

function markWelcomed() {
  try {
    localStorage.setItem(WELCOME_KEY, istToday());
  } catch {
    // private mode
  }
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

const BrandMark = () => (
  <span className="brand-mark" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 26 16 6l10 20M10.5 19h11" />
    </svg>
  </span>
);

const PAGE_EASE = [0.22, 1, 0.36, 1];

export default function App() {
  return (
    // Honour the OS "reduce motion" setting for every Motion animation in the app.
    <MotionConfig reducedMotion="user">
      <Shell />
    </MotionConfig>
  );
}

function Shell() {
  const [auth, setAuth] = useState('checking'); // checking | in | out
  const [meta, setMeta] = useState(null);
  const [welcome, setWelcome] = useState(false);
  const route = useRoute();
  const [theme, cycleTheme] = useTheme();

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api('/me')
      .then((me) => {
        setAuth(me.authenticated ? 'in' : 'out');
        if (me.authenticated && !welcomedToday()) setWelcome(true);
      })
      .catch(() => setAuth('out'));
  }, []);

  const closeWelcome = useCallback(() => {
    markWelcomed();
    setWelcome(false);
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

  const boot = (
    <div className="boot" aria-busy="true" aria-label="Loading">
      <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}>
        <BrandMark />
      </motion.span>
      <LoadingQuote after={600} />
    </div>
  );

  if (auth === 'checking') return boot;
  if (auth === 'out') {
    return (
      <Suspense fallback={boot}>
        <LoginPage
          onLogin={() => {
            setAuth('in');
            setWelcome(true);
          }}
        />
      </Suspense>
    );
  }

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
            <BrandMark />
            ArchJobs
          </a>
          <nav className="top-nav" aria-label="Main">
            {ROUTES.map(({ path, label, Icon }) => (
              <a key={path} href={`#/${path}`} aria-current={route.path === path ? 'page' : undefined}>
                {route.path === path && (
                  <motion.span layoutId="top-nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
                )}
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
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={route.path}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.28, ease: PAGE_EASE } }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.14, ease: 'easeIn' } }}
          >
            <Page />
          </motion.div>
        </AnimatePresence>
      </main>

      <nav className="bottom-nav" aria-label="Main">
        {ROUTES.map(({ path, label, Icon }) => (
          <a key={path} href={`#/${path}`} aria-current={route.path === path ? 'page' : undefined}>
            {route.path === path && (
              <motion.span layoutId="bottom-nav-pill" className="bottom-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
            )}
            <Icon size={22} />
            {label}
          </a>
        ))}
      </nav>

      <AnimatePresence>
        {welcome && (
          <Suspense key="welcome" fallback={null}>
            <Welcome name={meta?.displayName} meta={meta} onClose={closeWelcome} />
          </Suspense>
        )}
      </AnimatePresence>
    </MetaContext.Provider>
  );
}
