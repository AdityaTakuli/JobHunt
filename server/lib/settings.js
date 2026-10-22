import { query } from '../db/pool.js';
import { normalizeCity } from './normalize.js';

// Each person's own values, edited on their Settings screen.
export const DEFAULT_SETTINGS = {
  // Searched in every city below, so no place names here.
  search_queries: ['BIM intern', 'Revit architect intern', 'architectural intern', 'BIM modeler fresher', 'junior architect'],
  // Where to search, which cities rank higher, and what the digest covers. Editable any time.
  cities: ['Bengaluru'],
  digest_enabled: true,
  digest_time: '08:00',
  // Empty = the email they signed in with.
  notification_email: '',
  // Name in the welcome message after sign-in. Empty = their first name from Google.
  display_name: '',
};

// Shared by everyone, edited by admins: the AI labels every job once for all.
export const SHARED_DEFAULTS = {
  extra_exclude_keywords: [],
  // People who may sign in with Google (besides the owner, admins and ALLOWED_EMAILS).
  allowed_emails: [],
};

// Internal bookkeeping, never shown or edited in the UI.
const USER_INTERNAL = { last_digest_at: null, last_digest_on: null };
const SHARED_INTERNAL = {
  query_rotation_index: 0,
  serp_locations: {}, // city (lowercase) -> { location, gl } | null, from SerpApi's locations API
};

const USER_ALL = { ...DEFAULT_SETTINGS, ...USER_INTERNAL };
const SHARED_ALL = { ...SHARED_DEFAULTS, ...SHARED_INTERNAL };

function readRows(rows, defaults) {
  const out = structuredClone(defaults);
  for (const { k, v } of rows) {
    if (!(k in defaults)) continue;
    try {
      out[k] = JSON.parse(v);
    } catch {
      // keep default
    }
  }
  return out;
}

// Shared settings (exclude keywords, access list, fetch bookkeeping).
export async function getSettings() {
  return readRows(await query('SELECT k, v FROM settings'), SHARED_ALL);
}

export async function saveSettings(values) {
  const entries = Object.entries(values).filter(([k]) => k in SHARED_ALL);
  if (!entries.length) return;
  const now = new Date();
  await query(
    'INSERT INTO settings (k, v, updated_at) VALUES ? ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)',
    [entries.map(([k, v]) => [k, JSON.stringify(v), now])],
  );
}

export async function getUserSettings(userId) {
  return readRows(await query('SELECT k, v FROM user_settings WHERE user_id = ?', [userId]), USER_ALL);
}

export async function saveUserSettings(userId, values) {
  const entries = Object.entries(values).filter(([k]) => k in USER_ALL);
  if (!entries.length) return;
  const now = new Date();
  await query(
    'INSERT INTO user_settings (user_id, k, v, updated_at) VALUES ? ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)',
    [entries.map(([k, v]) => [userId, k, JSON.stringify(v), now])],
  );
}

// Every person's settings, for the scheduled search and the digests.
export async function allUserSettings() {
  const [users, rows] = await Promise.all([
    query('SELECT id, email, name FROM users ORDER BY id'),
    query('SELECT user_id, k, v FROM user_settings'),
  ]);
  return users.map((u) => ({ user: u, settings: readRows(rows.filter((r) => r.user_id === u.id), USER_ALL) }));
}

// What the AI labels with: the shared exclude list, and everyone's cities as preferred places.
export async function classifierContext() {
  const [shared, everyone] = await Promise.all([getSettings(), allUserSettings()]);
  const cities = [...new Set(everyone.flatMap((e) => e.settings.cities))];
  return { extraExclude: shared.extra_exclude_keywords, cities };
}

// The Settings screen: their own values, plus the shared ones for admins.
export async function getPublicSettings(user) {
  const own = await getUserSettings(user.id);
  const out = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, own[k]]));
  if (user.isAdmin) out.extra_exclude_keywords = (await getSettings()).extra_exclude_keywords;
  return out;
}

const cleanList = (value, { max = 30, maxLength = 120 } = {}) => {
  if (!Array.isArray(value)) return null;
  const items = value.map((s) => String(s ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean);
  return [...new Set(items)].slice(0, max).map((s) => s.slice(0, maxLength));
};

// Validates a PUT /api/settings body. Returns { values, shared } (their own and shared values to
// save) or { error }. Shared values are only taken from admins.
export function validateSettings(body, { isAdmin = false } = {}) {
  const values = {};
  const shared = {};
  if ('search_queries' in body) {
    const list = cleanList(body.search_queries, { max: 20 });
    if (!list?.length) return { error: 'Add at least one search query.' };
    values.search_queries = list;
  }
  if ('cities' in body) {
    const list = cleanList(body.cities, { max: 10, maxLength: 60 });
    if (!list) return { error: 'Cities must be a list.' };
    // "Bangalore" and "Bengaluru" must match the city names stored on jobs.
    values.cities = [...new Set(list.map((c) => normalizeCity(c) || c))];
  }
  if ('digest_enabled' in body) values.digest_enabled = Boolean(body.digest_enabled);
  if ('digest_time' in body) {
    const t = String(body.digest_time || '');
    const m = t.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!m) return { error: 'Digest time must look like 08:00.' };
    values.digest_time = t;
  }
  if ('notification_email' in body) {
    const email = String(body.notification_email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Enter a valid email address.' };
    values.notification_email = email;
  }
  if ('display_name' in body) {
    const name = String(body.display_name ?? '').trim().replace(/\s+/g, ' ');
    if (name.length > 40) return { error: 'Keep the name under 40 characters.' };
    values.display_name = name;
  }
  if ('extra_exclude_keywords' in body && isAdmin) {
    const list = cleanList(body.extra_exclude_keywords, { max: 50, maxLength: 60 });
    if (!list) return { error: 'Exclude keywords must be a list.' };
    shared.extra_exclude_keywords = list;
  }
  return { values, shared };
}
