// A CV and cover letter tailored to one posting, from the person's own CV (ARCH in Chrome and the
// job details). The AI reorders and rewords; it does not add. Everything it returns is checked
// against the CV text and the profile, and anything that can't be found there is dropped, with
// the reason shown: a firm, a role, a tool, a project or a number the CV doesn't have never reaches
// the PDF. The keyword match before and after is counted the same way the fit score counts skills
// (shared/skills.js), so it is a real number, not a promise.

import { findSkills } from '../../shared/skills.js';
import { profileFacts } from './fill.js';

export const TAILOR_VERSION = 1;

export const TAILOR_SYSTEM_PROMPT = `You tailor an architecture student's or graduate's CV and write their cover letter for ONE job
posting. You may only reorder, shorten and reword what their CV and profile already say.

Hard rules:
- Never add an employer, role, project, degree, tool, skill, date, number, award or responsibility
  that is not in the CV text or the profile. If the posting asks for something they don't have,
  leave it out: do not hint they have it.
- Use the posting's own words for things they really did (if the CV says "made drawings in Revit"
  and the posting says "Revit documentation", write "Revit documentation" for that work).
- Put what this posting asks for first: order experience bullets, projects and skills by relevance.
- One page: up to 3 experience entries with up to 3 bullets each (under 22 words per bullet), up to
  3 projects, up to 14 skills. Bullets start with a verb. No first person in the CV.
- Cover letter: 3 short paragraphs, 170-230 words in all, first person, plain and specific. Name the
  firm and two things from the posting; back each with a real project or internship from the CV.
  Never use stock lines like "I am writing to express my interest", "I am excited to apply",
  "passionate", "esteemed", "dynamic team", "perfect fit", "hit the ground running".
Reply with one JSON object and nothing else:
{
  "headline": string,                       // e.g. "B.Arch student (2027) · Revit and working drawings"
  "summary": string,                        // 2 sentences for the top of the CV, aimed at this posting
  "skills": string[],
  "experience": [{ "role": string, "firm": string, "dates": string | null, "bullets": string[] }],
  "projects": [{ "title": string, "line": string }],        // line = one sentence on what they did, relevant to the posting
  "education": [{ "degree": string, "institution": string, "year": string | null }],
  "cover_letter": { "greeting": string, "paragraphs": string[], "sign_off": string }
}`;

export function tailorUserPrompt({ profile, resumeText, posting, facts }) {
  const known = {
    name: facts.name,
    stage: profile.stage,
    graduation_year: profile.graduation_year,
    education: profile.education,
    experience: profile.experience,
    software: (profile.software || []).map((s) => s.name),
    skills: profile.skills,
    projects: profile.projects,
    portfolio_projects: profile.portfolio?.projects || [],
    certifications: profile.certifications,
    coa: profile.coa,
  };
  return [
    `Job: ${posting.title || 'unknown title'} at ${posting.company || 'unknown firm'}${posting.location ? `, ${posting.location}` : ''}`,
    `Posting:\n${String(posting.description || '').slice(0, 6_000) || '(no posting text: tailor to the title only)'}`,
    `Profile:\n${JSON.stringify(known)}`,
    resumeText ? `CV text:\n${String(resumeText).slice(0, 8_000)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---- Checks: nothing that isn't in the CV or the profile ----

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

// Every word of `name` (ignoring tiny ones) appears in the source text.
function foundIn(source, name) {
  const words = norm(name)
    .split(' ')
    .filter((w) => w.length > 2 && !['the', 'and', 'pvt', 'ltd', 'llp', 'inc', 'private', 'limited'].includes(w));
  if (!words.length) return false;
  return words.every((w) => source.includes(` ${w} `) || source.includes(` ${w}s `));
}

// Numbers ("30%", "12 drawings", "2024") a bullet may use: only ones the CV itself has.
const numbersIn = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(',', ''));

// Lines no cover letter needs.
const STOCK = /I am writing to (express|apply)|I am (excited|thrilled|delighted) to apply|passionate|esteemed|dynamic team|perfect fit|hit the ground running|team player|go-getter|synergy|I believe I would be a great/i;

/**
 * Keeps only what the CV and profile back up. Returns { resume, cover_letter, dropped } or null when
 * the reply is not usable at all.
 */
export function checkTailored(value, { profile, resumeText, facts }) {
  if (!value || typeof value !== 'object') return null;
  const source = ` ${norm([resumeText, JSON.stringify(profile.experience), JSON.stringify(profile.education), JSON.stringify(profile.projects), (profile.portfolio?.projects || []).join(' '), (profile.software || []).map((s) => s.name).join(' '), (profile.skills || []).join(' '), (profile.certifications || []).join(' ')].join(' '))} `;
  const cvNumbers = new Set(numbersIn(`${resumeText} ${JSON.stringify(profile)}`));
  const dropped = [];
  const keep = (ok, what) => {
    if (!ok) dropped.push(what);
    return ok;
  };

  const skills = [...new Set(strs(value.skills, 20, 40))].filter((s) => keep(foundIn(source, s), `skill "${s}"`)).slice(0, 14);
  const experience = (Array.isArray(value.experience) ? value.experience : [])
    .slice(0, 4)
    .map((e) => ({ role: str(e?.role, 80), firm: str(e?.firm, 100), dates: str(e?.dates, 40) || null, bullets: strs(e?.bullets, 4, 220) }))
    .filter((e) => keep(e.firm && foundIn(source, e.firm), `employer "${e.firm}"`) && keep(!e.role || foundIn(source, e.role), `role "${e.role}"`))
    .map((e) => ({
      ...e,
      dates: e.dates && numbersIn(e.dates).every((n) => cvNumbers.has(n)) ? e.dates : null,
      bullets: e.bullets.filter((b) => keep(numbersIn(b).every((n) => cvNumbers.has(n)), `a line with a number the CV doesn't have ("${b.slice(0, 50)}…")`)).slice(0, 3),
    }))
    .slice(0, 3);
  const projects = (Array.isArray(value.projects) ? value.projects : [])
    .map((p) => ({ title: str(p?.title, 100), line: str(p?.line, 220) }))
    .filter((p) => p.title && keep(foundIn(source, p.title), `project "${p.title}"`) && keep(numbersIn(p.line).every((n) => cvNumbers.has(n)), `a project line with a number the CV doesn't have`))
    .slice(0, 3);
  // Education always comes from the profile as read, never from the reply.
  const education = (profile.education || []).slice(0, 3).map((e) => ({ degree: e.degree, institution: e.institution, year: e.year ? String(e.year) : null }));

  const summary = str(value.summary, 400);
  const headline = str(value.headline, 120);
  if (!summary && !experience.length && !projects.length) return null;

  const letter = value.cover_letter && typeof value.cover_letter === 'object' ? value.cover_letter : {};
  // Stock sentences are cut out rather than rejecting the whole letter.
  const paragraphs = strs(letter.paragraphs, 4, 1_200)
    .map((p) =>
      p
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => keep(!STOCK.test(sentence), `stock line "${sentence.slice(0, 50)}…"`))
        .join(' '),
    )
    .filter(Boolean);
  const cover_letter = paragraphs.length
    ? { greeting: str(letter.greeting, 80) || 'Dear Hiring Team,', paragraphs, sign_off: str(letter.sign_off, 80) || `Regards,\n${facts.name || ''}`.trim() }
    : null;

  return {
    resume: { name: facts.name, headline, summary, skills, experience, projects, education },
    cover_letter,
    dropped,
  };
}

// ---- Keyword match, counted like the fit score ----

const resumeAsText = (r) =>
  [r.headline, r.summary, r.skills.join(', '), ...r.experience.flatMap((e) => [e.role, e.firm, ...e.bullets]), ...r.projects.flatMap((p) => [p.title, p.line]), ...r.education.flatMap((e) => [e.degree, e.institution])].join('\n');

/**
 * The tools and skills the posting names (taxonomy terms), and how many of them each CV shows.
 * `missing` are ones the person doesn't have at all: tailoring can't and won't add them.
 */
export function keywordMatch(postingText, resumeText, tailoredResume, profile) {
  const asked = [...new Set(findSkills(postingText).map((s) => s.label))];
  if (!asked.length) return { asked: [], before: null, after: null, missing: [] };
  const has = (text) => new Set(findSkills(text).map((s) => s.label));
  // What the profile says, for CVs read before the text was kept (and for what she owns at all).
  const profileText = [
    (profile.software || []).map((s) => s.name).join(', '),
    (profile.skills || []).join(', '),
    ...(profile.education || []).map((e) => `${e.degree} ${e.institution}`),
    ...(profile.experience || []).map((e) => `${e.role} ${e.firm} ${e.what || ''}`),
    ...(profile.projects || []).map((p) => `${p.title} ${(p.tools || []).join(' ')}`),
    profile.summary || '',
  ].join('\n');
  const before = has(resumeText || profileText);
  const after = has(resumeAsText(tailoredResume));
  const owned = has(`${resumeText || ''}\n${profileText}`);
  const pct = (set) => Math.round((asked.filter((k) => set.has(k)).length / asked.length) * 100);
  return {
    asked,
    before: pct(before),
    after: pct(after),
    shown: asked.filter((k) => after.has(k)),
    missing: asked.filter((k) => !owned.has(k)),
  };
}

// ---- PDF: one A4 page of real text (ATS systems read it), Helvetica ----

let mupdfPromise = null;
const loadMupdf = () => (mupdfPromise ??= import('mupdf'));

const PAGE = { w: 595, h: 842, margin: 44 };

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
      .replace(/[–—]/g, '-')
      .replace(/•/g, '-')
      .replace(/[^\x20-\x7e -ÿ₹]/g, '');
  const wrap = (font, text, size, width) => {
    const lines = [];
    let line = '';
    for (const word of safe(text).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (widthOf(font, next, size) <= width || !line) line = next;
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

// Lays out blocks; returns the y it ended at (or Infinity when it overflowed and `draw` is false).
function layout(blocks, { m, w, device, scale }) {
  const width = PAGE.w - PAGE.margin * 2;
  let y = PAGE.margin;
  const text = (str, { bold = false, size = 10, x = PAGE.margin, color = [0.07, 0.08, 0.1] } = {}) => {
    if (device) {
      const t = new m.Text();
      t.showString(bold ? w.fonts.bold : w.fonts.regular, [size, 0, 0, -size, x, y], w.safe(str));
      device.fillText(t, [1, 0, 0, 1, 0, 0], m.ColorSpace.DeviceRGB, color, 1);
    }
  };
  for (const b of blocks) {
    const size = (b.size || 10) * scale;
    const lead = size * 1.32;
    if (b.gap) y += b.gap * scale;
    if (b.rule) {
      y += 3.5 * scale; // clear of the heading's letters
      if (device) {
        const path = new m.Path();
        path.moveTo(PAGE.margin, y);
        path.lineTo(PAGE.w - PAGE.margin, y);
        device.strokePath(path, new m.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0.6, miterLimit: 10, dashPhase: 0, dashes: null }), [1, 0, 0, 1, 0, 0], m.ColorSpace.DeviceRGB, [0.75, 0.77, 0.8], 1);
      }
      y += 6 * scale;
      continue;
    }
    const indent = b.bullet ? 12 : 0;
    const font = b.bold ? w.fonts.bold : w.fonts.regular;
    const lines = w.wrap(font, b.text, size, width - indent);
    lines.forEach((line, i) => {
      y += lead;
      if (b.bullet && i === 0) text('-', { size, x: PAGE.margin + 2, color: b.color });
      text(line, { bold: b.bold, size, x: PAGE.margin + indent, color: b.color });
      // Right-aligned extra on the first line (dates).
      if (b.right && i === 0) text(b.right, { size: size * 0.92, x: PAGE.w - PAGE.margin - w.widthOf(w.fonts.regular, w.safe(b.right), size * 0.92), color: [0.35, 0.38, 0.42] });
    });
  }
  return y;
}

function resumeBlocks(resume, contact) {
  const muted = [0.35, 0.38, 0.42];
  const heading = (t) => [{ gap: 8, text: t.toUpperCase(), bold: true, size: 9.5, color: [0.15, 0.32, 0.75] }, { rule: true }];
  const contactLine = [contact.city, contact.phone, contact.email, contact.linkedin?.replace(/^https?:\/\/(www\.)?/, ''), contact.website?.replace(/^https?:\/\/(www\.)?/, '')].filter(Boolean).join('  |  ');
  const blocks = [{ text: resume.name || 'Your name', bold: true, size: 18 }];
  if (resume.headline) blocks.push({ text: resume.headline, size: 10.5, color: muted, gap: 2 });
  if (contactLine) blocks.push({ text: contactLine, size: 9, color: muted, gap: 2 });
  if (resume.summary) blocks.push(...heading('Profile'), { text: resume.summary });
  if (resume.experience.length) {
    blocks.push(...heading('Experience'));
    for (const e of resume.experience) {
      blocks.push({ text: `${e.role}${e.firm ? `, ${e.firm}` : ''}`, bold: true, right: e.dates || '', gap: 3 });
      for (const b of e.bullets) blocks.push({ text: b, bullet: true });
    }
  }
  if (resume.projects.length) {
    blocks.push(...heading('Projects'));
    for (const p of resume.projects) blocks.push({ text: p.title, bold: true, gap: 3 }, { text: p.line });
  }
  if (resume.skills.length) blocks.push(...heading('Skills'), { text: resume.skills.join('  ·  ') });
  if (resume.education.length) {
    blocks.push(...heading('Education'));
    for (const e of resume.education) blocks.push({ text: [e.degree, e.institution].filter(Boolean).join(', '), right: e.year || '', gap: 2 });
  }
  return blocks;
}

function letterBlocks(letter, resume, contact, posting) {
  const muted = [0.35, 0.38, 0.42];
  const head = [resume.name, [contact.phone, contact.email].filter(Boolean).join('  |  ')].filter(Boolean);
  const blocks = head.map((t, i) => ({ text: t, bold: i === 0, size: i === 0 ? 14 : 9.5, color: i === 0 ? undefined : muted, gap: i ? 2 : 0 }));
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  blocks.push({ text: today, gap: 18, color: muted });
  if (posting.company) blocks.push({ text: posting.company, gap: 10 });
  if (posting.title) blocks.push({ text: `Re: ${posting.title}`, bold: true, gap: 2 });
  blocks.push({ text: letter.greeting, gap: 16 });
  for (const p of letter.paragraphs) blocks.push({ text: p, gap: 9, size: 10.5 });
  letter.sign_off.split('\n').forEach((line, i) => blocks.push({ text: line, gap: i ? 0 : 16, size: 10.5 }));
  return blocks;
}

/** One-page PDF of real text. Shrinks the type a little, then drops bullets, until it fits. */
export async function renderPdf(kind, { resume, letter, contact = {}, posting = {} }) {
  const m = await loadMupdf();
  const w = makeWriter(m);
  let r = structuredClone(resume);
  let blocks = kind === 'resume' ? resumeBlocks(r, contact) : letterBlocks(letter, r, contact, posting);
  let scale = 1;
  const bottom = PAGE.h - PAGE.margin;
  for (let tries = 0; layout(blocks, { m, w, device: null, scale }) > bottom && tries < 12; tries++) {
    if (scale > 0.86) scale -= 0.035;
    else if (kind === 'resume') {
      // Too long even small: the last bullet of the longest entry goes.
      const longest = [...r.experience].sort((a, b) => b.bullets.length - a.bullets.length)[0];
      if (longest?.bullets.length > 1) longest.bullets.pop();
      else if (r.projects.length > 1) r.projects.pop();
      else break;
      blocks = resumeBlocks(r, contact);
    } else break;
  }
  const buffer = new m.Buffer();
  const writer = new m.DocumentWriter(buffer, 'pdf', '');
  const device = writer.beginPage([0, 0, PAGE.w, PAGE.h]);
  layout(blocks, { m, w, device, scale });
  writer.endPage();
  writer.close();
  return Buffer.from(buffer.asUint8Array());
}

/**
 * Tailors the CV and letter for one posting with `ask` (profileBuild.askJson).
 * @returns { resume, cover_letter, dropped, match }
 */
export async function tailor({ profile, resumeText, posting, account = {}, ask }) {
  const facts = profileFacts(profile, account);
  const checked = await ask({
    system: TAILOR_SYSTEM_PROMPT,
    user: tailorUserPrompt({ profile, resumeText, posting, facts }),
    validate: (v) => checkTailored(v, { profile, resumeText, facts }),
    maxOutputTokens: 2_500,
  });
  return { ...checked, match: keywordMatch(posting.description || posting.title || '', resumeText, checked.resume, profile) };
}

export const contactOf = (profile, account = {}) => {
  const f = profileFacts(profile, account);
  return { city: f.city, phone: f.phone, email: f.email, linkedin: f.linkedin, website: f.website };
};
