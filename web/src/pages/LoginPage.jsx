import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Blueprint from '../components/Blueprint.jsx';
import { LogoMark, Wordmark } from '../components/Logo.jsx';
import { randomQuote } from '../quotes.js';

gsap.registerPlugin(useGSAP);

export default function LoginPage({ onLogin }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
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
            <label className="field login-reveal">
              <span>Password</span>
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
          </form>
        </div>
      </div>
    </div>
  );
}
