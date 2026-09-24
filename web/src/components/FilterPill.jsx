import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconCheck, IconChevronDown } from '../icons.jsx';

// A filter chip that opens a small panel below it (Glassdoor-style). Closes on outside click or
// Esc. `children` may be a function receiving close(), for options that apply and close at once.
export function FilterPill({ label, active = false, children, panelLabel }) {
  const [open, setOpen] = useState(false);
  const [alignRight, setAlignRight] = useState(false);
  const wrapRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Near the right edge of the screen, open the panel leftwards so it stays on screen.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const left = wrapRef.current.getBoundingClientRect().left;
    setAlignRight(left + 300 > window.innerWidth - 12);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <div className="pill-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`pill${active ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <IconChevronDown size={16} className="pill-chevron" />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className={`pill-panel${alignRight ? ' is-right' : ''}`}
            role="dialog"
            aria-label={panelLabel || (typeof label === 'string' ? label : undefined)}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.1 } }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            {typeof children === 'function' ? children(close) : children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Single choice from a list; picking one applies it and closes the panel.
export function OptionList({ options, value, onChange, onDone, label }) {
  return (
    <div className="option-list" role="radiogroup" aria-label={label}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`option${selected ? ' is-selected' : ''}`}
            onClick={() => {
              onChange(o.value);
              onDone?.();
            }}
          >
            <span>{o.label}</span>
            {selected && <IconCheck size={16} />}
          </button>
        );
      })}
    </div>
  );
}

// Several choices at once (checkboxes).
export function CheckList({ options, values, onToggle, label }) {
  return (
    <div className="option-list" role="group" aria-label={label}>
      {options.map((o) => {
        const checked = values.includes(o.value);
        return (
          <label key={o.value} className={`option option-check${checked ? ' is-selected' : ''}`}>
            <input type="checkbox" checked={checked} onChange={() => onToggle(o.value)} />
            <span>{o.label}</span>
          </label>
        );
      })}
    </div>
  );
}
