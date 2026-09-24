import { query } from '../db/pool.js';
import { normalizeCity } from './normalize.js';

// Values editable on the Settings screen.
export const DEFAULT_SETTINGS = {
  // Searched in every city below, so no place names here.
  search_queries: ['BIM intern', 'Revit architect intern', 'architectural intern', 'BIM modeler fresher', 'junior architect'],
  // Where to search, which cities rank higher, and what the digest covers. Editable any time.
  cities: ['Bengaluru'],
  digest_enabled: true,
  digest_time: '08:00',
  notification_email: '',
  extra_exclude_keywords: [],
};

// Internal bookkeeping, never shown or edited in the UI.
const INTERNAL_DEFAULTS = {
  query_rotation_index: 0,
  serp_locations: {}, // city (lowercase) -> { location, gl } | null, from SerpApi's locations API
  last_digest_at: null,
  last_digest_on: null,
};

const ALL_DEFAULTS = { ...DEFAULT_SETTINGS, ...INTERNAL_DEFAULTS };

export async function getSettings() {
  const rows = await query('SELECT k, v FROM settings');
  const out = structuredClone(ALL_DEFAULTS);
  for (const { k, v } of rows) {
    if (!(k in ALL_DEFAULTS)) continue;
    try {
      out[k] = JSON.parse(v);
    } catch {
      // keep default
    }
  }
  return out;
}

export async function getPublicSettings() {
  const all = await getSettings();
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, all[k]]));
}

export async function saveSettings(values) {
  const entries = Object.entries(values).filter(([k]) => k in ALL_DEFAULTS);
  if (!entries.length) return;
  const now = new Date();
  await query(
    'INSERT INTO settings (k, v, updated_at) VALUES ? ON DUPLICATE KEY UPDATE v = VALUES(v), updated_at = VALUES(updated_at)',
    [entries.map(([k, v]) => [k, JSON.stringify(v), now])],
  );
}

const cleanList = (value, { max = 30, maxLength = 120 } = {}) => {
  if (!Array.isArray(value)) return null;
  const items = value.map((s) => String(s ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean);
  return [...new Set(items)].slice(0, max).map((s) => s.slice(0, maxLength));
};

// Validates a PUT /api/settings body. Returns { values } or { error }.
export function validateSettings(body) {
  const values = {};
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
  if ('extra_exclude_keywords' in body) {
    const list = cleanList(body.extra_exclude_keywords, { max: 50, maxLength: 60 });
    if (!list) return { error: 'Exclude keywords must be a list.' };
    values.extra_exclude_keywords = list;
  }
  return { values };
}
