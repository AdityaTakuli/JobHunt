// How well a person's profile (CV + portfolio) fits one job: the ranking an applicant tracking
// system does, done openly. No AI call per job, so every job in the feed gets a score at once and
// the same profile and posting always give the same answer.
//
// The score follows what hiring systems and recruiters actually weigh (see docs/PRD.md, "Fit"):
//   1. knockouts first: years of experience asked, licence, location;
//   2. coverage of the posting's required skills and tools (the biggest factor);
//   3. tools the posting names, trusting work shown in the portfolio over a line on the CV;
//   4. level fit (internship / fresher / experienced vs where the person is);
//   5. does the portfolio show the kind of work the role is about;
//   6. nice-to-haves.
// Each score comes with what matched, what is missing, and what to do about it.

import { findSkills, findTypologies, SKILL_GROUPS, skillKind } from '../../shared/skills.js';

export const FIT_VERSION = 1;

const PATTERNS = new Map(SKILL_GROUPS.flatMap((g) => g.items));
const findSkillPattern = (label) => PATTERNS.get(label) || null;

const WEIGHTS = { required: 40, software: 20, level: 15, portfolio: 15, preferred: 10 };

// Words near a skill that make it a hard requirement in a posting.
const REQUIRED_CUE = /\b(must|required?|mandatory|essential|proficien\w*|expert\w*|strong|hands-on|minimum|should have|need(s|ed)? to)\b/i;

const IMPROVEMENTS = {
  Revit: 'Model one project in Revit and show a sheet with its plan, section and a schedule; name Revit on that page and in the CV.',
  AutoCAD: 'Show one set of AutoCAD working drawings (plan with dimensions, a wall section) in the portfolio.',
  SketchUp: 'Add a SketchUp massing or interior model page and list SketchUp under tools.',
  Rhino: 'Show one Rhino model (a form study or a façade) and name it on the page.',
  Grasshopper: 'Add a page with a Grasshopper definition and the geometry it drives.',
  Navisworks: 'Show a clash report or a federated model view from Navisworks, or do a short course and list it.',
  Lumion: 'Re-render one project in Lumion and credit the tool on the page.',
  Enscape: 'Re-render one project in Enscape and credit the tool on the page.',
  'V-Ray': 'Add one V-Ray render with the tool credited.',
  Photoshop: 'Credit Photoshop on a post-produced view or diagram page.',
  InDesign: 'Lay out the portfolio in InDesign and say so in the CV tools list.',
  'Working drawings': 'Add a working-drawing set: dimensioned plan, wall section, door/window schedule.',
  'Construction drawings': 'Add construction drawings (GFC-style sheets) from one project, even an academic one.',
  Detailing: 'Add a details page: a wall section, a staircase or a joinery detail at 1:20 or larger.',
  '3D modelling': 'Show 3D views with the tool named, not only renders.',
  'BIM modelling': 'Show a Revit model page (plan, section, 3D cut) and say the LOD you worked to.',
  'BIM coordination': 'Mention any model coordination or clash checking you did; show a Navisworks view if you can.',
  'Clash detection': 'Show a clash report or describe a coordination exercise you did.',
  'Revit families': 'Add a page with a Revit family you built (a door, a window, a furniture piece).',
  LOD: 'State the LOD (300/350) of your Revit model on its page.',
  Rendering: 'Add two or three strong renders with the tool credited.',
  'Interior design': 'Add an interior project: a plan with furniture layout, a section, a material board.',
  Landscape: 'Add a landscape or site-planning page with planting and levels.',
  'Urban design': 'Add a masterplan or urban study page with site analysis.',
  'Site visits': 'List site visits or supervision in the CV with what you checked on site.',
  'Approval drawings': 'Mention any municipal/sanction drawing work in the CV; show a sheet if you have one.',
  'BOQ / estimation': 'Add a short BOQ or cost estimate you prepared, even for a studio project.',
  'Hand sketching': 'Add a page of hand sketches and concept studies.',
  'Model making': 'Add photos of a physical model with the process.',
  'Sustainable design': 'Add a climate/sustainability diagram page (sun path, ventilation, materials).',
  'COA registration': 'Register with the Council of Architecture once eligible, and state it on the CV.',
  Portfolio: 'Attach the portfolio link in the CV header.',
};

// Requirements a posting states: taxonomy items, each required or preferred.
export function jobRequirements(job, analysis = null) {
  const text = `${job.title || ''}\n${job.description || ''}`;
  const found = findSkills(text).filter((s) => s.kind !== 'ask' || ['COA registration', 'Portfolio', 'M.Arch'].includes(s.label));
  const must = new Set((analysis?.must_have || []).flatMap((m) => findSkills(m).map((s) => s.label)));
  const nice = new Set((analysis?.nice_to_have || []).flatMap((m) => findSkills(m).map((s) => s.label)));
  const items = found.map(({ label, kind }) => {
    let required;
    if (must.has(label)) required = true;
    else if (nice.has(label)) required = false;
    else if (kind === 'tool' || label === 'COA registration') required = true; // a tool a posting names is what the work is done in; a licence is a gate
    else required = requiredInText(text, label);
    return { label, kind, required };
  });
  // The classifier's software list covers tools the taxonomy does not know.
  for (const s of job.software || []) if (!items.some((i) => i.label.toLowerCase() === String(s).toLowerCase())) items.push({ label: String(s), kind: 'tool', required: true });
  return items;
}

// Whether the sentence mentioning a skill carries a "must have" cue.
function requiredInText(text, label) {
  const group = findSkillPattern(label);
  if (!group) return false;
  for (const sentence of text.split(/[.\n•;]/)) if (group.test(sentence) && REQUIRED_CUE.test(sentence)) return true;
  return false;
}

const norm = (s) => String(s || '').toLowerCase();

function hasSkill(profile, label) {
  const l = norm(label);
  const sw = profile.software.find((s) => norm(s.name) === l);
  if (sw) return sw.level; // shown | listed
  if (profile.skills.some((s) => norm(s) === l)) return 'listed';
  if (profile.projects?.some((p) => p.tools?.some((t) => norm(t) === l))) return 'listed';
  if (label === 'COA registration') return profile.coa ? 'listed' : null;
  if (label === 'Portfolio') return profile.portfolio ? 'shown' : null;
  if (label === 'M.Arch') return profile.education?.some((e) => /m\.?\s?arch/i.test(e.degree)) ? 'listed' : null;
  return null;
}

const yearsOf = (profile) => (profile.experience_months || 0) / 12;

function levelFit(profile, job) {
  const stage = profile.stage || 'student';
  const role = job.role_type || null;
  if (role === 'internship') return stage === 'student' ? 1 : stage === 'graduate' ? 0.8 : 0.4;
  if (role === 'fresher') return stage === 'graduate' ? 1 : stage === 'student' ? 0.7 : 0.6;
  if (role === 'experienced') return stage === 'experienced' ? 0.9 : yearsOf(profile) >= 1 ? 0.4 : 0.2;
  return 0.7; // not labelled: assume a junior role
}

/**
 * @param profile from profile.js mergeProfile
 * @param job a feed row with title, description, software, role_type, exp_min, exp_max, city, location_text
 * @param analysis optional stored job analysis (must_have, nice_to_have, level)
 */
export function scoreFit(profile, job, analysis = null) {
  const reqs = jobRequirements(job, analysis);
  const required = reqs.filter((r) => r.required);
  const preferred = reqs.filter((r) => !r.required);
  const matched = [];
  const missing = [];
  for (const r of reqs) {
    const level = hasSkill(profile, r.label);
    (level ? matched : missing).push({ ...r, evidence: level || null });
  }
  const requiredMatched = matched.filter((m) => m.required).length;
  const preferredMatched = matched.filter((m) => !m.required).length;
  const requiredCov = required.length ? requiredMatched / required.length : 0.75;
  const preferredCov = preferred.length ? preferredMatched / preferred.length : 0.5;

  // Tools: portfolio evidence counts in full, a CV line for 70%.
  const tools = reqs.filter((r) => r.kind === 'tool');
  const toolScore = tools.length
    ? tools.reduce((s, t) => s + (hasSkill(profile, t.label) === 'shown' ? 1 : hasSkill(profile, t.label) ? 0.7 : 0), 0) / tools.length
    : 0.6;

  // What kind of work the role is about vs what the portfolio shows.
  const jobTypes = findTypologies(`${job.title}\n${(job.description || '').slice(0, 3000)}`).filter((t) => t !== 'BIM' && t !== 'Sustainability');
  const mine = new Set(profile.typologies || []);
  let portfolioScore;
  if (!profile.portfolio) portfolioScore = 0.45;
  else if (!jobTypes.length) portfolioScore = 0.75;
  else portfolioScore = Math.min(1, 0.35 + (jobTypes.filter((t) => mine.has(t)).length / jobTypes.length) * 0.65);
  if (job.is_bim && profile.portfolio) portfolioScore = Math.min(1, portfolioScore + (profile.portfolio.rubric?.bim || 0) / 400);

  const notes = [];
  let penalty = 0;
  const years = yearsOf(profile);
  if (job.exp_min != null && job.exp_min > years + 0.5) {
    const gap = job.exp_min - years;
    penalty += gap >= 3 ? 35 : gap >= 2 ? 25 : 15;
    notes.push(`Asks for ${job.exp_min}${job.exp_max ? `-${job.exp_max}` : '+'} years; you have ${years < 0.5 ? 'under 6 months' : `${years.toFixed(1).replace(/\.0$/, '')} years`}.`);
  }
  if (missing.some((m) => m.label === 'COA registration' && m.required)) {
    penalty += 10;
    notes.push('Asks for COA registration.');
  }
  const city = norm(job.city);
  if (city && city !== 'remote' && profile.cities?.length && !profile.cities.some((c) => norm(c) === city)) {
    penalty += 5;
    notes.push(`In ${job.city}, not one of your cities.`);
  }
  if (!profile.portfolio) notes.push('Upload your portfolio for a fuller score: work shown there counts more than a CV line.');

  const raw =
    WEIGHTS.required * requiredCov + WEIGHTS.software * toolScore + WEIGHTS.level * levelFit(profile, job) + WEIGHTS.portfolio * portfolioScore + WEIGHTS.preferred * preferredCov - penalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));
  const verdict = score >= 70 ? 'strong' : score >= 45 ? 'possible' : 'stretch';

  const improvements = missing
    .sort((a, b) => Number(b.required) - Number(a.required))
    .slice(0, 5)
    .map((m) => ({ label: m.label, required: m.required, tip: IMPROVEMENTS[m.label] || `Show ${m.label} in the portfolio or CV if you have done it.` }));

  return {
    version: FIT_VERSION,
    score,
    verdict,
    matched: matched.map(({ label, required, evidence }) => ({ label, required, evidence })),
    missing: missing.map(({ label, required }) => ({ label, required })),
    notes,
    improvements,
    parts: {
      required: Math.round(requiredCov * 100),
      tools: Math.round(toolScore * 100),
      level: Math.round(levelFit(profile, job) * 100),
      portfolio: Math.round(portfolioScore * 100),
      preferred: Math.round(preferredCov * 100),
      penalty,
    },
    job_types: jobTypes,
  };
}

// The requirements most often missing across a set of jobs: what to fix first.
export function gapSummary(fits, jobs) {
  const counts = new Map();
  fits.forEach((f, i) => {
    for (const m of f.missing) {
      const c = counts.get(m.label) || { label: m.label, kind: skillKind(m.label) || 'tool', jobs: 0, required: 0, examples: [] };
      c.jobs += 1;
      if (m.required) c.required += 1;
      if (c.examples.length < 3) c.examples.push({ id: jobs[i].id, title: jobs[i].title, company: jobs[i].company });
      counts.set(m.label, c);
    }
  });
  return [...counts.values()]
    .sort((a, b) => b.required - a.required || b.jobs - a.jobs)
    .slice(0, 12)
    .map((c) => ({ ...c, tip: IMPROVEMENTS[c.label] || null }));
}
