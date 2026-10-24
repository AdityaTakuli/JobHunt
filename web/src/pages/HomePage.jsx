// The public front page: what ArchJobs is, what it does, and what it reads from a Google account.
// It is the one screen anybody can see without signing in (Google's OAuth review needs a home page
// that explains the app, and people deserve to know what Gmail access is for before they grant it).
import { motion } from 'motion/react';
import Blueprint from '../components/Blueprint.jsx';
import Logo, { LogoMark, Wordmark } from '../components/Logo.jsx';
import {
  IconBriefcase,
  IconBuilding,
  IconCheck,
  IconColumns,
  IconGlobe,
  IconMail,
  IconMonitor,
  IconMoon,
  IconSparkle,
  IconSun,
} from '../icons.jsx';

const EASE = [0.22, 1, 0.36, 1];

// Each block fades up once, the first time it comes into view.
const reveal = {
  initial: { opacity: 0, y: 16 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-60px' },
  transition: { duration: 0.55, ease: EASE },
};

const SECTIONS = [
  { id: 'what', label: 'What it does' },
  { id: 'how', label: 'How it works' },
  { id: 'data', label: 'Your Google data' },
];

// The hash belongs to the router, so a link down the page scrolls itself instead of setting one.
function jumpTo(event, id) {
  const el = document.getElementById(id);
  if (!el) return;
  event.preventDefault();
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
}

// Google's "G", in its own colours, as their sign-in button guidelines ask.
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

const FEATURES = [
  {
    Icon: IconBriefcase,
    title: 'One job feed',
    body: 'Architecture, interiors, landscape, urban design and BIM openings in the cities you pick — from Google Jobs, from the careers feeds of global firms with India offices, and from your own LinkedIn job alerts. Duplicates are merged and each role keeps its best apply link.',
  },
  {
    Icon: IconSparkle,
    title: 'Labelled, not just listed',
    body: 'Every posting is read once and labelled: internship or fresher role, BIM or not, the software it asks for, the stipend or salary, and the years of experience expected. Experienced-only roles stay out of the way, and a fresher-friendly switch filters the rest.',
  },
  {
    Icon: IconColumns,
    title: 'An application tracker',
    body: 'Move each application from applied to interview, assessment, offer or rejected, with notes, contacts and follow-up reminders — so nothing sits forgotten for three weeks.',
  },
  {
    Icon: IconMail,
    title: 'A daily digest',
    body: 'One email a day with the new roles in your cities and the follow-ups that are due, at a time you choose.',
  },
  {
    Icon: IconGlobe,
    title: 'Direct apply links first',
    body: "Apply links are ranked: the firm's own site and hiring system before LinkedIn, job boards before the sites that only copy listings. Closed postings disappear on their own once the deadline passes or the link goes dead.",
  },
  {
    Icon: IconBuilding,
    title: 'Firms worth writing to',
    body: 'A list of practices and global studios with India offices, with their careers pages, for the cold emails that find the jobs nobody advertises.',
  },
];

const STEPS = [
  {
    title: 'Sign in with Google',
    body: 'Your name, email address and profile picture create your account. Nothing else is asked for at this point.',
  },
  {
    title: 'Pick your cities and searches',
    body: 'Say where you want to work and what you are looking for. Searches run twice a day for everyone, so the feed fills itself.',
  },
  {
    title: 'Connect Gmail, if you want to',
    body: 'Optional and read-only. It brings your LinkedIn job alerts into the feed and moves your tracker along as replies arrive. You can skip it, or disconnect it later.',
  },
];

const LIMITS = [
  'Gmail data is used only for the two features above, both visible in the app.',
  'It is never sold, never used for advertising, and never used to train AI or machine-learning models.',
  'The body of your email is not stored — only the message id, sender, subject, date and the label worked out from it.',
  'Nothing in your mailbox is ever sent, deleted, labelled or changed.',
  'Disconnect in Settings at any time: the stored permission is deleted and withdrawn at Google.',
];

export default function HomePage({ google = false, theme = 'system', onCycleTheme }) {
  const ThemeIcon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconMonitor;

  return (
    <div className="home">
      <header className="home-header">
        <div className="home-header-inner">
          <a className="brand" href="#/" aria-label="ArchJobs home">
            <Logo width={46} />
          </a>
          <nav className="home-nav" aria-label="About ArchJobs">
            {SECTIONS.map(({ id, label }) => (
              <a key={id} href={`#${id}`} onClick={(e) => jumpTo(e, id)}>
                {label}
              </a>
            ))}
            <a href="/privacy">Privacy</a>
          </nav>
          <button
            type="button"
            className="icon-btn"
            onClick={onCycleTheme}
            aria-label={`Theme: ${theme}. Change theme`}
            title={`Theme: ${theme}`}
          >
            <ThemeIcon />
          </button>
          <a className="btn btn-primary btn-sm home-signin" href="#/signin">
            Sign in
          </a>
        </div>
      </header>

      <main id="main" className="home-main" tabIndex={-1}>
        <section className="home-hero">
          <div className="home-hero-copy">
            <motion.p
              className="home-eyebrow"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease: EASE }}
            >
              Architecture · Interiors · BIM — India
            </motion.p>
            <motion.h1
              className="home-title"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: EASE, delay: 0.06 }}
            >
              Every internship and fresher job, on <em>one</em> page.
            </motion.h1>
            <motion.p
              className="home-lede"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: EASE, delay: 0.14 }}
            >
              <Wordmark /> collects architecture, interiors and BIM openings from Google Jobs, from firms' own careers pages and from your
              LinkedIn job alerts, labels each one, and keeps track of every application you send.
            </motion.p>
            <motion.div
              className="home-cta"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: EASE, delay: 0.22 }}
            >
              {google ? (
                <a className="btn btn-google home-cta-google" href="/api/auth/google/start">
                  <GoogleMark />
                  Continue with Google
                </a>
              ) : (
                <a className="btn btn-primary" href="#/signin">
                  Sign in
                </a>
              )}
              <a className="btn btn-ghost" href="#what" onClick={(e) => jumpTo(e, 'what')}>
                See what it does
              </a>
            </motion.div>
            <motion.p
              className="home-note"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, ease: EASE, delay: 0.4 }}
            >
              ArchJobs is run by Velocity Technologies for a small invited group, so signing in needs an invitation. This page explains
              everything the app does, and exactly what it reads from a Google account, before you grant anything.
            </motion.p>
          </div>

          <div className="home-art" aria-hidden="true">
            <Blueprint className="home-drawing" delay={0.2} duration={2.4} />
          </div>
        </section>

        <motion.section className="home-section" id="what" {...reveal}>
          <h2 className="home-h2">What it does</h2>
          <p className="home-sub">Six things, all in the one app.</p>
          <ul className="home-grid">
            {FEATURES.map(({ Icon, title, body }) => (
              <li className="card home-feature" key={title}>
                <span className="home-feature-icon" aria-hidden="true">
                  <Icon size={20} />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ul>
        </motion.section>

        <motion.section className="home-section" id="how" {...reveal}>
          <h2 className="home-h2">How it works</h2>
          <p className="home-sub">Three steps, and the third one is optional.</p>
          <ol className="home-steps">
            {STEPS.map(({ title, body }, i) => (
              <li key={title}>
                <span className="home-step-no" aria-hidden="true">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </li>
            ))}
          </ol>
        </motion.section>

        <motion.section className="home-section" id="data" {...reveal}>
          <h2 className="home-h2">What ArchJobs does with your Google data</h2>
          <p className="home-sub">
            In short: your name and email to make the account, and — only if you ask for it — read-only Gmail access for job alerts and
            replies about your own applications.
          </p>

          <div className="home-data">
            <div className="card home-scope">
              <h3>Signing in</h3>
              <p className="home-scope-perm">
                <code>openid</code>, <code>userinfo.email</code>, <code>userinfo.profile</code>
              </p>
              <p>
                Google shares your name, email address and profile picture. They create your account and show who is signed in. Your account
                is yours alone: your tracker, searches, firms and settings are not visible to anyone else on ArchJobs.
              </p>
            </div>

            <div className="card home-scope">
              <h3>
                Gmail <span className="home-tag">optional</span>
              </h3>
              <p className="home-scope-perm">
                <code>gmail.readonly</code>
              </p>
              <p>Connecting Gmail is a separate step in Settings, never part of signing in. ArchJobs then looks for two kinds of email only:</p>
              <ul className="home-bullets">
                <li>
                  <strong>LinkedIn job alerts</strong> — the postings inside them (title, company, location, link) join the shared job list.
                </li>
                <li>
                  <strong>Replies about your own applications</strong> — confirmations, interview invitations, assessments, offers and
                  rejections, which move your own tracker forward.
                </li>
              </ul>
            </div>
          </div>

          <ul className="home-limits">
            {LIMITS.map((line) => (
              <li key={line}>
                <IconCheck size={16} />
                <span>{line}</span>
              </li>
            ))}
          </ul>

          <p className="home-policy">
            ArchJobs' use and transfer of information received from Google APIs follows the{' '}
            <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including
            the Limited Use requirements. The full details are in the <a href="/privacy">privacy policy</a>.
          </p>
        </motion.section>

        <motion.section className="home-section home-end" {...reveal}>
          <LogoMark width={64} />
          <h2 className="home-h2">Ready when you are.</h2>
          <p className="home-sub">Sign in with the Google account you use for job hunting.</p>
          <div className="home-cta home-cta-center">
            {google && (
              <a className="btn btn-google home-cta-google" href="/api/auth/google/start">
                <GoogleMark />
                Continue with Google
              </a>
            )}
            <a className={`btn ${google ? 'btn-ghost' : 'btn-primary'}`} href="#/signin">
              Other ways to sign in
            </a>
          </div>
        </motion.section>
      </main>

      <footer className="home-footer">
        <div className="home-footer-inner">
          <p>
            <Wordmark /> — built by Velocity Technologies, Dehradun.
          </p>
          <nav aria-label="Footer">
            <a href="/privacy">Privacy policy</a>
            <a href="mailto:adityatakuli51@gmail.com">adityatakuli51@gmail.com</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
