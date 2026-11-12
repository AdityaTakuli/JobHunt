// The CV ArchJobs writes (and ARCH in Chrome uploads): a detailed, ATS-friendly CV made from the
// person's own material, either general ("My CV" on the Profile page) or tailored to one posting
// with a cover letter. Works for any discipline: architecture and design students' projects come
// from what the portfolio pages show; engineering students' (civil, mechanical...) from their CV.
//
// The AI reorders, combines and rewords; it does not add. Everything it returns is checked against
// the CV text, the portfolio page notes, the profile and the person's own details, and anything
// that can't be found there is dropped with the reason shown: a firm, a role, a tool, a project or
// a number the sources don't have never reaches the PDF. The keyword match before and after is
// counted the same way the fit score counts skills (shared/skills.js), so it is a real number.
//
// The PDF is ATS-friendly by construction: one column of real, selectable text in reading order,
// standard section names, plain bullets, no tables, images or text boxes, and the title, author
// and keywords set in the file's metadata. Up to two A4 pages (one when it fits).

import { disciplineKey, findTerms, jobKeywords, ownKeywords } from './atsKeywords.js';
import { pickExamples, playbookPrompt } from './atsPlaybook.js';
import { scoreCv } from './atsQuality.js';
import { cleanDetails } from './details.js';
import { profileFacts } from './fill.js';

export const TAILOR_VERSION = 3;
// tailored_docs.page_key of the general CV (no posting): one per person, newest wins.
export const GENERAL_KEY = 'general';

export const TAILOR_SYSTEM_PROMPT = `You write a detailed, ATS-friendly CV for a student or recent graduate in India: architecture,
interior design, civil, mechanical or any other engineering or design field (see "discipline").
When a job posting is given, you also write a cover letter for it. You may only reorder, combine,
shorten and reword what their CV text, portfolio notes, profile and details already say.

Hard rules:
- Never add an employer, role, project, degree, tool, skill, date, number, award or responsibility
  that is not in the sources. If the posting asks for something they don't have, leave it out: do
  not hint they have it. A number (area, units, %, months, count) only when the sources give it.
- Portfolio notes are real work: one entry per project. Describe each from its notes: the kind
  and scale of building or product, what was produced (plans, sections, elevations, details,
  working drawings, renders, models, analysis), the software that made it, the design process
  shown, and the role the student states. Never invent a site area, budget, client or team size.
- Engineering projects and internships: say what was designed, analysed, built, tested or
  supervised, with which method or tool, and the result the CV states.
- Bullets: start with a strong past-tense verb (Designed, Detailed, Modelled, Analysed, Drafted,
  Coordinated, Supervised, Tested...), then what, with which tool, and the deliverable or result.
  12 to 28 words each. No first person anywhere in the CV.
- ATS: plain words, no symbols or emoji. Name each tool exactly as the sources do. With a posting,
  use the posting's own terms for things they really did ("Revit documentation" for "drawings in
  Revit") and put what it asks for first; without one, order by strength for roles in their field.
- Size: up to 4 experience entries with 3-5 bullets each; up to 5 projects with 2-3 bullets each
  (a student with little experience gets fuller projects, never padding); skills in 2-4 groups
  (for example "Software", "Technical", "Design", "Site and management") with up to 24 items in all;
  every certification and achievement the sources list, written "Name | Issuer | hours or date"
  as far as the sources give them. Summary ("Professional Summary"): who they are (degree, year,
  institution and marks when given), their strongest real experience and tools, the kinds of
  role they want, and when they are available when the details say. 3-4 sentences, 50-80 words, no
  clichés ("hard-working", "passionate", "team player", "go-getter", "strong foundation"). Call
  them what they are: a student is "a B.Arch student" or "a final-year civil engineering student",
  never "an architect" or "an engineer" before they have graduated.
- Cover letter, only when there is a posting: 3 short paragraphs, 170-230 words, first person,
  plain and specific. Name the firm and two things from the posting; back each with a real project
  or internship. Never use "I am writing to express my interest", "I am excited to apply",
  "passionate", "esteemed", "dynamic team", "perfect fit", "hit the ground running".
Reply with one JSON object and nothing else:
{
  "headline": string,                 // e.g. "B.Arch student (2027) | Revit and working drawings" or "Mechanical engineering graduate | SolidWorks, ANSYS"
  "summary": string,
  "skills": [{ "group": string, "items": string[] }],
  "experience": [{ "role": string, "firm": string, "location": string | null, "dates": string | null, "bullets": string[] }],   // role may carry the kind of work as the CV says: "Overseas Contractor (Part-time)"
  "projects": [{ "title": string, "place": string | null, "dates": string | null, "context": string | null, "tools": string[], "bullets": string[] }],   // place = site or city ("IMT Manesar"); dates as written ("2026-Present", "Ongoing"); context = "Semesters VII-VIII, Group Project", "Architectural thesis", "Internship at Studio X"
  "certifications": string[],
  "achievements": string[],           // awards, competitions, publications, positions of responsibility
  "cover_letter": { "greeting": string, "paragraphs": string[], "sign_off": string } | null
}`;

// Portfolio page notes, one entry per project, small enough for a prompt.
export function portfolioProjects(pages) {
  const by = new Map();
  for (const p of pages || []) {
    if (!p?.project) continue;
    const key = p.project.trim();
    const e = by.get(key) || { title: key, pages: [], typology: null, scale: null, drawings: new Set(), software: new Set(), process: false, technical: false, roles: new Set(), notes: [] };
    e.pages.push(p.page);
    e.typology ||= p.typology;
    e.scale ||= p.scale;
    for (const d of p.drawings || []) e.drawings.add(d);
    for (const s of p.software || []) e.software.add(s);
    e.process ||= p.process;
    e.technical ||= p.technical;
    if (p.role) e.roles.add(p.role);
    if (p.note && e.notes.length < 4) e.notes.push(p.note);
    by.set(key, e);
  }
  return [...by.values()].slice(0, 12).map((e) => ({
    title: e.title,
    pages: e.pages.length,
    typology: e.typology,
    scale: e.scale,
    drawings: [...e.drawings],
    software: [...e.software],
    process_shown: e.process,
    technical_drawings: e.technical,
    role: [...e.roles].join('; ') || null,
    notes: e.notes,
  }));
}

export function tailorUserPrompt({ profile, resumeText, posting, facts, pages }) {
  const known = {
    name: facts.name,
    discipline: facts.discipline,
    stage: profile.stage,
    graduation_year: facts.graduation_year,
    education: profile.education,
    degree_from_details: facts.degree ? { degree: facts.degree, specialization: facts.specialization, institution: facts.institution, score: facts.score } : null,
    experience: profile.experience,
    software: (profile.software || []).map((s) => s.name),
    skills: profile.skills,
    projects: profile.projects,
    certifications: profile.certifications,
    achievements: profile.achievements || [],
    coa: profile.coa,
    languages: facts.languages,
    available_from: facts.available_from,
    preferred_cities: facts.cities,
    portfolio_review: profile.portfolio ? { strengths: profile.portfolio.strengths, best_for: profile.portfolio.best_for, summary: profile.portfolio.summary } : null,
  };
  const general = !posting?.title && !posting?.description;
  const portfolio = portfolioProjects(pages);
  return [
    general
      ? `No posting: write a general CV for ${facts.discipline || 'their field'} roles${facts.stage === 'student' ? ' (internships)' : ''}, and cover_letter = null.`
      : `Job: ${posting.title || 'unknown title'} at ${posting.company || 'unknown firm'}${posting.location ? `, ${posting.location}` : ''}\nPosting:\n${String(posting.description || '').slice(0, 6_000) || '(no posting text: tailor to the title only)'}`,
    `Profile:\n${JSON.stringify(known)}`,
    portfolio.length ? `Portfolio projects (read from the portfolio pages):\n${JSON.stringify(portfolio)}` : null,
    resumeText ? `CV text:\n${String(resumeText).slice(0, 8_000)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---- Checks: nothing the sources don't back up ----

const norm = (s) =>
  String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const strs = (v, n, max) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);

const SMALL_WORDS = new Set(['the', 'and', 'pvt', 'ltd', 'llp', 'inc', 'private', 'limited', 'for', 'with', 'from', 'into', 'our', 'was', 'were']);
const wordsOf = (s) =>
  norm(s)
    .split(' ')
    .filter((w) => w.length > 2 && !SMALL_WORDS.has(w));
const has = (source, w) => source.includes(` ${w} `) || source.includes(` ${w}s `) || (w.endsWith('s') && source.includes(` ${w.slice(0, -1)} `));

// Every word of `name` (ignoring tiny ones) appears in the source text.
function foundIn(source, name) {
  const words = wordsOf(name);
  // A name with no long word ("L&T", "AB Studio") must appear as a whole.
  if (!words.length) return Boolean(norm(name)) && source.includes(` ${norm(name)} `);
  return words.every((w) => has(source, w));
}

// Most words of a sentence appear in the source (for certifications and achievements, which the
// AI may shorten or reword a little).
function mostlyIn(source, text, share) {
  const words = wordsOf(text);
  return words.length > 0 && words.filter((w) => has(source, w)).length / words.length >= share;
}

// Numbers ("30%", "12 drawings", "2024") a line may use: only ones the sources have.
const numbersIn = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', ''));

// Lines no CV or cover letter needs.
const STOCK = /I am writing to (express|apply)|I am (excited|thrilled|delighted) to apply|passionate|esteemed|dynamic team|perfect fit|hit the ground running|team player|go-getter|synergy|I believe I would be a great|hard-?working|results-driven|strong foundation/i;

const splitSentences = (s) => s.split(/(?<=[.!?])\s+/).filter(Boolean);

// Degree names, written the ways CVs and postings write them. Case-sensitive on purpose: "be" and
// "me" are words, "B.E." and "M.E." are degrees.
const DEGREE_RE = /\b(?:B\.?\s?Tech|M\.?\s?Tech|B\.?\s?Arch|M\.?\s?Arch|B\.?\s?Des|M\.?\s?Des|B\.?\s?Plan|M\.?\s?Plan|B\.\s?E\.?|M\.\s?E\.?|BE(?=\s)|ME(?=\s)|B\.?\s?Sc|M\.?\s?Sc|Diploma)\b\.?/g;
const DEGREE_KEYS = [
  [/^b\.?\s?tech/i, 'btech'],
  [/^m\.?\s?tech/i, 'mtech'],
  [/^b\.?\s?arch/i, 'barch'],
  [/^m\.?\s?arch/i, 'march'],
  [/^b\.?\s?des/i, 'bdes'],
  [/^m\.?\s?des/i, 'mdes'],
  [/^b\.?\s?plan/i, 'bplan'],
  [/^m\.?\s?plan/i, 'mplan'],
  [/^b\.?\s?e\b|^be$/i, 'be'],
  [/^m\.?\s?e\b|^me$/i, 'me'],
  [/^b\.?\s?sc/i, 'bsc'],
  [/^m\.?\s?sc/i, 'msc'],
  [/^diploma/i, 'diploma'],
  [/bachelor of technology/i, 'btech'],
  [/bachelor of engineering/i, 'be'],
  [/bachelor of architecture/i, 'barch'],
  [/bachelor of design/i, 'bdes'],
];
export const degreeKey = (s) => DEGREE_KEYS.find(([re]) => re.test(String(s || '').trim()))?.[1] || null;
// Does the person's material name this degree anywhere?
function degreeHeld(key, sourceText) {
  const found = new Set();
  for (const m of String(sourceText).matchAll(DEGREE_RE)) found.add(degreeKey(m[0]));
  for (const [re, k] of DEGREE_KEYS) if (re.source.startsWith('bachelor') && re.test(sourceText)) found.add(k);
  return found.has(key);
}

/** Education as the profile read it, with what she typed in her details on top. */
export function educationOf(profile, details) {
  const d = cleanDetails(details || {});
  const list = (profile.education || []).slice(0, 4).map((e) => ({ degree: e.degree || '', institution: e.institution || '', year: e.year ? String(e.year) : null, score: e.score || null }));
  if (d.degree || d.institution) {
    const degree = [d.degree, d.specialization && !norm(d.degree).includes(norm(d.specialization)) ? `(${d.specialization})` : ''].filter(Boolean).join(' ');
    const same = list.findIndex((e) => (d.institution && norm(e.institution) === norm(d.institution)) || (d.degree && norm(e.degree) === norm(d.degree)));
    const entry = { degree: degree || list[same]?.degree || '', institution: d.institution || list[same]?.institution || '', year: d.graduation_year || list[same]?.year || null, score: d.score || list[same]?.score || null };
    if (same >= 0) list.splice(same, 1);
    list.unshift(entry);
  } else if (list[0] && d.score) list[0].score = d.score;
  return list.filter((e) => e.degree || e.institution).slice(0, 4);
}

/**
 * Keeps only what the sources back up. Returns { resume, cover_letter, dropped } or null when the
 * reply is not usable at all.
 */
export function checkTailored(value, { profile, resumeText, facts, pages = null, details = null }) {
  if (!value || typeof value !== 'object') return null;
  const d = cleanDetails(details || {});
  const sourceText = [
    resumeText,
    JSON.stringify(profile.experience),
    JSON.stringify(profile.education),
    JSON.stringify(profile.projects),
    (profile.portfolio?.projects || []).join(' '),
    JSON.stringify(portfolioProjects(pages)),
    (profile.software || []).map((s) => s.name).join(' '),
    (profile.skills || []).join(' '),
    (profile.certifications || []).join(' '),
    (profile.achievements || []).join(' '),
    profile.summary,
    [d.discipline, d.degree, d.specialization, d.institution, d.current_company, d.current_title, d.city].join(' '),
  ].join(' ');
  const source = ` ${norm(sourceText)} `;
  const cvNumbers = new Set(numbersIn(`${sourceText} ${JSON.stringify(profile)} ${d.graduation_year} ${d.score}`));
  const numbersOk = (s) => numbersIn(s).every((n) => cvNumbers.has(n));
  const dropped = [];
  const keep = (ok, what) => {
    if (!ok) dropped.push(what);
    return ok;
  };
  const short = (s) => `"${s.slice(0, 50)}${s.length > 50 ? '…' : ''}"`;

  // Skills, in groups. An older reply (or a model that ignores the groups) sends a flat list.
  const rawGroups = Array.isArray(value.skills) && value.skills.every((x) => typeof x === 'string') ? [{ group: 'Skills', items: value.skills }] : Array.isArray(value.skills) ? value.skills : [];
  const seen = new Set();
  let total = 0;
  const skills = rawGroups
    .slice(0, 5)
    .map((g) => ({
      group: str(g?.group, 30) || 'Skills',
      items: strs(g?.items, 20, 50).filter((s) => {
        const k = norm(s);
        if (seen.has(k) || total >= 24) return false;
        if (!keep(foundIn(source, s), `skill "${s}"`)) return false;
        seen.add(k);
        total += 1;
        return true;
      }),
    }))
    .filter((g) => g.items.length);

  const bulletsOf = (list, n, label) => strs(list, n + 2, 260).filter((b) => keep(numbersOk(b), `${label} with a number the sources don't have (${short(b)})`) && keep(!STOCK.test(b), `stock line ${short(b)}`)).slice(0, n);

  const experience = (Array.isArray(value.experience) ? value.experience : [])
    .slice(0, 5)
    .map((e) => ({ role: str(e?.role, 80), firm: str(e?.firm, 100), location: str(e?.location, 60) || null, dates: str(e?.dates, 40) || null, bullets: e?.bullets }))
    .filter((e) => keep(e.firm && foundIn(source, e.firm), `employer "${e.firm}"`) && keep(!e.role || foundIn(source, e.role), `role "${e.role}"`))
    .map((e) => ({
      ...e,
      location: e.location && foundIn(source, e.location) ? e.location : null,
      dates: e.dates && numbersOk(e.dates) ? e.dates : null,
      bullets: bulletsOf(e.bullets, 5, 'a line'),
    }))
    .slice(0, 4);

  const projects = (Array.isArray(value.projects) ? value.projects : [])
    .slice(0, 7)
    .map((p) => ({ title: str(p?.title, 100), place: str(p?.place, 60) || null, dates: str(p?.dates, 40) || null, context: str(p?.context, 80) || null, tools: strs(p?.tools, 8, 40), bullets: Array.isArray(p?.bullets) ? p.bullets : p?.line ? [p.line] : [] }))
    .filter((p) => p.title && keep(foundIn(source, p.title), `project "${p.title}"`))
    .map((p) => ({
      ...p,
      place: p.place && foundIn(source, p.place) ? p.place : null,
      dates: p.dates && numbersOk(p.dates) ? p.dates : null,
      context: p.context && numbersOk(p.context) ? p.context : null,
      tools: p.tools.filter((t) => keep(foundIn(source, t), `tool "${t}" on ${p.title}`)),
      bullets: bulletsOf(p.bullets, 3, 'a project line'),
    }))
    .filter((p) => p.bullets.length)
    .slice(0, 5);

  const certifications = strs(value.certifications, 8, 160).filter((c) => keep(mostlyIn(source, c, 0.6) && numbersOk(c), `certification ${short(c)}`));
  const achievements = strs(value.achievements, 6, 220).filter((a) => keep(mostlyIn(source, a, 0.5) && numbersOk(a), `achievement ${short(a)}`));

  // Summary and headline: sentences with a number the sources don't have, or stock phrases, go;
  // a degree they don't hold (the posting's "B.E./B.Tech" copied onto a B.E.) becomes their own.
  const ownDegree = facts.degree || profile.education?.[0]?.degree || '';
  const fixDegree = (s, where) =>
    s.replace(DEGREE_RE, (m) => {
      if (degreeHeld(degreeKey(m), sourceText)) return m;
      const short = ownDegree.match(DEGREE_RE)?.[0];
      dropped.push(`degree "${m}" in the ${where} (they hold ${ownDegree || 'another degree'})`);
      return short || 'Graduate';
    });
  const summary = fixDegree(
    splitSentences(str(value.summary, 700))
      .filter((s) => keep(numbersOk(s), `a summary line with a number the sources don't have (${short(s)})`) && keep(!STOCK.test(s), `stock line ${short(s)}`))
      .join(' '),
    'summary',
  );
  const headline = numbersOk(str(value.headline, 140)) ? fixDegree(str(value.headline, 140), 'headline') : '';
  if (!summary && !experience.length && !projects.length) return null;

  const letter = value.cover_letter && typeof value.cover_letter === 'object' ? value.cover_letter : {};
  const paragraphs = strs(letter.paragraphs, 4, 1_200)
    .map((p) =>
      splitSentences(p)
        .filter((sentence) => keep(!STOCK.test(sentence), `stock line ${short(sentence)}`))
        .join(' '),
    )
    .filter(Boolean);
  const cover_letter = paragraphs.length
    ? { greeting: str(letter.greeting, 80) || 'Dear Hiring Team,', paragraphs, sign_off: str(letter.sign_off, 80) || `Regards,\n${facts.name || ''}`.trim() }
    : null;

  return {
    resume: {
      version: TAILOR_VERSION,
      name: facts.name,
      headline,
      summary,
      skills,
      experience,
      projects,
      // Education always comes from the profile and her details, never from the reply.
      education: educationOf(profile, details),
      certifications,
      achievements,
      languages: d.languages ? d.languages.split(/,\s*/) : [],
      student: (profile.stage || 'student') !== 'experienced' && (profile.experience_months || 0) < 12,
    },
    cover_letter,
    dropped,
  };
}

/** A stored CV of any version in today's shape (version 1 had flat skills and one-line projects). */
export function normalizeResume(r) {
  const out = { name: '', headline: '', summary: '', experience: [], projects: [], education: [], certifications: [], achievements: [], languages: [], student: false, ...(r || {}) };
  if (Array.isArray(out.skills) && out.skills.every((s) => typeof s === 'string')) out.skills = out.skills.length ? [{ group: 'Skills', items: out.skills }] : [];
  out.skills ||= [];
  out.projects = out.projects.map((p) => ({ title: p.title, place: p.place || null, dates: p.dates || null, context: p.context || null, tools: p.tools || [], bullets: p.bullets || (p.line ? [p.line] : []) }));
  out.experience = out.experience.map((e) => ({ location: null, ...e, bullets: e.bullets || [] }));
  out.education = out.education.map((e) => ({ score: null, ...e }));
  return out;
}

// ---- Keyword match, counted like the fit score ----

const resumeAsText = (r) => {
  const n = normalizeResume(r);
  return [
    n.headline,
    n.summary,
    ...n.skills.map((g) => g.items.join(', ')),
    ...n.experience.flatMap((e) => [e.role, e.firm, ...e.bullets]),
    ...n.projects.flatMap((p) => [p.title, p.tools.join(', '), ...p.bullets]),
    ...n.education.flatMap((e) => [e.degree, e.institution]),
    ...n.certifications,
    ...n.achievements,
  ].join('\n');
};

/**
 * The tools and skills the posting names (taxonomy terms), and how many of them each CV shows.
 * `missing` are ones the person doesn't have at all: tailoring can't and won't add them.
 */
export function keywordMatch(postingText, resumeText, tailoredResume, profile) {
  // Soft skills ("communication") are left out: every CV can claim them, so they prove nothing.
  const asked = [...new Set(findTerms(postingText).filter((t) => t.kind !== 'soft').map((s) => s.label))];
  if (!asked.length) return { asked: [], before: null, after: null, missing: [] };
  const hasSet = (text) => new Set(findTerms(text).map((s) => s.label));
  // What the profile says, for CVs read before the text was kept (and for what she owns at all).
  const profileText = [
    (profile.software || []).map((s) => s.name).join(', '),
    (profile.skills || []).join(', '),
    ...(profile.education || []).map((e) => `${e.degree} ${e.institution}`),
    ...(profile.experience || []).map((e) => `${e.role} ${e.firm} ${e.what || ''}`),
    ...(profile.projects || []).map((p) => `${p.title} ${(p.tools || []).join(' ')} ${p.what || ''}`),
    profile.summary || '',
  ].join('\n');
  const before = hasSet(resumeText || profileText);
  const after = hasSet(resumeAsText(tailoredResume));
  const owned = hasSet(`${resumeText || ''}\n${profileText}`);
  const pct = (set) => Math.round((asked.filter((k) => set.has(k)).length / asked.length) * 100);
  return {
    asked,
    before: pct(before),
    after: pct(after),
    shown: asked.filter((k) => after.has(k)),
    missing: asked.filter((k) => !owned.has(k)),
  };
}

// ---- PDF: real text in one column (ATS systems read it), Helvetica ----

let mupdfPromise = null;
const loadMupdf = () => (mupdfPromise ??= import('mupdf'));

const PAGE = { w: 595, h: 842, margin: 46 };
const INK = [0.07, 0.08, 0.1];
const MUTED = [0.33, 0.36, 0.4];
const ACCENT = [0.12, 0.27, 0.62];

function makeWriter(m) {
  const fonts = { regular: new m.Font('Helvetica'), bold: new m.Font('Helvetica-Bold') };
  const widthOf = (font, text, size) => {
    let w = 0;
    for (const ch of text) w += font.advanceGlyph(font.encodeCharacter(ch));
    return w * size;
  };
  // Characters outside the font (Devanagari, emoji) are swapped for plain ones so nothing breaks.
  const safe = (s) =>
    String(s || '')
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[‐-―−]/g, '-')
      .replace(/[  -   ]/g, ' ')
      .replace(/…/g, '...')
      .replace(/₹\s?/g, 'Rs. ')
      .replace(/[^\x20-\x7e -ÿ•]/g, '');
  // Lines of `text` no wider than `width` (the first line no wider than `first`).
  const wrap = (font, text, size, width, first = width) => {
    const lines = [];
    let line = '';
    // Ordinary spaces only: a no-break space keeps "LinkedIn:" with its link.
    for (const word of safe(text).split(/[ \t\r\n]+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(font, next, size) <= (lines.length ? width : first) || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
    return lines;
  };
  return { fonts, widthOf, wrap, safe };
}

/**
 * Lays blocks out over pages. Returns the pages, each a list of drawing operations. Block:
 * { text, bold, size, color, gap, label (bold lead-in), right (right-aligned on line 1),
 *   bullet, indent, heading, rule }.
 */
function layout(blocks, w, scale) {
  const width = PAGE.w - PAGE.margin * 2;
  const bottom = PAGE.h - PAGE.margin;
  const pages = [[]];
  let y = PAGE.margin;
  const ops = () => pages[pages.length - 1];
  const newPage = () => {
    pages.push([]);
    y = PAGE.margin;
  };
  blocks.forEach((b, i) => {
    const size = (b.size || 10) * scale;
    const lead = size * 1.34;
    if (b.rule) {
      y += 3 * scale;
      ops().push({ rule: true, y });
      y += 5 * scale;
      return;
    }
    // A section heading never sits alone at the foot of a page.
    if (b.heading && y + 70 * scale > bottom) newPage();
    else if (b.gap && y > PAGE.margin) y += b.gap * scale;
    const font = b.bold ? w.fonts.bold : w.fonts.regular;
    const indent = (b.bullet ? 11 : 0) + (b.indent || 0);
    const x = PAGE.margin + indent;
    const labelText = b.label ? `${w.safe(b.label)} ` : '';
    const labelW = labelText ? w.widthOf(w.fonts.bold, labelText, size) : 0;
    const rightSize = size * 0.92;
    const rightW = b.right ? w.widthOf(w.fonts.regular, w.safe(b.right), rightSize) + 14 : 0;
    const lines = w.wrap(font, b.text, size, width - indent, width - indent - labelW - rightW);
    // Keep a two-line entry title with its first bullet: move it whole when it would split.
    const keepNext = b.keepWithNext && blocks[i + 1] ? lead * 2 : 0;
    if (y + lead * Math.min(lines.length, 2) + keepNext > bottom && y > PAGE.margin) newPage();
    lines.forEach((line, li) => {
      if (y + lead > bottom) newPage();
      y += lead;
      if (b.bullet && li === 0) ops().push({ str: '•', bold: false, size, x: PAGE.margin + (b.indent || 0) + 2, y, color: b.color || INK });
      if (li === 0 && labelText) ops().push({ str: labelText, bold: true, size, x, y, color: b.color || INK });
      ops().push({ str: line, bold: b.bold, size, x: li === 0 ? x + labelW : x, y, color: b.color || INK });
      if (b.right && li === 0) ops().push({ str: w.safe(b.right), bold: false, size: rightSize, x: PAGE.w - PAGE.margin - (rightW - 14), y, color: MUTED });
    });
  });
  return pages.filter((p, i) => p.length || i === 0);
}

const clean = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');

function resumeBlocks(resume, contact) {
  const r = normalizeResume(resume);
  const heading = (t) => [{ gap: 9, heading: true, text: t.toUpperCase(), bold: true, size: 10, color: ACCENT }, { rule: true }];
  // The standard student CV: name; one contact line; Professional Summary; Education (marks);
  // Technical Skills in labelled groups; Professional Experience (Role | Firm, dates right);
  // Selected Academic Projects (Title | Place, dates right, a context line, bullets); Certifications.
  const place = [contact.city, contact.state].filter(Boolean).join(', ');
  const nb = ' '; // no-break space
  const contactLine = [clean(contact.website) && `Portfolio:${nb}${clean(contact.website)}`, contact.phone, contact.email, place, clean(contact.linkedin) && `LinkedIn:${nb}${clean(contact.linkedin)}`, clean(contact.github) && `GitHub:${nb}${clean(contact.github)}`]
    .filter(Boolean)
    .join('  |  ');
  const blocks = [{ text: r.name || 'Your name', bold: true, size: 19 }];
  if (contactLine) blocks.push({ text: contactLine, size: 9.2, color: MUTED, gap: 3 });
  if (r.headline) blocks.push({ text: r.headline, size: 10.2, color: MUTED, gap: 2 });

  const summary = () => r.summary && blocks.push(...heading('Professional Summary'), { text: r.summary, size: 10 });
  const skills = () => {
    if (!r.skills.length) return;
    blocks.push(...heading('Technical Skills'));
    r.skills.forEach((g, i) => blocks.push({ label: r.skills.length > 1 || g.group !== 'Skills' ? `${g.group}:` : '', text: g.items.join(', '), gap: i ? 2 : 0 }));
  };
  const education = () => {
    if (!r.education.length) return;
    blocks.push(...heading('Education'));
    r.education.forEach((e, i) => {
      blocks.push({ text: e.degree || e.institution, bold: true, right: e.year || '', gap: i ? 5 : 0, keepWithNext: true });
      const score = e.score ? `${/cgpa|gpa|%|percent|aggregate|grade/i.test(e.score) ? '' : 'Score: '}${e.score}` : '';
      const second = [e.degree ? e.institution : '', score].filter(Boolean).join('  |  ');
      if (second) blocks.push({ text: second, size: 9.6, gap: 1 });
    });
  };
  const experience = () => {
    if (!r.experience.length) return;
    blocks.push(...heading(r.student ? 'Professional Experience and Internships' : 'Professional Experience'));
    r.experience.forEach((e, i) => {
      blocks.push({ text: [e.role, [e.firm, e.location].filter(Boolean).join(', ')].filter(Boolean).join(' | '), bold: true, right: e.dates || '', gap: i ? 6 : 0, keepWithNext: true });
      for (const b of e.bullets) blocks.push({ text: b, bullet: true, gap: 1.5 });
    });
  };
  const projects = () => {
    if (!r.projects.length) return;
    blocks.push(...heading(r.student ? 'Selected Academic Projects' : 'Selected Projects'));
    r.projects.forEach((p, i) => {
      blocks.push({ text: [p.title, p.place].filter(Boolean).join(' | '), bold: true, right: p.dates || '', gap: i ? 6 : 0, keepWithNext: true });
      const sub = [p.context, p.tools.length ? `Tools: ${p.tools.join(', ')}` : ''].filter(Boolean).join('  |  ');
      if (sub) blocks.push({ text: sub, size: 9.5, color: MUTED, gap: 1 });
      for (const b of p.bullets) blocks.push({ text: b, bullet: true, gap: 1.5 });
    });
  };
  const list = (title, items) => {
    if (!items.length) return;
    blocks.push(...heading(title));
    items.forEach((t, i) => blocks.push({ text: t, bullet: true, gap: i ? 1.5 : 0 }));
  };

  summary();
  // A student's education leads; someone with a year of work leads with the work.
  if (r.student) {
    education();
    skills();
    experience();
    projects();
  } else {
    skills();
    experience();
    projects();
    education();
  }
  list('Certifications', r.certifications);
  list('Achievements', r.achievements);
  if (r.languages.length) blocks.push(...heading('Languages'), { text: r.languages.join(', ') });
  return blocks;
}

function letterBlocks(letter, resume, contact, posting) {
  const head = [resume.name, [contact.phone, contact.email].filter(Boolean).join('  |  ')].filter(Boolean);
  const blocks = head.map((t, i) => ({ text: t, bold: i === 0, size: i === 0 ? 14 : 9.5, color: i === 0 ? undefined : MUTED, gap: i ? 2 : 0 }));
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  blocks.push({ text: today, gap: 18, color: MUTED });
  if (posting.company) blocks.push({ text: posting.company, gap: 10 });
  if (posting.title) blocks.push({ text: `Re: ${posting.title}`, bold: true, gap: 2 });
  blocks.push({ text: letter.greeting, gap: 16 });
  for (const p of letter.paragraphs) blocks.push({ text: p, gap: 9, size: 10.5 });
  letter.sign_off.split('\n').forEach((line, i) => blocks.push({ text: line, gap: i ? 0 : 16, size: 10.5 }));
  return blocks;
}

function draw(m, w, pages) {
  const buffer = new m.Buffer();
  const writer = new m.DocumentWriter(buffer, 'pdf', '');
  for (const page of pages) {
    const device = writer.beginPage([0, 0, PAGE.w, PAGE.h]);
    for (const op of page) {
      if (op.rule) {
        const path = new m.Path();
        path.moveTo(PAGE.margin, op.y);
        path.lineTo(PAGE.w - PAGE.margin, op.y);
        device.strokePath(path, new m.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0.6, miterLimit: 10, dashPhase: 0, dashes: null }), [1, 0, 0, 1, 0, 0], m.ColorSpace.DeviceRGB, [0.75, 0.77, 0.8], 1);
        continue;
      }
      const t = new m.Text();
      t.showString(op.bold ? w.fonts.bold : w.fonts.regular, [op.size, 0, 0, -op.size, op.x, op.y], op.str);
      device.fillText(t, [1, 0, 0, 1, 0, 0], m.ColorSpace.DeviceRGB, op.color, 1);
    }
    writer.endPage();
  }
  writer.close();
  return buffer.asUint8Array();
}

// Title, author and keywords in the PDF's own metadata: what an ATS and a file list show.
function withMetadata(m, bytes, meta) {
  const doc = m.Document.openDocument(bytes, 'application/pdf');
  try {
    for (const [k, v] of Object.entries(meta)) if (v) doc.setMetaData(`info:${k}`, String(v).slice(0, 500));
    return Buffer.from(doc.asPDF().saveToBuffer('compress').asUint8Array());
  } finally {
    doc.destroy?.();
  }
}

/**
 * The CV (up to two pages, one when it fits) or the cover letter (one page) as a PDF of real text.
 * Shrinks the type a little, then drops the least important bullets, until it fits.
 */
export async function renderPdf(kind, { resume, letter, contact = {}, posting = {} }) {
  const m = await loadMupdf();
  const w = makeWriter(m);
  const r = normalizeResume(structuredClone(resume));
  const maxPages = kind === 'resume' ? 2 : 1;
  const build = () => (kind === 'resume' ? resumeBlocks(r, contact) : letterBlocks(letter, r, contact, posting));
  let scale = 1;
  let pages = layout(build(), w, scale);
  // A CV that spills a few lines onto page two is set a little smaller to fit on one.
  if (kind === 'resume' && pages.length === 2 && pages[1].length < 14) {
    const tighter = layout(build(), w, 0.92);
    if (tighter.length === 1) {
      pages = tighter;
      scale = 0.92;
    }
  }
  for (let tries = 0; pages.length > maxPages && tries < 30; tries++) {
    if (scale > 0.87) scale -= 0.035;
    else if (kind === 'resume') {
      // Too long even small: the last bullet of the longest entry goes, then the last project.
      const entries = [...r.experience, ...r.projects].filter((e) => e.bullets.length > 2).sort((a, b) => b.bullets.length - a.bullets.length);
      if (entries[0]) entries[0].bullets.pop();
      else if (r.projects.length > 2) r.projects.pop();
      else if (r.achievements.length > 3) r.achievements.pop();
      else break;
    } else break;
    pages = layout(build(), w, scale);
  }
  const bytes = draw(m, w, pages.slice(0, maxPages));
  const skills = r.skills.flatMap((g) => g.items);
  return withMetadata(m, bytes, {
    Title: kind === 'resume' ? `${r.name || 'CV'} - CV${posting.title ? ` - ${posting.title}` : ''}` : `${r.name || ''} - Cover letter${posting.company ? ` - ${posting.company}` : ''}`,
    Author: r.name,
    Subject: kind === 'resume' ? r.headline : posting.title,
    Keywords: kind === 'resume' ? skills.join(', ') : '',
    Creator: 'ArchJobs',
  });
}

/**
 * Writes the CV (and, with a posting, the cover letter) with `ask` (profileBuild.askJson).
 * posting = null makes a general CV.
 * @returns { resume, cover_letter, dropped, match }
 */
// Everything the person's own files and details say: what they really have.
export function ownedTextOf({ profile, resumeText, pages, details }) {
  return [resumeText, JSON.stringify(profile || {}), JSON.stringify(portfolioProjects(pages)), JSON.stringify(cleanDetails(details || {}))].join('\n');
}

// The keyword brief for the prompt: what the posting asks for, in its own words, and whether the
// person has each one. Worked out by code, so a weak model gets it right too.
export function keywordBrief(asked, ownedText, general) {
  if (!asked.length) return null;
  const owned = new Set(findTerms(ownedText).map((t) => t.label));
  const have = asked.filter((k) => owned.has(k.label) && k.kind !== 'qualification');
  const lack = asked.filter((k) => !owned.has(k.label) && k.kind !== 'soft' && k.kind !== 'qualification');
  const fmt = (k) => `"${k.surface || k.label}"${k.required ? ' (required)' : ''}`;
  return [
    general
      ? `ATS keywords: the person's own tools and skills for their field, most important first. Show every one in the skills list, and in a bullet where the sources describe that work: ${have.map(fmt).join(', ')}.`
      : `ATS keywords the posting asks for that the person really has, most important first. Use each one with exactly this wording (ATS systems match words literally): in the skills list, and in a bullet where the sources describe that work: ${have.map(fmt).join(', ') || '(none)'}.`,
    lack.length && !general ? `Asked for but NOT in the person's files, so leave them out entirely: ${lack.map(fmt).join(', ')}.` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export const REVISE_SYSTEM_PROMPT = `${TAILOR_SYSTEM_PROMPT}

You are now revising a CV you wrote. A checker found the problems listed. Fix every one of them
while keeping every hard rule above (never add anything the sources don't have). Reply with the
whole CV again as one JSON object in the same shape, cover_letter included.`;

/**
 * Writes the CV (and, with a posting, the cover letter) with `ask` (profileBuild.askJson), in up to
 * two passes: write, then score with code (lib/atsQuality.js) and send the problems back once.
 * The better-scoring version is kept. posting = null makes a general CV.
 * options: { playbook: true, revise: true } (both on in the app; the evaluation turns them off).
 * @returns { resume, cover_letter, dropped, match: { ...keywordMatch, quality } }
 */
export async function tailor({ profile, resumeText, posting, pages = null, details = null, account = {}, ask, options = {} }) {
  const { playbook = true, revise = true } = options;
  const facts = profileFacts(profile, account, details);
  posting ||= { title: '', company: '', description: '' };
  const general = !posting.title && !posting.description;
  const ownedText = ownedTextOf({ profile, resumeText, pages, details });
  const discipline = disciplineKey(facts.discipline || facts.degree || profile.discipline || '');
  const asked = general ? ownKeywords(ownedText, discipline) : jobKeywords(posting);
  const owned = new Set(findTerms(ownedText).map((t) => t.label));

  const base = tailorUserPrompt({ profile, resumeText, posting, facts, pages });
  const brief = keywordBrief(asked, ownedText, general);
  const examples = playbook ? playbookPrompt(pickExamples({ discipline, labels: [...asked.map((k) => k.label), ...owned] })) : null;
  const user = [base, brief, examples].filter(Boolean).join('\n\n');
  const validate = (v) => checkTailored(v, { profile, resumeText, facts, pages, details });

  const first = await ask({ system: TAILOR_SYSTEM_PROMPT, user, validate, maxOutputTokens: 4_000 });
  const q1 = scoreCv(first.resume, { asked, ownedText, name: facts.name });
  let chosen = first;
  let q = q1;
  let passes = 1;
  if (revise && q1.problems.length) {
    try {
      const previous = { ...first.resume, cover_letter: first.cover_letter };
      for (const k of ['version', 'name', 'education', 'languages', 'student']) delete previous[k];
      const second = await ask({
        system: REVISE_SYSTEM_PROMPT,
        user: `${user}\n\nYour previous CV:\n${JSON.stringify(previous)}\n\nProblems to fix:\n${q1.problems.map((p, i) => `${i + 1}. ${p}`).join('\n')}`,
        validate,
        maxOutputTokens: 4_000,
      });
      passes = 2;
      const q2 = scoreCv(second.resume, { asked, ownedText, name: facts.name });
      if (q2.score >= q1.score) {
        chosen = { ...second, dropped: [...new Set([...first.dropped, ...second.dropped])] };
        q = q2;
      }
    } catch {
      // The revision failed (busy model, bad JSON): the first version stands.
    }
  }
  // Last, with code: posting keywords the person provably has (in their own files) that the CV
  // still doesn't show go into the skills list, in the posting's spelling. Free models sometimes
  // ignore the instruction twice; this makes the keyword match not depend on them.
  if (q.missingOwned.length) {
    const resume = structuredClone(chosen.resume);
    const add = asked.filter((k) => q.missingOwned.includes(k.surface || k.label) && (k.kind === 'tool' || k.kind === 'skill' || k.kind === 'standard'));
    for (const k of add) {
      const groupName = k.kind === 'tool' ? /software|tools?/i : /technical|skills?|design|site/i;
      let group = resume.skills.find((g) => groupName.test(g.group)) || resume.skills.at(-1);
      if (!group) resume.skills.push((group = { group: k.kind === 'tool' ? 'Software' : 'Technical', items: [] }));
      if (!group.items.some((i) => i.toLowerCase() === (k.surface || k.label).toLowerCase())) group.items.push(k.surface || k.label);
    }
    if (add.length) {
      chosen = { ...chosen, resume };
      q = scoreCv(resume, { asked, ownedText, name: facts.name });
    }
  }
  const postingText = posting.description || posting.title || '';
  const match = postingText ? keywordMatch(postingText, resumeText, chosen.resume, profile) : { asked: [], before: null, after: null, missing: [] };
  return {
    ...chosen,
    match: { ...match, quality: { score: q.score, first: q1.score, coverage: q.coverage, passes, missing: q.missingOwned, issues: q.issues.slice(0, 12) } },
  };
}

export const contactOf = (profile, account = {}, details = null) => {
  const f = profileFacts(profile || {}, account, details);
  return { city: f.city, state: f.state, phone: f.phone, email: f.email, linkedin: f.linkedin, website: f.website, github: f.github };
};
