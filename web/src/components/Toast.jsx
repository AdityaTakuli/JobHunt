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
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' is-error' : ''}`}>
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
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
