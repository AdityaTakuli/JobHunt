// Scores a written CV the way an ATS and a hiring reader would, with code: does it show every
// posting keyword the person really has, in the posting's own words; are the bullets strong
// (action verb, 8-32 words, no first person, no repeats); are the standard sections there. The
// problems it lists go back to the model for one revision (lib/tailor.js), so a free model gets
// the same review a careful human editor would give.

import { ACTION_VERBS, WEAK_STARTS } from '../data/atsTerms.js';
import { findTerms } from './atsKeywords.js';

const VERBS = new Set(ACTION_VERBS);
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function cvText(r) {
  return [
    r.headline,
    r.summary,
    ...(r.skills || []).map((g) => (g.items || []).join(', ')),
    ...(r.experience || []).flatMap((e) => [e.role, e.firm, ...(e.bullets || [])]),
    ...(r.projects || []).flatMap((p) => [p.title, p.context, (p.tools || []).join(', '), ...(p.bullets || [])]),
    ...(r.education || []).flatMap((e) => [e.degree, e.institution]),
    ...(r.certifications || []),
    ...(r.achievements || []),
  ]
    .filter(Boolean)
    .join('\n');
}

/** A bullet's problem, or null. */
export function bulletProblem(b) {
  const w = words(b);
  const first = (w[0] || '').toLowerCase().replace(/[^a-z]/g, '');
  if (WEAK_STARTS.test(b)) return 'starts weakly';
  if (/\b(I|my|me|we|our)\b/.test(b)) return 'uses first person';
  if (!(VERBS.has(first) || /ed$/.test(first) || /ing$/.test(first) || first === 'built' || first === 'led' || first === 'drew' || first === 'won' || first === 'ran')) return 'does not start with an action verb';
  if (w.length < 8) return 'is too short to say what was done';
  if (w.length > 34) return 'is too long (keep it under 30 words)';
  return null;
}

/**
 * @param resume  the checked CV (lib/tailor.js shape)
 * @param asked   jobKeywords() or ownKeywords() output
 * @param ownedText  everything the person's files and details say (what they really have)
 * @returns {{ score, coverage, shown, missingOwned, wording, issues, problems }}
 *   problems: the list of plain instructions sent back to the model.
 */
export function scoreCv(resume, { asked = [], ownedText = '', name = '' } = {}) {
  const r = resume || {};
  const text = cvText(r);
  const lower = text.toLowerCase();
  const inCv = new Map(findTerms(text).map((t) => [t.label, t]));
  const owned = new Set(findTerms(ownedText).map((t) => t.label));
  // Degrees are facts, not keywords: a B.Tech is never told to write "B.E." because the posting does.
  const relevant = asked.filter((k) => owned.has(k.label) && k.kind !== 'soft' && k.kind !== 'qualification');
  const shown = relevant.filter((k) => inCv.has(k.label));
  const missingOwned = relevant.filter((k) => !inCv.has(k.label));
  // The posting's own wording: "Building Information Modelling" in the posting and only "BIM" on the
  // CV is a miss for a literal-match ATS.
  // Any of the posting's own spellings will do ("BIM" or "Building Information Modelling" when the
  // posting uses both); only a CV that uses none of them is flagged.
  const wording = shown
    .filter((k) => (k.surfaces || [k.surface]).filter(Boolean).every((s) => !lower.includes(s.toLowerCase())))
    .map((k) => ({ label: k.label, use: k.surface, cvSays: inCv.get(k.label)?.surface }));

  const issues = [];
  const problems = [];
  if (missingOwned.length) {
    problems.push(
      `These keywords from the posting are things the person really has (they are in their files) but the CV does not show them. Work each into the skills list and, where the sources describe that work, into a bullet: ${missingOwned.map((k) => `"${k.surface || k.label}"`).join(', ')}.`,
    );
  }
  if (wording.length) {
    problems.push(`Use the posting's exact wording for these (ATS systems match words literally): ${wording.map((w) => `write "${w.use}"${w.cvSays ? ` (the CV says "${w.cvSays}")` : ''}`).join('; ')}.`);
  }

  const bullets = [...(r.experience || []).flatMap((e) => (e.bullets || []).map((b) => ({ b, where: `${e.role || 'role'} at ${e.firm || ''}`.trim() }))), ...(r.projects || []).flatMap((p) => (p.bullets || []).map((b) => ({ b, where: p.title })))];
  const seen = new Set();
  const bad = [];
  for (const { b, where } of bullets) {
    const p = bulletProblem(b);
    if (p) bad.push(`"${b.slice(0, 70)}${b.length > 70 ? '…' : ''}" (${where}) ${p}`);
    const n = norm(b);
    if (seen.has(n)) bad.push(`"${b.slice(0, 50)}…" appears twice`);
    seen.add(n);
  }
  if (bad.length) {
    issues.push(...bad);
    problems.push(`Rewrite these bullets (start with a past-tense action verb, say what was done, with which tool, and the result; 12-28 words; no first person): ${bad.slice(0, 8).join('; ')}.`);
  }

  // A CV summary has no pronouns and no name: "Final-year B.Arch student with…", not "She is…".
  const nameWords = String(name || '').split(/\s+/).filter((w) => w.length > 2);
  if (/\b(I|my|me|she|he|her|his|him|they|their)\b/i.test(r.summary || '') || (nameWords.length && nameWords.every((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(r.summary || '')))) {
    issues.push('summary uses a name or pronouns');
    problems.push('Write the summary without the name and without pronouns (I, she, he, their): start with what they are, e.g. "Final-year B.Arch student with…".');
  }
  const summaryWords = words(r.summary).length;
  if (summaryWords < 35) issues.push('summary too short'), problems.push('Make the summary 3-4 sentences (50-80 words): degree and year, strongest real experience and tools, the roles wanted.');
  else if (summaryWords > 110) issues.push('summary too long'), problems.push('Cut the summary to 50-80 words.');
  const skillCount = (r.skills || []).reduce((n, g) => n + (g.items || []).length, 0);
  if (skillCount < 6) issues.push('few skills listed'), problems.push('List more of the tools and skills the sources show, grouped (for example Software, Technical, Design).');
  if (!(r.experience || []).length && !(r.projects || []).length) issues.push('no experience or projects'), problems.push('Add the projects the sources describe, with 2-3 bullets each.');
  const thin = [...(r.experience || []), ...(r.projects || [])].filter((e) => (e.bullets || []).length < 2);
  if (thin.length) issues.push(`${thin.length} entr${thin.length === 1 ? 'y has' : 'ies have'} under 2 bullets`), problems.push(`Give these at least 2 bullets each from what the sources say: ${thin.map((e) => `"${e.title || e.role}"`).join(', ')}.`);

  const coverage = relevant.length ? Math.round((shown.length / relevant.length) * 100) : 100;
  const score = Math.max(
    0,
    Math.round(100 - Math.min(40, missingOwned.length * 10) - Math.min(12, wording.length * 4) - Math.min(30, bad.length * 6) - (issues.includes('summary uses a name or pronouns') ? 8 : 0) - (summaryWords < 35 || summaryWords > 110 ? 8 : 0) - (skillCount < 6 ? 8 : 0) - (thin.length ? 5 : 0)),
  );
  return {
    score,
    coverage,
    shown: shown.map((k) => k.label),
    missingOwned: missingOwned.map((k) => k.surface || k.label),
    wording,
    issues: [...missingOwned.map((k) => `missing keyword you have: ${k.surface || k.label}`), ...wording.map((w) => `use the posting's wording "${w.use}"`), ...issues],
    problems,
  };
}
