import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Blueprint from '../components/Blueprint.jsx';
import { LogoMark, Wordmark } from '../components/Logo.jsx';
import { randomQuote } from '../quotes.js';

gsap.registerPlugin(useGSAP);

// Why Google sent her back without signing in (the server adds ?auth_error=...).
const AUTH_ERRORS = {
  not_allowed: "That Google account isn't on the list yet. Ask the owner to add your email in Settings › People.",
  cancelled: 'Google sign-in was cancelled.',
  expired: 'That took too long. Please try again.',
  failed: "Google sign-in didn't work. Please try again.",
  not_configured: "Google sign-in isn't set up on the server yet.",
  signin_first: 'Sign in first, then connect Gmail from Settings.',
};

function readAuthError() {
  const code = new URLSearchParams(window.location.search).get('auth_error');
  if (!code) return '';
  // Clean the address bar, so a reload doesn't show the message again.
  window.history.replaceState(null, '', `/${window.location.hash}`);
  return AUTH_ERRORS[code] || AUTH_ERRORS.failed;
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

export default function LoginPage({ onLogin, google = false, passwordLogin = true }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(readAuthError);
  // With Google on, the owner's password form folds away behind a link.
  const [showPassword, setShowPassword] = useState(!google);
  const [busy, setBusy] = useState(false);
  const [quote] = useState(randomQuote);
  const scope = useRef(null);
  const cardRef = useRef(null);

  // Fetch the welcome screen while she types, so it is ready the moment she signs in.
  useEffect(() => {
    import('../components/Welcome.jsx').catch(() => {});
  }, []);

  // The drawing sketches itself while the card and its fields rise in one after another.
  // Explicit start and end values, and inline styles cleared at the end, so CSS (e.g. the
  // disabled button's opacity) is back in charge once the entrance is over.
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const shown = { y: 0, opacity: 1, ease: 'power3.out', clearProps: 'transform,opacity' };
        // lazy: false applies the hidden start state immediately, so nothing flashes before it.
        gsap
          .timeline({ defaults: { lazy: false } })
          .fromTo('.login-card', { y: 24, opacity: 0 }, { ...shown, duration: 0.7 }, 0.15)
          .fromTo('.login-reveal', { y: 12, opacity: 0 }, { ...shown, duration: 0.5, stagger: 0.08 }, 0.35)
          .fromTo('.login-quote', { opacity: 0 }, { opacity: 1, duration: 0.8, clearProps: 'opacity' }, 1.4);
      });
      return () => mm.revert();
    },
    { scope },
  );

  // A wrong password gets a small head-shake instead of only red text.
  const { contextSafe } = useGSAP({ scope });
  const shake = contextSafe(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.fromTo(cardRef.current, { x: -10 }, { x: 0, duration: 0.6, ease: 'elastic.out(1.2, 0.3)' });
  });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/login', { method: 'POST', body: { password } });
      onLogin();
    } catch (err) {
      setError(err.message);
      setBusy(false);
      shake();
    }
  }

  return (
    <div className="login" ref={scope}>
      <div className="login-shell">
        <section className="login-art" aria-hidden="true">
          <Blueprint className="login-drawing" delay={0.1} duration={2.2} />
          <p className="login-quote">
            “{quote.text}”{quote.by && <span> — {quote.by}</span>}
          </p>
        </section>

        <div className="card login-card" ref={cardRef}>
          <form onSubmit={submit}>
            <div className="login-reveal login-brand">
              <LogoMark width={56} />
              <div>
                <h1>
                  <Wordmark />
                </h1>
                <p>Architecture & BIM roles, in one place.</p>
              </div>
            </div>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {google && (
              <div className="login-reveal login-google">
                <a className="btn btn-google" href="/api/auth/google/start">
                  <GoogleMark />
                  Continue with Google
                </a>
                <p className="login-note">Your own tracker, saved jobs and searches. Connect Gmail afterwards to bring in your LinkedIn job alerts.</p>
              </div>
            )}
            {passwordLogin && google && !showPassword && (
              <button type="button" className="text-btn login-reveal login-switch" onClick={() => setShowPassword(true)}>
                Sign in with the owner password
              </button>
            )}
            {passwordLogin && showPassword && (
              <>
                {google && <div className="login-or">or</div>}
                <label className="field login-reveal">
                  <span>{google ? 'Owner password' : 'Password'}</span>
                  <input
                    className="input"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoFocus
                  />
                </label>
                <button className="btn btn-primary login-reveal" type="submit" disabled={busy || !password}>
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              </>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
