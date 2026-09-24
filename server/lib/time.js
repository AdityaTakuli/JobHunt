// IST helpers. India has no DST, so a fixed +05:30 offset is exact.
const IST_OFFSET_MS = 330 * 60_000;

const shifted = (date) => new Date(date.getTime() + IST_OFFSET_MS);
const pad = (n) => String(n).padStart(2, '0');

export function istDateString(date = new Date()) {
  const d = shifted(date);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function istTime(date = new Date()) {
  const d = shifted(date);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

// Midnight IST of the given day, as a UTC Date.
export function startOfIstDay(date = new Date()) {
  const d = shifted(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_OFFSET_MS);
}

export function startOfIstMonth(date = new Date()) {
  const d = shifted(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - IST_OFFSET_MS);
}

// Days left in the IST month, counting today.
export function daysLeftInIstMonth(date = new Date()) {
  const d = shifted(date);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  return daysInMonth - d.getUTCDate() + 1;
}

export function formatIst(date, options = { dateStyle: 'medium', timeStyle: 'short' }) {
  return new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', ...options }).format(date);
}

export const DAY_MS = 86_400_000;
