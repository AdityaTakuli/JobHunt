import crypto from 'node:crypto';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ndash: '–', mdash: '—', middot: '·', bull: '•', rupee: '₹' };

export function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

// Turns an HTML fragment into readable plain text, keeping paragraph breaks.
export function stripHtml(html) {
  if (!html) return '';
  const text = String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanText(text, maxLength) {
  const out = decodeEntities(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return maxLength && out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

const CITY_ALIASES = [
  [/\b(bangalore|bengaluru|bangaluru|bengalooru)\b/i, 'Bengaluru'],
  [/\b(mumbai|bombay|navi mumbai|thane)\b/i, 'Mumbai'],
  [/\b(gurugram|gurgaon)\b/i, 'Gurugram'],
  [/\bnoida\b/i, 'Noida'],
  [/\b(new delhi|delhi)\b/i, 'Delhi'],
  [/\bpune\b/i, 'Pune'],
  [/\b(hyderabad|secunderabad)\b/i, 'Hyderabad'],
  [/\b(chennai|madras)\b/i, 'Chennai'],
  [/\b(kolkata|calcutta)\b/i, 'Kolkata'],
  [/\bahmedabad\b/i, 'Ahmedabad'],
  [/\b(kochi|cochin|ernakulam)\b/i, 'Kochi'],
  [/\bchandigarh\b/i, 'Chandigarh'],
  [/\bjaipur\b/i, 'Jaipur'],
  [/\b(goa|panaji)\b/i, 'Goa'],
  [/\b(mysore|mysuru)\b/i, 'Mysuru'],
  [/\b(remote|work from home|wfh|anywhere)\b/i, 'Remote'],
];

// "Bengaluru East, Karnataka, India" -> "Bengaluru". Unknown places keep their first segment.
export function normalizeCity(location) {
  const text = cleanText(location);
  if (!text) return '';
  for (const [pattern, city] of CITY_ALIASES) {
    if (pattern.test(text)) return city;
  }
  const first = text.split(/[,·|(]/)[0].trim();
  if (/^(india|karnataka)$/i.test(first)) return '';
  return first
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .slice(0, 120);
}

const COMPANY_SUFFIXES = /\b(pvt\.?|private|ltd\.?|limited|llp|inc\.?|co\.?|corp\.?|corporation|company|india)\b/g;

export function normalizeCompany(company) {
  return cleanText(company)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(COMPANY_SUFFIXES, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeTitle(title) {
  return cleanText(title)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ') // "(Revit)", "[Hybrid]"
    .replace(/\s[-–|]\s.*$/, ' ') // "BIM Intern - Bengaluru"
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupeKey({ company, title, city }) {
  const key = `${normalizeCompany(company)}|${normalizeTitle(title)}|${(city || '').toLowerCase()}`;
  return crypto.createHash('sha1').update(key).digest('hex');
}

export const APPLY_RANK = { direct: 3, linkedin: 2, other: 1 };

export function isLinkedInUrl(url) {
  return /(^|\.)linkedin\.com$/i.test(safeHost(url));
}

function safeHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export function applyRank(url, { isDirect = false } = {}) {
  if (isDirect) return APPLY_RANK.direct;
  if (isLinkedInUrl(url)) return APPLY_RANK.linkedin;
  return APPLY_RANK.other;
}

export function isHttpUrl(url) {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function toDate(value) {
  if (value == null || value === '') return null;
  const date = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
