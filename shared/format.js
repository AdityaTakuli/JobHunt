// Display helpers shared by the server (digest email) and the React app.

export const SOURCE_LABELS = {
  google_jobs: 'Google Jobs',
  linkedin_email: 'LinkedIn alert',
  manual: 'Added by you',
};

export const ROLE_LABELS = { internship: 'Internship', fresher: 'Fresher', experienced: 'Experienced' };

export const APP_STATUSES = ['saved', 'applied', 'interview', 'offer', 'rejected'];
export const STATUS_LABELS = { saved: 'Saved', applied: 'Applied', interview: 'Interview', offer: 'Offer', rejected: 'Rejected' };

export const FIRM_STATUSES = ['not contacted', 'emailed', 'replied', 'no reply'];
export const FIRM_TYPES = ['design studio', 'BIM consultancy', 'developer', 'other'];

export const SOFTWARE_FILTERS = ['Revit', 'Navisworks', 'SketchUp', 'AutoCAD'];

function compactRupees(n) {
  if (n >= 100_000) {
    const lakhs = n / 100_000;
    return `${Number.isInteger(lakhs) ? lakhs : lakhs.toFixed(1)}L`;
  }
  if (n >= 1_000) {
    const k = n / 1_000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(n);
}

const PERIOD_SUFFIX = { month: '/mo', year: '/yr', week: '/wk', day: '/day', hour: '/hr' };

// { min, max, period } -> "₹15k–20k/mo" or "₹3–4 LPA"
export function formatRange(min, max, period) {
  if (!min && !max) return '';
  const lo = min || max;
  const hi = max || min;
  if (period === 'year' && lo >= 100_000) {
    const l = (n) => {
      const v = n / 100_000;
      return Number.isInteger(v) ? String(v) : v.toFixed(1);
    };
    return lo === hi ? `₹${l(lo)} LPA` : `₹${l(lo)}–${l(hi)} LPA`;
  }
  const range = lo === hi ? compactRupees(lo) : `${compactRupees(lo)}–${compactRupees(hi)}`;
  return `₹${range}${PERIOD_SUFFIX[period] || ''}`;
}

export function formatSalary(job) {
  if (!job) return '';
  const range = formatRange(job.salary_min, job.salary_max, job.salary_period);
  return range || job.salary_text || '';
}

export function timeAgo(value, now = Date.now()) {
  if (!value) return '';
  const diff = now - new Date(value).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.round(d / 30)}mo ago`;
}
