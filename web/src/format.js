// Browser-side date helpers. Everything is shown in IST.
export * from '../../shared/format.js';

const TZ = 'Asia/Kolkata';

export function formatDate(value, options = { day: 'numeric', month: 'short' }) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, ...options }).format(new Date(value));
}

export function formatDateTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-IN', { timeZone: TZ, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(
    new Date(value),
  );
}

// 'YYYY-MM-DD' of a date in IST, for <input type="date"> and due-date comparisons.
export function istDay(value = new Date()) {
  const d = new Date(new Date(value).getTime() + 330 * 60_000);
  return d.toISOString().slice(0, 10);
}

// <input type="date"> value -> ISO timestamp at 09:00 IST that day.
export function dayToIso(day) {
  return day ? new Date(`${day}T09:00:00+05:30`).toISOString() : null;
}

// 'overdue' | 'due' (today) | null
export function followUpState(followUpAt, status) {
  if (!followUpAt || !['applied', 'interview'].includes(status)) return null;
  const due = istDay(followUpAt);
  const today = istDay();
  if (due < today) return 'overdue';
  if (due === today) return 'due';
  return null;
}

export function isNew(createdAt) {
  return createdAt && Date.now() - new Date(createdAt).getTime() < 86_400_000;
}
