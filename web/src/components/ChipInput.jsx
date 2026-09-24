import { AnimatePresence, motion } from 'motion/react';
import { useRef, useState } from 'react';
import { IconX } from '../icons.jsx';

// A list edited as chips: type and press Enter (or a comma) to add, × or Backspace to remove.
// Text left in the box is added when it loses focus, so nothing typed is silently dropped.
export default function ChipInput({ id, value, onChange, placeholder, addLabel = 'Add', max = 50, maxLength = 120, splitOnComma = true, describedBy }) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef(null);

  function add(raw) {
    const parts = splitOnComma ? raw.split(',') : [raw];
    const items = parts.map((s) => s.trim().replace(/\s+/g, ' ').slice(0, maxLength)).filter(Boolean);
    setDraft('');
    if (!items.length) return;
    const next = [...value];
    for (const item of items) {
      if (next.length < max && !next.some((v) => v.toLowerCase() === item.toLowerCase())) next.push(item);
    }
    if (next.length !== value.length) onChange(next);
  }

  const remove = (item) => onChange(value.filter((v) => v !== item));

  return (
    // Clicking anywhere in the box focuses the text field, like a normal input.
    <div className="chip-input" onClick={() => inputRef.current?.focus()}>
      <AnimatePresence initial={false}>
        {value.map((item) => (
          <motion.span
            key={item}
            layout
            className="chip"
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
          >
            {item}
            <button
              type="button"
              aria-label={`Remove ${item}`}
              onClick={(e) => {
                e.stopPropagation();
                remove(item);
                inputRef.current?.focus();
              }}
            >
              <IconX size={13} />
            </button>
          </motion.span>
        ))}
      </AnimatePresence>
      <input
        id={id}
        ref={inputRef}
        value={draft}
        placeholder={value.length ? `${addLabel}…` : placeholder}
        aria-describedby={describedBy}
        disabled={value.length >= max}
        onChange={(e) => {
          const v = e.target.value;
          if (splitOnComma && v.includes(',')) add(v);
          else setDraft(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) {
            remove(value[value.length - 1]);
          }
        }}
        onBlur={() => draft && add(draft)}
      />
    </div>
  );
}
