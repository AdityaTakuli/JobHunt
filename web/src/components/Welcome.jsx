import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { randomQuote } from '../quotes.js';
import Blueprint from './Blueprint.jsx';
import Typewriter from './Typewriter.jsx';

const AUTO_CONTINUE_S = 5;
const NAME_WAIT_MS = 1200;

// Shown right after sign-in (and on the first visit each day): the drawing sketches itself, the
// greeting types out, then a quote and today's numbers appear. Continues on its own after a few
// seconds; any click, Enter or Esc skips it.
export default function Welcome({ name, meta, onClose }) {
  const [quote] = useState(randomQuote);
  const [ready, setReady] = useState(name != null);
  const [line, setLine] = useState(0); // 0 typing line 1, 1 typing line 2, 2 done
  const buttonRef = useRef(null);

  // Wait briefly for the name from /jobs/meta, then fall back so the greeting never stalls.
  useEffect(() => {
    if (name != null) {
      setReady(true);
      return undefined;
    }
    const t = setTimeout(() => setReady(true), NAME_WAIT_MS);
    return () => clearTimeout(t);
  }, [name]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  // Once everything is shown: focus the button and continue on a timer. (A timer, not the
  // progress bar's animation end, because reduced-motion users get no bar animation at all.)
  useEffect(() => {
    if (line !== 2) return undefined;
    buttonRef.current?.focus({ preventScroll: true });
    const t = setTimeout(onClose, AUTO_CONTINUE_S * 1000);
    return () => clearTimeout(t);
  }, [line, onClose]);

  const who = (name ?? 'Kothu').trim();
  const greeting = who ? `Welcome ${who},` : 'Welcome,';
  const newToday = meta?.newToday ?? null;
  const due = meta?.followUpsDue ?? 0;

  return (
    <motion.div
      className="welcome"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome"
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.015, filter: 'blur(4px)' }}
      transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="welcome-inner">
        <Blueprint className="welcome-drawing" duration={1.8} />

        <h1 className="welcome-title">
          {ready && <Typewriter text={greeting} speed={60} delay={350} caret={line === 0} onDone={() => setLine(1)} />}
          <br />
          {line >= 1 && (
            <Typewriter className="welcome-sub" text="hope you have a great day." speed={38} delay={150} onDone={() => setLine(2)} />
          )}
        </h1>

        <motion.div
          className="welcome-after"
          initial="hidden"
          animate={line === 2 ? 'shown' : 'hidden'}
          variants={{ hidden: {}, shown: { transition: { staggerChildren: 0.12 } } }}
        >
          <motion.blockquote className="welcome-quote" variants={fadeUp}>
            “{quote.text}”{quote.by && <cite> — {quote.by}</cite>}
          </motion.blockquote>

          {newToday != null && (
            <motion.p className="welcome-stats" variants={fadeUp}>
              <span>
                <strong>{newToday}</strong> new role{newToday === 1 ? '' : 's'} today
              </span>
              {due > 0 && (
                <span className="due">
                  <strong>{due}</strong> follow-up{due === 1 ? '' : 's'} due
                </span>
              )}
            </motion.p>
          )}

          <motion.div variants={fadeUp}>
            <button
              ref={buttonRef}
              type="button"
              className="btn btn-primary welcome-go"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              Start hunting →
            </button>
          </motion.div>
        </motion.div>
      </div>

      {line === 2 && (
        <motion.span
          className="welcome-progress"
          aria-hidden="true"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: AUTO_CONTINUE_S, ease: 'linear' }}
        />
      )}
    </motion.div>
  );
}

const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
};
