import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Logo, { LogoMark } from './components/Logo.jsx';
import { LoadingQuote } from './components/Skeleton.jsx';
import { IconBriefcase, IconBuilding, IconColumns, IconFileUser, IconGlobe, IconMonitor, IconMoon, IconSettings, IconSun } from './icons.jsx';
import CompaniesPage from './pages/CompaniesPage.jsx';
import FirmsPage from './pages/FirmsPage.jsx';
import JobsPage from './pages/JobsPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import TrackerPage from './pages/TrackerPage.jsx';

// GSAP and the drawings are only needed on these screens, so they load on demand and the
// everyday job list stays light.
const HomePage = lazy(() => import('./pages/HomePage.jsx'));
const LoginPage = lazy(() => import('./pages/LoginPage.jsx'));
const Welcome = lazy(() => import('./components/Welcome.jsx'));

const ROUTES = [
  { path: 'jobs', label: 'Jobs', Icon: IconBriefcase, Page: JobsPage },
  { path: 'tracker', label: 'Tracker', Icon: IconColumns, Page: TrackerPage },
  { path: 'profile', label: 'Profile', Icon: IconFileUser, Page: ProfilePage },
  // Both firm pages are one place in the menus ("Companies", the MNC tracker first), with a
  // switch at the top of each to her own firm list.
  { path: 'companies', label: 'Companies', Icon: IconGlobe, Page: CompaniesPage, also: ['firms'] },
  { path: 'firms', label: 'Firms', Icon: IconBuilding, Page: FirmsPage, nav: false },
  { path: 'settings', label: 'Settings', Icon: IconSettings, Page: SettingsPage },
];

const MetaContext = createContext({ meta: null, refreshMeta: () => {}, me: null, refreshMe: () => {} });
export const useMeta = () => useContext(MetaContext);

const APP_PATHS = new Set(ROUTES.map((r) => r.path));
const NAV = ROUTES.filter((r) => r.nav !== false);
const isCurrent = (item, path) => item.path === path || Boolean(item.also?.includes(path));

// The hash without its leading "#/" and query: 'jobs', 'signin', or '' for the front page.
const hashPath = () => window.location.hash.replace(/^#\/?/, '').split('?')[0];

function useHashPath() {
  const [path, setPath] = useState(hashPath);
  useEffect(() => {
    const onHash = () => {
      setPath(hashPath());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return path;
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

const PAGE_EASE = [0.22, 1, 0.36, 1];

export default function App() {
  return (
    // Honour the OS "reduce motion" setting for every Motion animation in the app.
    <MotionConfig reducedMotion="user">
      <Shell />
    </MotionConfig>
  );
}

// Their photo from Google, else their initial. Opens their account in Settings.
function AccountButton({ me }) {
  const [broken, setBroken] = useState(false);
  if (!me) return null;
  const label = me.name || me.email || 'Your account';
  return (
    <a className="account-btn" href="#/settings?tab=account" title={`${label} · Account`} aria-label={`${label}: account`}>
      {me.picture && !broken ? (
        <img src={me.picture} alt="" referrerPolicy="no-referrer" onError={() => setBroken(true)} />
      ) : (
        <span aria-hidden="true">{label.trim()[0]?.toUpperCase()}</span>
      )}
    </a>
  );
}

function Shell() {
  const [auth, setAuth] = useState('checking'); // checking | in | out
  const [login, setLogin] = useState({ google: false, passwordLogin: true });
  const [me, setMe] = useState(null);
  const [meta, setMeta] = useState(null);
  const [welcome, setWelcome] = useState(false);
  const path = useHashPath();
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];
  const [theme, cycleTheme] = useTheme();
  // Google sent her back without signing in: read once, so clearing the address bar later cannot
  // swap the sign-in card (which shows the reason) for the front page.
  const [authError] = useState(() => new URLSearchParams(window.location.search).has('auth_error'));

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    api('/me')
      .then((res) => {
        setLogin({ google: res.google, passwordLogin: res.passwordLogin });
        setMe(res.user);
        setAuth(res.authenticated ? 'in' : 'out');
        if (res.authenticated && !welcomedToday()) setWelcome(true);
      })
      .catch(() => setAuth('out'));
  }, []);

  const refreshMe = useCallback(() => {
    api('/me')
      .then((res) => setMe(res.user))
      .catch(() => {});
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
    document.title = auth === 'in' ? `${route.label} · ArchJobs` : 'ArchJobs · Architecture, Interiors & BIM Internships and Fresher Jobs in India';
  }, [route, auth]);

  const boot = (
    <div className="boot" aria-busy="true" aria-label="Loading">
      <motion.span initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.4 }}>
        <LogoMark width={72} />
      </motion.span>
      <LoadingQuote after={600} />
    </div>
  );

  if (auth === 'checking') return boot;
  if (auth === 'out') {
    // The front page is public: it is all anyone (including Google's app review) sees at "/", and
    // it explains the app and its Gmail access without a sign-in wall. Asking for the sign-in card,
    // following a bookmarked app link, or coming back from Google with an error goes to the form.
    const wantsSignIn = path === 'signin' || APP_PATHS.has(path) || authError;
    return (
      <ErrorBoundary>
        <Suspense fallback={boot}>
          {wantsSignIn ? (
            <LoginPage
              google={login.google}
              passwordLogin={login.passwordLogin}
              onLogin={() => {
                window.location.hash = '#/jobs';
                setAuth('in');
                setWelcome(true);
                refreshMe();
              }}
            />
          ) : (
            <HomePage google={login.google} theme={theme} onCycleTheme={cycleTheme} />
          )}
        </Suspense>
      </ErrorBoundary>
    );
  }

  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconMonitor;
  const { Page } = route;

  return (
    <MetaContext.Provider value={{ meta, refreshMeta, me, refreshMe }}>
      {/* While the welcome screen is up, everything behind it is inert: Tab and screen readers stay
          in the welcome dialog instead of reaching controls it covers. */}
      <a
        className="skip-link"
        inert={welcome || undefined}
        href="#main"
        onClick={(e) => {
          // Keep the hash route intact; just move focus.
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="app-header" inert={welcome || undefined}>
        <div className="app-header-inner">
          <a className="brand" href="#/jobs" aria-label="ArchJobs home">
            <Logo width={46} />
          </a>
          <nav className="top-nav" aria-label="Main">
            {NAV.map((item) => {
              const { path, label, Icon } = item;
              const current = isCurrent(item, route.path);
              return (
              <a key={path} href={`#/${path}`} aria-current={current ? 'page' : undefined}>
                {current && (
                  <motion.span layoutId="top-nav-pill" className="nav-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
                )}
                <Icon size={18} />
                {label}
              </a>
              );
            })}
          </nav>
          <Counter meta={meta} />
          <AccountButton me={me} />
          <button type="button" className="icon-btn" onClick={cycleTheme} aria-label={`Theme: ${theme}. Change theme`} title={`Theme: ${theme}`}>
            <ThemeIcon />
          </button>
        </div>
      </header>

      <main id="main" tabIndex={-1} inert={welcome || undefined}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={route.path}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0, transition: { duration: 0.28, ease: PAGE_EASE } }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.14, ease: 'easeIn' } }}
          >
            <ErrorBoundary key={route.path}>
              <Page />
            </ErrorBoundary>
          </motion.div>
        </AnimatePresence>
      </main>

      <nav className="bottom-nav" aria-label="Main" inert={welcome || undefined}>
        {NAV.map((item) => {
          const { path, label, Icon } = item;
          const current = isCurrent(item, route.path);
          return (
          <a key={path} href={`#/${path}`} aria-current={current ? 'page' : undefined}>
            {current && (
              <motion.span layoutId="bottom-nav-pill" className="bottom-pill" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
            )}
            <Icon size={22} />
            {label}
          </a>
          );
        })}
      </nav>

      <AnimatePresence>
        {welcome && (
          // If the welcome screen can't load, skip it (and unlock the app behind it) rather than crash.
          <ErrorBoundary key="welcome" fallback={null} onError={closeWelcome}>
            <Suspense fallback={null}>
              <Welcome name={meta?.displayName} meta={meta} onClose={closeWelcome} />
            </Suspense>
          </ErrorBoundary>
        )}
      </AnimatePresence>
    </MetaContext.Provider>
  );
}
