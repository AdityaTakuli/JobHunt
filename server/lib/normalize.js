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

// Google Jobs sometimes drops the first letter of a company name ("ana Urban Space" for "Jana Urban
// Space"). When the name starts in lowercase and the posting spells it with one more letter in
// front, use the posting's spelling.
export function repairCompany(company, text) {
  if (!company || !/^[a-z]/.test(company)) return company;
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(text || '').match(new RegExp(`(?<![\\p{L}\\p{N}])\\p{L}${escaped}`, 'iu'));
  return m ? m[0] : company;
}

export function cleanText(text, maxLength) {
  const out = decodeEntities(String(text ?? '')).replace(/\s+/g, ' ').trim();
  return maxLength && out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

const CITY_ALIASES = [
  [/\b(bangalore|bengaluru|bangaluru|bengalooru|blr)\b/i, 'Bengaluru'],
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

// Where an apply link leads, best first: the employer's own site (including its applicant-
// tracking system), LinkedIn, an established job board, an unknown site, or a reposting site that
// copies listings from elsewhere. Applying at the source is safer and more likely to be seen.
export const APPLY_RANK = { company: 5, linkedin: 4, board: 3, site: 2, aggregator: 1 };

// Careers pages hosted by the employer's hiring software count as the company's own.
const ATS_HOSTS = [
  'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'myworkdaysite.com', 'smartrecruiters.com', 'ashbyhq.com', 'zohorecruit.com',
  'zohorecruit.in', 'keka.com', 'darwinbox.in', 'darwinbox.com', 'freshteam.com', 'recruitee.com', 'bamboohr.com', 'jobvite.com',
  'icims.com', 'successfactors.com', 'successfactors.eu', 'taleo.net', 'breezy.hr', 'workable.com', 'teamtailor.com', 'personio.de',
  'oraclecloud.com', 'kekahire.com', 'hirehive.com', 'applytojob.com', 'jobs.lever.co',
];
const TRUSTED_BOARDS = [
  'naukri.com', 'indeed.com', 'glassdoor.co.in', 'glassdoor.com', 'foundit.in', 'monsterindia.com', 'shine.com', 'internshala.com',
  'instahyre.com', 'cutshort.io', 'hirist.tech', 'hirist.com', 'wellfound.com', 'apna.co', 'unstop.com', 'timesjobs.com',
  'iimjobs.com', 'archinect.com', 'dezeen.com', 'dezeenjobs.com', 'freshersworld.com', 'teamlease.com', 'workindia.in',
];
const AGGREGATORS = [
  'bebee.com', 'bebee.in', 'jooble.org', 'talent.com', 'whatjobs.com', 'jobleads.com', 'learn4good.com', 'recruit.net',
  'trabajo.org', 'jobsora.com', 'expertini.com', 'careerjet.co.in', 'careerjet.com', 'jobrapido.com', 'adzuna.in',
  'simplyhired.co.in', 'simplyhired.com', 'ziprecruiter.com', 'quikr.com', 'jobaaj.com', 'getmereferred.com', 'examassure.in',
  'examassure.com', 'kitjob.in', 'jobisjob.co.in', 'jobted.in', 'jobtensor.com', 'jobs.google.com', 'google.com', 'google.co.in',
  'grabjobs.co', 'jobscan.co', 'resume.io', 'wisdomjobs.com', 'jobstreet.com', 'placementindia.com', 'jobsinbangalore.com',
];
// Words too common in firm names to tell one firm's website from another.
const GENERIC_WORDS = new Set([
  'architects', 'architect', 'architecture', 'architectural', 'studio', 'studios', 'design', 'designs', 'designers', 'consultants',
  'consultancy', 'consulting', 'group', 'associates', 'partners', 'projects', 'the', 'and', 'of', 'in', 'india', 'services',
  'solutions', 'global', 'international', 'infra', 'infrastructure', 'engineering', 'careers', 'jobs', 'bim',
]);

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

const onHost = (host, domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

export function isLinkedInUrl(url) {
  return onHost(hostOf(url), ['linkedin.com']);
}

// Does this host or apply-button label belong to the company? "careers.tataprojects.com" and
// "Tata Projects Careers" both match "Tata Projects Pvt Ltd".
function matchesCompany(host, publisher, company) {
  const words = normalizeCompany(company)
    .split(' ')
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  if (!words.length) return false;
  const labels = host.split('.').slice(0, -1).filter((l) => !['co', 'com', 'org', 'net', 'in', 'careers', 'jobs', 'www'].includes(l));
  const hostText = labels.join('');
  const joined = normalizeCompany(company).replace(/\s+/g, '');
  const pub = normalizeCompany(publisher);
  return (
    (joined.length >= 4 && hostText.includes(joined)) ||
    words.some((w) => (w.length >= 4 && hostText.includes(w)) || labels.includes(w)) ||
    (pub && words.every((w) => pub.split(' ').includes(w)))
  );
}

/** @returns 'company' | 'linkedin' | 'board' | 'site' | 'aggregator' */
export function applyKind(url, { company = '', publisher = '' } = {}) {
  const host = hostOf(url);
  if (!host) return 'site';
  if (onHost(host, ['linkedin.com'])) return 'linkedin';
  if (onHost(host, AGGREGATORS)) return 'aggregator';
  if (onHost(host, TRUSTED_BOARDS)) return 'board';
  if (onHost(host, ATS_HOSTS)) return 'company';
  if (matchesCompany(host, publisher, company)) return 'company';
  return 'site';
}

export function isJobBoard(url) {
  const host = hostOf(url);
  return onHost(host, ['linkedin.com', ...TRUSTED_BOARDS, ...AGGREGATORS]);
}

export function applyRank(url, info) {
  return APPLY_RANK[applyKind(url, info)];
}

// Apply options from any source, deduped and sorted best first: [{ url, publisher, kind, rank }].
export function rankApplyOptions(options, company) {
  const seen = new Set();
  const out = [];
  for (const o of options || []) {
    if (!isHttpUrl(o?.url) || seen.has(o.url)) continue;
    seen.add(o.url);
    const kind = o.kind || applyKind(o.url, { company, publisher: o.publisher });
    out.push({ url: o.url, publisher: cleanText(o.publisher, 80) || hostOf(o.url), kind, rank: APPLY_RANK[kind] });
  }
  return out.sort((a, b) => b.rank - a.rank).slice(0, 10);
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
