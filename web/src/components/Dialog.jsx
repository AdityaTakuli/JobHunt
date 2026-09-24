import { useEffect, useRef } from 'react';
import { IconX } from '../icons.jsx';

// Native <dialog> (focus trap, Esc to close, backdrop) wrapped for React.
export function Dialog({ open, title, onClose, onSubmit, children, actions, error }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      {open && (
        <form
          method="dialog"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit?.(e);
          }}
        >
          <div className="dialog-head">
            <h2 id="dialog-title">{title}</h2>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
              <IconX />
            </button>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {children}
          {actions && <div className="dialog-actions">{actions}</div>}
        </form>
      )}
    </dialog>
  );
}
