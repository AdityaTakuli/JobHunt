// The profile (CV + portfolio) and the fit score: what the models' answers must look like, how
// the two sources merge, how a job is scored, and that a PDF can be read.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalSkill, findSkills, findTypologies } from '../shared/skills.js';
import { gapSummary, jobRequirements, scoreFit } from '../server/lib/fit.js';
import { openPdf, pdfText } from '../server/lib/pdf.js';
import { applyProfileEdits, mergeProfile, portfolioRubric, validatePortfolioPages, validateResumeProfile } from '../server/lib/profile.js';
import { riskyEffects } from './webEffects.test.js';

const resume = validateResumeProfile({
  name: 'Asha',
  stage: 'student',
  graduation_year: 2027,
  experience_months: 4,
  education: [{ degree: 'B.Arch', institution: 'SPA Delhi', year: 2027 }],
  experience: [{ role: 'Intern', firm: 'Studio X', months: 4, what: 'Working drawings for a villa' }],
  software: ['Revit', 'autocad', 'Sketch Up', 'Lumion'],
  skills: ['working drawings', 'rendering'],
  projects: [{ title: 'Hillside housing', typology: 'residential', scale: 'medium', role: 'solo', tools: ['Revit'], academic: true }],
  cities: ['Bengaluru'],
  coa: false,
  certifications: [],
  summary: 'Final-year student strong in Revit documentation.',
});

const pages = validatePortfolioPages(
  {
    pages: [
      { page: 1, project: 'Hillside housing', typology: 'residential', scale: 'medium', drawings: ['plan', 'section', 'render'], software: ['Revit'], process: false, technical: true, quality: 4, note: 'Clean sheet' },
      { page: 2, project: 'Hillside housing', typology: 'residential', scale: 'medium', drawings: ['sketch', 'diagram'], software: [], process: true, technical: false, quality: 4, note: 'Concept studies' },
      { page: 3, project: 'Cafe interior', typology: 'interiors', scale: 'small', drawings: ['plan', 'render', 'detail'], software: ['SketchUp', 'Enscape'], process: false, technical: true, quality: 5, note: 'Strong material board' },
      { page: 4, project: null, typology: null, scale: null, drawings: ['text'], software: [], process: false, technical: false, quality: 3, note: 'CV page' },
    ],
  },
  [1, 2, 3, 4],
);

describe('skills taxonomy', () => {
  it('finds tools and skills in a posting and maps names to canonical labels', () => {
    const labels = findSkills('Proficiency in Revit and Auto CAD; working drawings; LOD 300').map((s) => s.label);
    assert.deepEqual(labels, ['Revit', 'AutoCAD', 'Working drawings', 'LOD']);
    assert.equal(canonicalSkill('autocad 2024'), 'AutoCAD');
    assert.equal(canonicalSkill('Rhinoceros'), 'Rhino');
    assert.equal(canonicalSkill('Grasshopper'), 'Grasshopper');
    assert.equal(canonicalSkill('Some Unknown Tool'), 'Some Unknown Tool');
    assert.deepEqual(findTypologies('Interior designer for hotel projects'), ['Hospitality', 'Interiors']);
  });
});

describe('profile from the CV and portfolio', () => {
  it('keeps the CV reading in a strict shape', () => {
    assert.equal(resume.stage, 'student');
    assert.deepEqual(
      resume.software.map((s) => s.name),
      ['Revit', 'AutoCAD', 'SketchUp', 'Lumion'],
    );
    assert.deepEqual(resume.skills, ['Working drawings', 'Rendering']);
    assert.equal(resume.projects[0].typology, 'Residential');
    assert.equal(validateResumeProfile({ stage: 'student' }), null, 'an empty reading is rejected');
    assert.equal(validateResumeProfile('nope'), null);
  });

  it('keeps page notes only for the pages given, and needs most of them', () => {
    assert.equal(pages.length, 4);
    assert.deepEqual(pages[2].software, ['SketchUp', 'Enscape']);
    assert.deepEqual(pages[0].drawings, ['plan', 'section', 'render']);
    assert.equal(validatePortfolioPages({ pages: [{ page: 9, quality: 3 }] }, [1, 2, 3, 4]), null, 'unknown page numbers do not count');
    assert.equal(validatePortfolioPages({ pages: [pages[0]] }, [1, 2, 3, 4]), null, 'one of four pages is not enough');
  });

  it('merges them: portfolio software counts as shown, drawings prove skills, rubric is worked out', () => {
    const profile = mergeProfile({ resume, pages, review: { strengths: ['Good sheets'], weaknesses: [], improvements: ['Add a detail'], best_for: ['BIM intern'], summary: 'Solid.' }, totalPages: 4 });
    const levels = Object.fromEntries(profile.software.map((s) => [s.name, s.level]));
    assert.equal(levels.Revit, 'shown');
    assert.equal(levels.SketchUp, 'shown');
    assert.equal(levels.Lumion, 'listed');
    assert.equal(levels.Enscape, 'shown');
    assert.ok(profile.skills.includes('Detailing'));
    assert.ok(profile.skills.includes('Hand sketching'));
    assert.deepEqual(profile.typologies.sort(), ['Interiors', 'Residential']);
    assert.equal(profile.portfolio.read_pages, 4);
    const r = profile.portfolio.rubric;
    assert.ok(r.presentation >= 70, 'quality 4-5 pages score high on presentation');
    assert.ok(r.bim >= 60, 'Revit shown');
    assert.equal(r.concision, 100);
    assert.deepEqual(profile.portfolio.strengths, ['Good sheets']);
  });

  it('merges a portfolio alone (no CV)', () => {
    const profile = mergeProfile({ pages, totalPages: 4 });
    assert.equal(profile.stage, 'student');
    assert.ok(profile.software.some((s) => s.name === 'Revit' && s.level === 'shown'));
  });

  it('applies edits without losing portfolio evidence', () => {
    const profile = mergeProfile({ resume, pages, totalPages: 4 });
    const edited = applyProfileEdits(profile, { software: ['Revit', 'Rhino'], stage: 'graduate', coa: true, cities: ['Mumbai'] });
    assert.deepEqual(edited.software, [
      { name: 'Revit', level: 'shown' },
      { name: 'Rhino', level: 'listed' },
    ]);
    assert.equal(edited.stage, 'graduate');
    assert.equal(edited.coa, true);
    assert.deepEqual(edited.cities, ['Mumbai']);
    assert.equal(profile.stage, 'student', 'the original is untouched');
  });

  it('rubric: a long portfolio with no process or technical pages scores low', () => {
    const weak = Array.from({ length: 10 }, (_, i) => ({ page: i + 1, typology: 'Residential', scale: 'small', drawings: ['render'], software: [], process: false, technical: false, quality: 2 }));
    const r = portfolioRubric(weak, 90);
    assert.equal(r.process, 0);
    assert.equal(r.concision, 25);
    assert.ok(r.technical < 20);
    assert.ok(r.range < 40);
  });
});

describe('fit score', () => {
  const profile = mergeProfile({ resume, pages, totalPages: 4 });
  const bimJob = {
    id: 1,
    title: 'BIM Intern',
    company: 'Studio Y',
    city: 'Bengaluru',
    description: 'Must have Revit. Working drawings and detailing for residential projects. Knowledge of Navisworks is a plus. Portfolio required.',
    software: ['Revit', 'Navisworks'],
    role_type: 'internship',
    is_bim: true,
    exp_min: null,
    exp_max: null,
  };

  it('reads requirements: named tools are required, a "plus" is preferred', () => {
    const reqs = jobRequirements(bimJob);
    const by = Object.fromEntries(reqs.map((r) => [r.label, r.required]));
    assert.equal(by.Revit, true);
    assert.equal(by['Working drawings'], false, 'no must-have cue in that sentence');
    assert.equal(by.Navisworks, true, 'a tool the posting names is required unless the analysis says otherwise');
    const withAnalysis = jobRequirements(bimJob, { must_have: ['Revit'], nice_to_have: ['Navisworks knowledge'] });
    assert.equal(withAnalysis.find((r) => r.label === 'Navisworks').required, false);
  });

  it('scores a matching internship as strong, with what matched and what is missing', () => {
    const fit = scoreFit(profile, bimJob, { must_have: ['Revit'], nice_to_have: ['Navisworks'] });
    assert.equal(fit.verdict, 'strong', JSON.stringify(fit));
    assert.ok(fit.score >= 70);
    assert.ok(fit.matched.some((m) => m.label === 'Revit' && m.evidence === 'shown'));
    assert.ok(fit.missing.some((m) => m.label === 'Navisworks'));
    assert.ok(fit.improvements.some((i) => i.label === 'Navisworks' && /Navisworks/.test(i.tip)));
    assert.deepEqual(fit.notes, []);
  });

  it('marks a senior role down for experience and a licence, and says why', () => {
    const senior = { ...bimJob, title: 'Senior Architect', description: 'COA registered architect with 5+ years. Revit, AutoCAD.', role_type: 'experienced', exp_min: 5, exp_max: null, software: ['Revit', 'AutoCAD'], city: 'Mumbai' };
    const fit = scoreFit(profile, senior);
    assert.equal(fit.verdict, 'stretch');
    assert.ok(fit.notes.some((n) => /5\+ years/.test(n)));
    assert.ok(fit.notes.some((n) => /COA/.test(n)));
    assert.ok(fit.notes.some((n) => /Mumbai/.test(n)));
    assert.ok(fit.parts.penalty >= 45);
  });

  it('is the same every time and rewards portfolio evidence over a CV line', () => {
    const a = scoreFit(profile, bimJob);
    const b = scoreFit(profile, bimJob);
    assert.deepEqual(a, b);
    const cvOnly = mergeProfile({ resume, totalPages: 0 });
    const c = scoreFit(cvOnly, bimJob);
    assert.ok(c.score < a.score, 'without the portfolio the same CV scores lower');
    assert.ok(c.notes.some((n) => /Upload your portfolio/.test(n)));
  });

  it('a posting that names nothing still gets a middling score, not zero', () => {
    const vague = { id: 2, title: 'Architect Intern', company: 'Z', city: '', description: 'Join our team.', software: [], role_type: 'internship' };
    const fit = scoreFit(profile, vague);
    assert.ok(fit.score >= 50 && fit.score <= 90, String(fit.score));
    assert.deepEqual(fit.missing, []);
  });

  it('sums the gaps across jobs, required first', () => {
    const jobs = [bimJob, { ...bimJob, id: 3, title: 'Junior Architect', description: 'Rhino and Grasshopper required. Navisworks.' , software: ['Rhino', 'Grasshopper', 'Navisworks'] }];
    const fits = jobs.map((j) => scoreFit(profile, j));
    const gaps = gapSummary(fits, jobs);
    assert.equal(gaps[0].label, 'Navisworks');
    assert.equal(gaps[0].jobs, 2);
    assert.ok(gaps.some((g) => g.label === 'Rhino' && g.tip));
  });
});

// A two-page PDF written by hand, enough for MuPDF to open.
function tinyPdf(pageTexts) {
  const objs = [];
  const add = (s) => (objs.push(s), objs.length);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pagesId = objs.length + pageTexts.length * 2 + 1;
  const pageIds = pageTexts.map((text) => {
    const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
    const content = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
  });
  add(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

describe('PDF reading', () => {
  it('counts pages, extracts text and renders a page image', async () => {
    const pdf = await openPdf(tinyPdf(['Revit AutoCAD working drawings', 'Housing project']));
    assert.equal(pdf.pages, 2);
    assert.equal(pdf.text(0), 'Revit AutoCAD working drawings');
    const jpeg = pdf.render(1, { maxPx: 300 });
    assert.ok(jpeg.length > 500);
    assert.deepEqual([...jpeg.subarray(0, 3)], [0xff, 0xd8, 0xff], 'JPEG magic');
    pdf.close();
    assert.equal((await pdfText(tinyPdf(['a', 'b']))).text, 'a\n\nb');
  });

  it('refuses things that are not PDFs', async () => {
    await assert.rejects(() => openPdf(Buffer.from('hello')), /not a PDF/);
    await assert.rejects(() => openPdf(Buffer.from('%PDF-1.4 garbage')), /Could not open/);
  });
});

describe('web effects check still exports its helper', () => {
  it('works', () => assert.equal(riskyEffects('useEffect(() => { a(); }, [])').length, 0));
});
