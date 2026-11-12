// ATS keywords with code, not AI: which tools, skills and qualifications a posting asks for, in
// the posting's own words, and which of them a person really has. Every model the CV writer uses
// (free ones included) gets the same list, so keyword matching doesn't depend on how clever the
// model is. Terms come from shared/skills.js (architecture), server/data/atsTerms.js (every field),
// and any rows added to the ats_terms table (loaded by loadAtsData()).

import { SKILL_GROUPS } from '../../shared/skills.js';
import { ATS_TERMS } from '../data/atsTerms.js';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "STAAD.Pro" also matches "STAAD Pro", "Revit families" also "revit-families". Edges are letters
// and digits, so "GD&T", "3ds Max" and "C#" work where \b would not.
function aliasPattern(alias) {
  const body = alias
    .trim()
    .split(/[\s-]+/)
    .map((part) => escape(part).replace(/\\\./g, '[.\\s]?'))
    .join('[\\s\\-]*');
  return `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`;
}

function compile(term) {
  const names = [term.label, ...(term.aliases || [])].filter(Boolean);
  return { ...term, re: new RegExp(names.map(aliasPattern).join('|'), 'gi') };
}

const SOFT = new Set(['Communication', 'Teamwork', 'Deadlines', 'Attention to detail']);
// shared/skills.js items already carry their own pattern.
const SHARED = SKILL_GROUPS.flatMap((g) =>
  g.items.map(([label, re]) => ({ label, kind: g.kind !== 'ask' ? g.kind : SOFT.has(label) ? 'soft' : 'qualification', disciplines: ['architecture', 'interiors'], aliases: [], re: new RegExp(re.source, 'gi') })),
);
const sharedLabels = new Set(SHARED.map((t) => t.label.toLowerCase()));
const SEED = [...SHARED, ...ATS_TERMS.filter((t) => !sharedLabels.has(t.label.toLowerCase())).map(compile)];

let terms = SEED;
let extraExamples = [];
let loadedAt = 0;
const CACHE_MS = 10 * 60_000;

/** Terms and playbook rows added in the database join the built-in ones (cached for 10 minutes). */
export async function loadAtsData(query) {
  if (Date.now() - loadedAt < CACHE_MS) return;
  loadedAt = Date.now();
  try {
    const rows = await query("SELECT label, kind, disciplines, aliases FROM ats_terms WHERE source <> 'seed'");
    const known = new Set(SEED.map((t) => t.label.toLowerCase()));
    const parse = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? JSON.parse(v || '[]') : []);
    terms = [...SEED, ...rows.filter((r) => r.label && !known.has(r.label.toLowerCase())).map((r) => compile({ label: r.label, kind: r.kind, disciplines: parse(r.disciplines), aliases: parse(r.aliases) }))];
    extraExamples = (await query("SELECT * FROM cv_examples WHERE source <> 'seed'")).map((r) => ({ key: r.ex_key, kind: r.kind, disciplines: parse(r.disciplines), tags: parse(r.tags), before: r.before_text, after: r.after_text, note: r.note || '' }));
  } catch {
    // No tables yet (tests, a fresh install): the built-in lists are enough.
  }
}
export const atsTerms = () => terms;
export const extraPlaybook = () => extraExamples;

/** Every term in a text: { label, kind, disciplines, surface (as written), count, index }. */
export function findTerms(text) {
  const t = String(text || '');
  const out = [];
  for (const term of terms) {
    term.re.lastIndex = 0;
    const hits = [...t.matchAll(term.re)];
    if (!hits.length) continue;
    // Every way the text writes it, most used first (then the longest: "Building Information
    // Modelling" before "BIM").
    const tally = new Map();
    for (const h of hits) {
      const s = h[0].replace(/\s+/g, ' ').trim();
      const key = s.toLowerCase();
      tally.set(key, { s, n: (tally.get(key)?.n || 0) + 1 });
    }
    const surfaces = [...tally.values()].sort((a, b) => b.n - a.n || b.s.length - a.s.length).map((x) => x.s);
    out.push({ label: term.label, kind: term.kind, disciplines: term.disciplines, surface: surfaces[0], surfaces, count: hits.length, index: hits[0].index });
  }
  return out;
}

// The field a person or posting is in, as the keys the term lists use.
export function disciplineKey(text) {
  const s = String(text || '').toLowerCase();
  if (/interior/.test(s)) return 'interiors';
  if (/civil|structur|construction|geotech|transport engineering/.test(s)) return 'civil';
  if (/mechan|automobile|production|manufactur|hvac/.test(s)) return 'mechanical';
  if (/electric|electronics|eee|power/.test(s)) return 'electrical';
  if (/planning|planner|urban/.test(s)) return 'planning';
  return 'architecture';
}

const REQUIRED = /\b(must|required|requirement|mandatory|essential|proficien\w*|strong (knowledge|command|skills?)|expert\w*|should (have|know|be)|minimum|hands[- ]on|good (knowledge|command)|working knowledge)\b/i;
const KIND_WEIGHT = { tool: 1.5, skill: 1.2, qualification: 1, standard: 1, soft: 0.4 };

/**
 * What a posting asks for, most important first:
 * [{ label, kind, surface, count, required, inTitle, weight }].
 */
export function jobKeywords({ title = '', description = '' } = {}) {
  const text = String(description || '');
  const sentences = text.split(/(?<=[.!?;:\n])\s+/);
  const titleHits = new Set(findTerms(title).map((t) => t.label));
  // The description's wording first: a title's short form ("BIM Intern") shouldn't hide the long one.
  const inText = new Map(findTerms(text).map((t) => [t.label, t]));
  const found = findTerms(`${title}\n${text}`).map((t) => {
    const d = inText.get(t.label);
    return d ? { ...t, surface: d.surface, surfaces: [...new Set([...d.surfaces, ...t.surfaces])] } : t;
  });
  return found
    .map((t) => {
      const term = terms.find((x) => x.label === t.label);
      const required = sentences.some((s) => {
        term.re.lastIndex = 0;
        return term.re.test(s) && REQUIRED.test(s);
      });
      const inTitle = titleHits.has(t.label);
      return { ...t, required, inTitle, weight: Math.round((t.count + (required ? 2 : 0) + (inTitle ? 2 : 0)) * (KIND_WEIGHT[t.kind] || 1) * 10) / 10 };
    })
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
}

/**
 * For a CV with no posting: the person's own tools and skills that matter in their field, so the
 * check can make sure the CV shows them.
 */
export function ownKeywords(ownedText, discipline) {
  const key = disciplineKey(discipline);
  return findTerms(ownedText)
    .filter((t) => (t.kind === 'tool' || t.kind === 'skill') && (t.disciplines.includes('all') || t.disciplines.includes(key)))
    .map((t) => ({ ...t, required: false, inTitle: false, weight: t.count * (KIND_WEIGHT[t.kind] || 1) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 20);
}
