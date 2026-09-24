// Rule-based classifier: the always-available fallback when Groq is down, slow or rate-limited.
// Produces the same label shape as the Groq classifier.

import { parseSalary } from './salary.js';

const INCLUDE = [
  /\barchitect/i, // architect, architects, architecture, architectural
  /\bb\.?\s?arch\b/i,
  /\bbim\b/i,
  /\brevit\b/i,
  /\bnavisworks\b/i,
  /\bdesign intern/i,
];

const EXCLUDE = ['software', 'solution', 'solutions', 'cloud', 'data', 'enterprise', 'network', 'security', 'salesforce', 'aws', 'java'];

// Terms that make a title unambiguously about the built environment, so description noise
// (e.g. "BIM data management") does not exclude it.
const STRONG_TITLE = /\b(bim|revit|navisworks|architectural|b\.?\s?arch|interior|landscape|urban design|draughts?man|drafts?man)\b/i;

export const SOFTWARE = [
  ['Revit', /\brevit\b/i],
  ['Navisworks', /\bnavisworks\b/i],
  ['SketchUp', /\bsketch\s?up\b/i],
  ['AutoCAD', /\bauto\s?cad\b/i],
  ['Rhino', /\brhino(ceros)?\b/i],
  ['Grasshopper', /\bgrasshopper\b/i],
  ['ArchiCAD', /\barchicad\b/i],
  ['Dynamo', /\bdynamo\b/i],
  ['Lumion', /\blumion\b/i],
  ['Enscape', /\benscape\b/i],
  ['V-Ray', /\bv-?ray\b/i],
  ['3ds Max', /\b3ds\s?max\b/i],
  ['Tekla', /\btekla\b/i],
  ['Photoshop', /\bphotoshop\b/i],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (word) => new RegExp(`\\b${escapeRe(word)}\\b`, 'i');
const EXCLUDE_RES = EXCLUDE.map(wordRe);

// True when the job is in one of her chosen cities (both already normalized, e.g. "Bengaluru").
export function isPreferredCity(city, cities = []) {
  const c = String(city || '').trim().toLowerCase();
  return Boolean(c) && cities.some((p) => String(p).trim().toLowerCase() === c);
}

const EXPERIENCE_RE = /(\d{1,2})\s*(\+?)\s*(?:(?:-|–|to)\s*(\d{1,2})\s*\+?\s*)?(?:years?|yrs?)\b/gi;
const EXPERIENCE_CONTEXT = /experience|exp\b|work|practice|industry|professional|relevant|minimum|at least|min\./;
const FRESHER_TEXT =
  /\b(freshers?|fresh graduates?|recent graduates?|entry[- ]level|no (?:prior )?experience|final[- ]year students?|graduate trainees?)\b/i;

// Years of experience a posting asks for, as { min, max } (max null = open-ended), or null when
// it does not say. "0-1 years" -> 0..1, "2+ yrs" -> 2.., "freshers can apply" -> 0..0.
export function parseExperience(title, description) {
  const text = `${title || ''}\n${description || ''}`;
  let best = null;
  for (const m of text.matchAll(EXPERIENCE_RE)) {
    // Skip durations that are not experience, e.g. "5-year B.Arch", "2 years old firm".
    const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30).toLowerCase();
    if (!EXPERIENCE_CONTEXT.test(around)) continue;
    const min = Number(m[1]);
    const max = m[3] != null ? Number(m[3]) : null;
    if (min > 30 || (max != null && max < min)) continue;
    if (!best || min < best.min) best = { min, max };
  }
  if (best) return best;
  if (FRESHER_TEXT.test(text) || /\bintern(s|ship)?\b|\btrainee\b|\bapprentice/i.test(String(title || ''))) return { min: 0, max: 0 };
  return null;
}

// Minimum years of experience asked for, or null. "3+ years", "3-5 yrs", "minimum 4 years".
export function minYearsRequired(text) {
  let min = null;
  for (const m of String(text || '').matchAll(EXPERIENCE_RE)) {
    const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 30).toLowerCase();
    if (!EXPERIENCE_CONTEXT.test(around)) continue;
    const n = Number(m[1]);
    if (min == null || n < min) min = n;
  }
  return min;
}

export function detectRoleType(title, description) {
  const t = String(title || '');
  const d = String(description || '');
  if (/\bintern(s|ship)?\b|\btrainee\b|\bapprentice/i.test(t)) return 'internship';
  if (/\b(senior|sr\.?|lead|manager|principal|head|associate director|director)\b/i.test(t)) return 'experienced';
  if (/\b(fresher|graduate|entry[- ]level|junior|jr\.?)\b/i.test(t)) return 'fresher';

  const years = minYearsRequired(d);
  if (years != null && years >= 3) return 'experienced';
  if (/\binternship\b|\bintern\b|\btrainee\b/i.test(d)) return 'internship';
  if (years != null && years <= 1) return 'fresher';
  if (/\b(fresher|freshers|graduate|entry[- ]level|0\s*[-–to]+\s*1\s*(year|yr))/i.test(d)) return 'fresher';
  if (years != null) return 'fresher';
  return null;
}

export function detectSoftware(text) {
  return SOFTWARE.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export function classifyWithRules(job, { extraExclude = [], cities = [] } = {}) {
  const title = String(job.title || '');
  const description = String(job.description || '');
  const text = `${title}\n${description}`;

  const excludeRes = [...EXCLUDE_RES, ...extraExclude.filter(Boolean).map((w) => wordRe(w.trim()))];
  const titleExcluded = excludeRes.some((re) => re.test(title));
  const descExcludeHits = excludeRes.filter((re) => re.test(description)).length;
  const included = INCLUDE.some((re) => re.test(text));
  const descExcluded = descExcludeHits >= 2 && !STRONG_TITLE.test(title);

  const isRelevant = included && !titleExcluded && !descExcluded;
  const software = detectSoftware(text);
  const isBim = /\bbim\b/i.test(text) || software.includes('Revit') || software.includes('Navisworks');
  const roleType = detectRoleType(title, description);
  const salary = parseSalary(description) || parseSalary(title);

  let score = 0;
  if (isRelevant) {
    score = 40;
    if (isBim) score += 20;
    if (roleType === 'internship' || roleType === 'fresher') score += 20;
    if (isPreferredCity(job.city, cities)) score += 20;
  }

  let reason;
  if (!included) reason = 'No architecture or BIM keywords';
  else if (titleExcluded) reason = 'Title matches an excluded field (e.g. software/cloud)';
  else if (descExcluded) reason = 'Description reads like an IT role';
  else reason = [isBim ? 'BIM role' : 'Architecture role', roleType, software.slice(0, 3).join(', ')].filter(Boolean).join(' · ');

  return {
    is_relevant: isRelevant,
    role_type: roleType,
    is_bim: isBim,
    software,
    stipend_or_salary: salary?.text ?? null,
    match_score: score,
    reason,
  };
}
