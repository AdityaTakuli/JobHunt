import { AnimatePresence, motion } from 'motion/react';
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(null);

// toast({ message, actions: [{ label, onClick, primary }], duration, error, id })
// duration: ms before auto-dismiss, or 0 to stay until an action is taken.
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    ({ id = `${Date.now()}-${Math.random()}`, duration = 4000, ...rest }) => {
      clearTimeout(timers.current.get(id));
      setToasts((list) => [...list.filter((t) => t.id !== id), { id, ...rest }].slice(-3));
      if (duration) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <motion.div
              key={t.id}
              layout
              className={`toast${t.error ? ' is-error' : ''}`}
              initial={{ opacity: 0, y: 16, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.97, transition: { duration: 0.15 } }}
              transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            >
              <p>{t.message}</p>
              <div className="toast-actions">
                {(t.actions || []).map((a) => (
                  <button
                    key={a.label}
                    type="button"
                    className={`btn${a.primary ? ' btn-primary' : ''}`}
                    onClick={() => {
                      dismiss(t.id);
                      a.onClick?.();
                    }}
                  >
                    {a.label}
                  </button>
                ))}
                {!t.actions?.length && (
                  <button type="button" className="btn" onClick={() => dismiss(t.id)} aria-label="Dismiss">
                    OK
                  </button>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
