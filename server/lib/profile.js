// A person's profile as read from their CV and portfolio: the prompts that extract it, the checks
// on the models' answers, how the two sources merge, and the portfolio rubric. The AI calls
// themselves are in profileBuild.js; the fit score that uses the profile is in fit.js.
//
// Profile shape (stored as JSON in profiles.profile):
// {
//   name, stage: student | graduate | experienced, graduation_year, experience_months,
//   education: [{ degree, institution, year }],
//   experience: [{ role, firm, months, what }],
//   software: [{ name, level: shown | listed }],      shown = seen in the portfolio
//   skills: [string],                                  canonical taxonomy labels where possible
//   projects: [{ title, typology, scale, role, tools, drawings, academic }],
//   typologies: [string], cities: [string], coa: bool, certifications: [string], summary,
//   contact: { email, phone, linkedin, website, city, address, date_of_birth },   for application forms (lib/fill.js)
//   portfolio: { pages, read_pages, typologies, drawing_types, software, rubric, strengths, weaknesses }
// }

import { canonicalSkill, canonicalTypology, DRAWING_TYPES, findSkills, findTypologies } from '../../shared/skills.js';

export const PROFILE_VERSION = 1;

export const RESUME_SYSTEM_PROMPT = `You read the CV (resume) of a student or fresh graduate in India (architecture, interior design,
civil, mechanical or any other engineering or design field) and turn it into structured data for
matching with job postings. Copy only what the CV states; never invent software, projects or
experience. Reply with one JSON object and nothing else:
{
  "name": string | null,
  "discipline": string | null,                       // the field they study or work in: "Architecture", "Interior design", "Civil engineering", "Mechanical engineering"...
  "stage": "student" | "graduate" | "experienced",   // student = still studying; experienced = 2+ years of paid work after graduating
  "graduation_year": integer | null,                 // year of (expected) graduation from their main degree
  "experience_months": integer,                      // paid or internship work in their field, total months (0 if none)
  "education": [{ "degree": string, "institution": string, "year": integer | null, "score": string | null }],  // every level the CV lists (degree, Class XII, Class X); score = marks as written ("84.35%", "8.2 CGPA")
  "experience": [{ "role": string, "firm": string, "months": integer | null, "what": string }],  // up to 8, what = up to 3 sentences of what they did, with every tool, number and result the CV gives
  "software": string[],                              // every tool named (Revit, AutoCAD, SketchUp, SolidWorks, ANSYS, STAAD.Pro, ETABS, Primavera, MATLAB...)
  "skills": string[],                                // up to 15 things they can do, as written (working drawings, structural analysis, GD&T, site supervision...)
  "projects": [{ "title": string, "typology": string, "scale": string | null, "role": string | null, "tools": string[], "academic": boolean, "what": string | null }],  // up to 10; what = 1-2 sentences of what they did and found, as the CV says
  "cities": string[],                                // cities they live in or are open to, if stated
  "coa": boolean,                                    // registered with the Council of Architecture, if stated
  "certifications": string[],
  "achievements": string[],                          // up to 6: awards, competitions, rankings, publications, positions of responsibility, as written
  "summary": string,                                 // 1-2 plain sentences on who they are and what they are strongest at
  "contact": {                                       // exactly as written on the CV, null when absent
    "email": string | null,
    "phone": string | null,                          // with country code if written
    "linkedin": string | null,                       // profile URL
    "website": string | null,                        // portfolio or personal site URL (Behance, Issuu, own site)
    "city": string | null,                           // the city they live in now
    "address": string | null,                        // postal address if written, one line
    "date_of_birth": string | null                   // YYYY-MM-DD if written
  }
}`;

export const PORTFOLIO_PAGES_SYSTEM_PROMPT = `You review pages of a student's portfolio or project report (images): usually architecture or interiors, sometimes civil,
mechanical or another engineering field. For each page, say what it
shows so the work can be matched with job postings. Judge only what is visible. Reply with one
JSON object and nothing else:
{
  "pages": [{
    "page": integer,                      // the page number given with the image
    "project": string | null,             // project title on the page, if any
    "typology": string | null,            // residential, commercial, hospitality, institutional, healthcare, interiors, landscape, urban design, industrial, transport, conservation, or null
    "scale": "small" | "medium" | "large" | null,   // small = a house or a room; large = a campus, tower or masterplan
    "drawings": string[],                 // which of: ${DRAWING_TYPES.join(', ')}
    "software": string[],                 // tools that clearly made this page (Revit, AutoCAD, SketchUp, Rhino, Lumion, Enscape, Photoshop, InDesign, hand drawing...), only if evident
    "process": boolean,                   // true when the page shows how the design developed (sketches, iterations, diagrams, site analysis), not just a final image
    "technical": boolean,                 // true when the drawings are technical and annotated (dimensions, materials, details, sections with notes)
    "quality": integer 1-5,               // graphic quality: layout, hierarchy, legibility, consistency
    "role": string | null,                // the student's stated role on the project, if written ("team of 3, I did the sections")
    "note": string                        // one line: what stands out, good or weak
  }]
}
List every page you were given, in order.`;

export const PORTFOLIO_SUMMARY_SYSTEM_PROMPT = `You are a senior architect who reviews student portfolios for internship and fresher hiring in
India. From the page-by-page notes you are given, write the review a hiring architect would give.
Be specific and fair; name the strongest projects. Reply with one JSON object and nothing else:
{
  "strengths": string[],       // up to 5, each under 25 words
  "weaknesses": string[],      // up to 5 things a hiring architect would notice are missing or weak, each under 25 words
  "improvements": string[],    // up to 5 concrete changes to make, each under 30 words, most valuable first
  "best_for": string[],        // up to 4 kinds of role this portfolio suits best (e.g. "interior design internship", "BIM modeller")
  "summary": string            // 2 sentences: who this designer is from the work shown
}`;

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const int = (v, { min = 0, max = 10_000 } = {}) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : null;
};
const strList = (v, max, each = 60) =>
  Array.isArray(v) ? [...new Set(v.map((s) => str(s, each)).filter(Boolean))].slice(0, max) : [];
const dedupeCanonical = (names) => [...new Set(names.map(canonicalSkill).filter(Boolean))];

export const CONTACT_KEYS = ['email', 'phone', 'linkedin', 'website', 'city', 'address', 'date_of_birth'];
const EMPTY_CONTACT = Object.fromEntries(CONTACT_KEYS.map((k) => [k, null]));

// Contact details, tidied: a usable email, digits (and a leading +) in the phone, full URLs.
export function validateContact(value) {
  const c = { ...EMPTY_CONTACT };
  if (!value || typeof value !== 'object') return c;
  const email = str(value.email, 120).toLowerCase();
  c.email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
  const phone = str(value.phone, 40).replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  c.phone = phone.replace(/\D/g, '').length >= 7 ? phone : null;
  for (const k of ['linkedin', 'website']) {
    let url = str(value[k], 200);
    if (url && !/^https?:\/\//i.test(url)) url = `https://${url.replace(/^\/+/, '')}`;
    c[k] = /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url) ? url : null;
  }
  c.city = str(value.city, 60) || null;
  c.address = str(value.address, 200) || null;
  const dob = str(value.date_of_birth, 10);
  c.date_of_birth = /^\d{4}-\d{2}-\d{2}$/.test(dob) ? dob : null;
  return c;
}

export function validateResumeProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stage = ['student', 'graduate', 'experienced'].includes(value.stage) ? value.stage : 'student';
  const education = (Array.isArray(value.education) ? value.education : [])
    .map((e) => ({ degree: str(e?.degree, 80), institution: str(e?.institution, 120), year: int(e?.year, { min: 1980, max: 2040 }), score: str(e?.score, 30) || null }))
    .filter((e) => e.degree || e.institution)
    .slice(0, 6);
  const experience = (Array.isArray(value.experience) ? value.experience : [])
    .map((e) => ({ role: str(e?.role, 80), firm: str(e?.firm, 100), months: int(e?.months, { max: 600 }), what: str(e?.what, 600) }))
    .filter((e) => e.role || e.firm)
    .slice(0, 8);
  const projects = (Array.isArray(value.projects) ? value.projects : [])
    .map((p) => ({
      title: str(p?.title, 100),
      typology: canonicalTypology(p?.typology) || null,
      scale: str(p?.scale, 40) || null,
      role: str(p?.role, 100) || null,
      tools: dedupeCanonical(strList(p?.tools, 8)),
      academic: p?.academic !== false,
      what: str(p?.what, 400) || null,
    }))
    .filter((p) => p.title)
    .slice(0, 10);
  const summary = str(value.summary, 400);
  if (!summary && !education.length && !projects.length) return null;
  return {
    name: str(value.name, 80) || null,
    discipline: str(value.discipline, 60) || null,
    stage,
    graduation_year: int(value.graduation_year, { min: 1980, max: 2040 }),
    experience_months: int(value.experience_months, { max: 600 }) ?? 0,
    education,
    experience,
    software: dedupeCanonical(strList(value.software, 25)).map((name) => ({ name, level: 'listed' })),
    skills: dedupeCanonical(strList(value.skills, 15, 80)),
    projects,
    cities: strList(value.cities, 8),
    coa: value.coa === true,
    certifications: strList(value.certifications, 8, 80),
    achievements: strList(value.achievements, 6, 200),
    summary,
    contact: validateContact(value.contact),
  };
}

export function validatePortfolioPages(value, expectedPages) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.pages)) return null;
  const known = new Set(expectedPages);
  const pages = value.pages
    .map((p) => ({
      page: int(p?.page, { min: 1, max: 500 }),
      project: str(p?.project, 100) || null,
      typology: canonicalTypology(p?.typology) || null,
      scale: ['small', 'medium', 'large'].includes(p?.scale) ? p.scale : null,
      drawings: strList(p?.drawings, 8, 30).map((d) => d.toLowerCase()).filter((d) => DRAWING_TYPES.includes(d)),
      software: dedupeCanonical(strList(p?.software, 6)),
      process: p?.process === true,
      technical: p?.technical === true,
      quality: int(p?.quality, { min: 1, max: 5 }) ?? 3,
      role: str(p?.role, 120) || null,
      note: str(p?.note, 200),
    }))
    .filter((p) => p.page != null && known.has(p.page));
  // The model must have looked at most of the pages it was given.
  return pages.length >= Math.ceil(expectedPages.length / 2) ? pages : null;
}

export function validatePortfolioSummary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const summary = str(value.summary, 500);
  if (!summary) return null;
  return {
    strengths: strList(value.strengths, 5, 200),
    weaknesses: strList(value.weaknesses, 5, 200),
    improvements: strList(value.improvements, 5, 240),
    best_for: strList(value.best_for, 4, 80),
    summary,
  };
}

// The portfolio rubric, worked out from the page notes (not asked of the model, so it is the same
// standard for everyone). Each score is 0-100.
export function portfolioRubric(pages, totalPages) {
  const n = pages.length;
  if (!n) return null;
  const typologies = new Set(pages.map((p) => p.typology).filter(Boolean));
  const scales = new Set(pages.map((p) => p.scale).filter(Boolean));
  const drawings = new Set(pages.flatMap((p) => p.drawings));
  const technicalKinds = ['plan', 'section', 'elevation', 'detail', 'working drawing'].filter((d) => drawings.has(d));
  const software = new Set(pages.flatMap((p) => p.software));
  const avgQuality = pages.reduce((s, p) => s + p.quality, 0) / n;
  const processShare = pages.filter((p) => p.process).length / n;
  const technicalShare = pages.filter((p) => p.technical).length / n;
  const pct = (x) => Math.max(0, Math.min(100, Math.round(x)));
  // 15-35 pages is the range reviewers like; shorter is fine, very long gets marked down.
  const concision = totalPages <= 35 ? 100 : totalPages <= 50 ? 75 : totalPages <= 80 ? 50 : 25;
  return {
    range: pct((Math.min(typologies.size, 4) / 4) * 60 + (Math.min(scales.size, 3) / 3) * 40),
    process: pct(processShare * 100 * 2.5), // a quarter of the pages showing process = full marks
    technical: pct((technicalKinds.length / 5) * 50 + technicalShare * 100 * 1.5 * 0.5),
    presentation: pct(((avgQuality - 1) / 4) * 100),
    concision,
    bim: pct((software.has('Revit') ? 60 : 0) + (software.has('ArchiCAD') ? 30 : 0) + (drawings.has('working drawing') ? 20 : 0) + (drawings.has('detail') ? 20 : 0)),
  };
}

// One profile from the CV reading, the portfolio page notes and the portfolio review (any may be
// missing). Software seen in the portfolio counts as "shown", which the fit score trusts more.
export function mergeProfile({ resume = null, pages = null, review = null, totalPages = 0 } = {}) {
  const profile = resume
    ? structuredClone(resume)
    : { name: null, discipline: null, stage: 'student', graduation_year: null, experience_months: 0, education: [], experience: [], software: [], skills: [], projects: [], cities: [], coa: false, certifications: [], achievements: [], summary: '', contact: { ...EMPTY_CONTACT } };
  profile.contact = { ...EMPTY_CONTACT, ...(profile.contact || {}) };
  const software = new Map(profile.software.map((s) => [s.name, s.level]));
  const typologies = new Set(profile.projects.map((p) => p.typology).filter(Boolean));
  let portfolio = null;
  if (pages?.length) {
    for (const p of pages) {
      for (const s of p.software) software.set(s, 'shown');
      if (p.typology) typologies.add(p.typology);
    }
    // Skills a portfolio proves by showing the drawings.
    const drawings = new Set(pages.flatMap((p) => p.drawings));
    const proven = [];
    if (drawings.has('working drawing')) proven.push('Working drawings');
    if (drawings.has('detail')) proven.push('Detailing');
    if (drawings.has('render') || drawings.has('3d view')) proven.push('Rendering', '3D modelling');
    if (drawings.has('physical model')) proven.push('Model making');
    if (drawings.has('sketch')) proven.push('Hand sketching');
    if (drawings.has('site analysis')) proven.push('Site analysis');
    for (const s of proven) if (!profile.skills.includes(s)) profile.skills.push(s);
    for (const p of pages) {
      for (const s of findSkills(p.note).filter((x) => x.kind === 'skill').map((x) => x.label)) if (!profile.skills.includes(s)) profile.skills.push(s);
    }
    portfolio = {
      pages: totalPages,
      read_pages: pages.length,
      typologies: [...new Set(pages.map((p) => p.typology).filter(Boolean))],
      drawing_types: [...drawings],
      software: [...new Set(pages.flatMap((p) => p.software))],
      rubric: portfolioRubric(pages, totalPages),
      projects: [...new Set(pages.map((p) => p.project).filter(Boolean))].slice(0, 15),
      ...(review || { strengths: [], weaknesses: [], improvements: [], best_for: [], summary: '' }),
    };
  }
  // Building types only: BIM and sustainability are ways of working, not kinds of project.
  for (const t of findTypologies(profile.summary)) if (t !== 'BIM' && t !== 'Sustainability') typologies.add(t);
  profile.software = [...software].map(([name, level]) => ({ name, level })).sort((a, b) => (a.level === b.level ? a.name.localeCompare(b.name) : a.level === 'shown' ? -1 : 1));
  profile.skills = profile.skills.slice(0, 25);
  profile.typologies = [...typologies];
  profile.portfolio = portfolio;
  return profile;
}

// Edits the person makes to the extracted profile (chips on the Profile tab).
export function applyProfileEdits(profile, edits = {}) {
  const next = structuredClone(profile);
  if (Array.isArray(edits.software)) {
    const shown = new Set(profile.software.filter((s) => s.level === 'shown').map((s) => s.name));
    next.software = dedupeCanonical(strList(edits.software, 30)).map((name) => ({ name, level: shown.has(name) ? 'shown' : 'listed' }));
  }
  if (Array.isArray(edits.skills)) next.skills = dedupeCanonical(strList(edits.skills, 25, 80));
  if (Array.isArray(edits.cities)) next.cities = strList(edits.cities, 8);
  if (Array.isArray(edits.typologies)) next.typologies = [...new Set(strList(edits.typologies, 10, 30).map(canonicalTypology).filter(Boolean))];
  if (['student', 'graduate', 'experienced'].includes(edits.stage)) next.stage = edits.stage;
  if (edits.experience_months != null) next.experience_months = int(edits.experience_months, { max: 600 }) ?? next.experience_months;
  if (typeof edits.coa === 'boolean') next.coa = edits.coa;
  if (edits.name !== undefined) next.name = str(edits.name, 80) || null;
  if (edits.contact && typeof edits.contact === 'object') next.contact = validateContact({ ...(profile.contact || {}), ...edits.contact });
  return next;
}
