// Application details: what the person types into the "Application details" form (web
// ApplicationDetails.jsx) so ARCH in Chrome can fill application forms with them. They are kept
// apart from the AI-read profile (profiles.details), so they survive a re-read of the CV, exist
// before any CV is uploaded, and always win over what the AI read.
//
// Pay, notice period, marks and gender are filled ONLY from here: the AI never guesses them.

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const isoDate = (v) => {
  const s = str(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  // A real day: "2002-02-30" rolls over to March in Date, so it must read back the same.
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : '';
};
const url = (v) => {
  let u = str(v, 200);
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^\/+/, '')}`;
  return /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u) ? u : '';
};
const list = (v, n, max) =>
  [...new Set((Array.isArray(v) ? v : String(v || '').split(/[,;\n]/)).map((x) => str(x, max)).filter(Boolean))].slice(0, n);

// CVs often set the name in capitals ("ASHA RAO"); forms and CVs want "Asha Rao".
export function niceName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  return name && !/[a-z]/.test(name) ? name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase()) : name;
}

export const DISCIPLINES =['Architecture', 'Interior design', 'Civil engineering', 'Mechanical engineering', 'Electrical engineering', 'Planning', 'Construction management', 'Other'];
export const GENDERS = ['Female', 'Male', 'Non-binary', 'Prefer not to say'];
export const RELOCATE = ['Yes', 'No'];

// key -> clean(value). Unknown keys are ignored; an empty or bad value is stored as ''.
const CLEAN = {
  name: (v) => str(v, 80),
  email: (v) => {
    const e = str(v, 120).toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
  },
  phone: (v) => {
    const p = str(v, 40).replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
    return p.replace(/\D/g, '').length >= 7 ? p : '';
  },
  date_of_birth: isoDate,
  gender: (v) => (GENDERS.includes(str(v, 30)) ? str(v, 30) : ''),
  nationality: (v) => str(v, 40),
  address: (v) => str(v, 200),
  city: (v) => str(v, 60),
  state: (v) => str(v, 60),
  pincode: (v) => (/^[A-Za-z0-9 -]{3,12}$/.test(str(v, 12)) ? str(v, 12) : ''),
  country: (v) => str(v, 60),
  linkedin: url,
  website: url,
  github: url,
  discipline: (v) => str(v, 60),
  degree: (v) => str(v, 80),
  specialization: (v) => str(v, 80),
  institution: (v) => str(v, 120),
  graduation_year: (v) => {
    const n = Number(str(String(v ?? ''), 4));
    return Number.isInteger(n) && n >= 1980 && n <= 2040 ? String(n) : '';
  },
  score: (v) => str(v, 30),
  current_company: (v) => str(v, 100),
  current_title: (v) => str(v, 80),
  current_ctc: (v) => str(v, 40),
  expected_ctc: (v) => str(v, 40),
  notice_period: (v) => str(v, 40),
  available_from: isoDate,
  relocate: (v) => (RELOCATE.includes(str(v, 3)) ? str(v, 3) : ''),
  preferred_cities: (v) => list(v, 8, 60).join(', '),
  languages: (v) => list(v, 8, 40).join(', '),
  heard_from: (v) => str(v, 60),
};

export const DETAIL_KEYS = Object.keys(CLEAN);

/** The stored details, cleaned: every key present, '' when unknown. */
export function cleanDetails(input) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.fromEntries(DETAIL_KEYS.map((k) => [k, src[k] == null ? '' : CLEAN[k](typeof src[k] === 'number' ? String(src[k]) : src[k])]));
}

export const hasDetails = (d) => Boolean(d) && DETAIL_KEYS.some((k) => d[k]);

// The basics nearly every form asks for. The web app asks for these first.
export const ESSENTIAL_KEYS = ['name', 'email', 'phone', 'city', 'degree', 'institution', 'graduation_year'];

/** Starting values for the form: what is saved, else what the AI read from the CV. */
export function prefillDetails(details, profile, account = {}) {
  const d = cleanDetails(details || {});
  const p = profile || {};
  const c = p.contact || {};
  const edu = p.education?.[0] || {};
  const exp = p.experience?.[0] || {};
  const fallback = {
    name: niceName(p.name || account.name),
    email: c.email || account.email,
    phone: c.phone,
    date_of_birth: c.date_of_birth,
    address: c.address,
    city: c.city || p.cities?.[0],
    linkedin: c.linkedin,
    website: c.website,
    discipline: p.discipline,
    degree: edu.degree,
    institution: edu.institution,
    graduation_year: p.graduation_year || edu.year,
    current_company: p.stage === 'student' ? '' : exp.firm,
    current_title: p.stage === 'student' ? '' : exp.role,
    preferred_cities: (p.cities || []).join(', '),
  };
  const filled = cleanDetails(fallback);
  for (const k of DETAIL_KEYS) if (!d[k] && filled[k]) d[k] = filled[k];
  return d;
}

export const missingEssentials = (d) => ESSENTIAL_KEYS.filter((k) => !d?.[k]);
