// ATS layer: keywords found with code (lib/atsKeywords.js), the CV checker (lib/atsQuality.js),
// the playbook picker (lib/atsPlaybook.js), and the write-score-revise loop in lib/tailor.js.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { disciplineKey, findTerms, jobKeywords, ownKeywords } from '../server/lib/atsKeywords.js';
import { pickExamples, playbookPrompt } from '../server/lib/atsPlaybook.js';
import { bulletProblem, scoreCv } from '../server/lib/atsQuality.js';
import { keywordBrief, tailor } from '../server/lib/tailor.js';

describe('ATS keywords, found with code', () => {
  const posting = {
    title: 'Junior Structural Engineer',
    description: 'Must have strong knowledge of STAAD Pro and ETABS; design to IS:456. AutoCAD required. Knowledge of Building Information Modelling is a plus. Prepare BBS. Good communication. Safe working practices; premiere institute preferred.',
  };
  const k = jobKeywords(posting);
  const label = (l) => k.find((x) => x.label === l);

  it("finds tools and skills in the posting's own words", () => {
    assert.equal(label('STAAD.Pro').surface, 'STAAD Pro');
    assert.equal(label('IS 456').surface, 'IS:456');
    assert.equal(label('Bar bending schedule').surface, 'BBS');
    assert.equal(label('Building Information Modelling').surface, 'Building Information Modelling');
  });

  it('marks what the posting requires and ranks it first', () => {
    assert.equal(label('STAAD.Pro').required, true);
    assert.equal(label('AutoCAD').required, true);
    assert.equal(label('Building Information Modelling').required, false);
    assert.ok(k.findIndex((x) => x.label === 'STAAD.Pro') < k.findIndex((x) => x.label === 'IS 456'));
  });

  it('does not mistake ordinary words for tools', () => {
    assert.ok(!k.some((x) => /SAFE|Premiere|Microsoft Word/.test(x.label)));
    assert.deepEqual(findTerms('GD&T, 3ds Max, Solid Works, staad.pro').map((t) => t.label).sort(), ['3ds Max', 'GD&T', 'STAAD.Pro', 'SolidWorks']);
  });

  it('knows the field from a degree or discipline', () => {
    assert.equal(disciplineKey('B.Tech Civil'), 'civil');
    assert.equal(disciplineKey('Mechanical engineering'), 'mechanical');
    assert.equal(disciplineKey('Interior design'), 'interiors');
    assert.equal(disciplineKey('B.Arch'), 'architecture');
  });

  it("for a general CV, targets the person's own tools in their field", () => {
    const own = ownKeywords('Skills: SolidWorks, ANSYS, AutoCAD, Revit Architecture, MS Excel', 'mechanical');
    const labels = own.map((t) => t.label);
    assert.ok(labels.includes('SolidWorks') && labels.includes('ANSYS'));
    assert.ok(!labels.includes('Revit Architecture'), 'an architecture tool is not a target for a mechanical CV');
  });

  it('tells the model what to use and what to leave out', () => {
    const brief = keywordBrief(k, 'I know STAAD.Pro and AutoCAD', false);
    assert.match(brief, /"STAAD Pro" \(required\)/);
    assert.match(brief, /leave them out entirely: .*"ETABS"/);
  });
});

describe('the CV checker', () => {
  const asked = jobKeywords({ title: 'Architecture Intern', description: 'Revit and Navisworks required. Building Information Modelling, clash detection, AutoCAD.' });
  const owned = 'Revit, AutoCAD, BIM, clash detection';
  const cv = {
    summary: 'Final-year B.Arch student with Revit experience.',
    skills: [{ group: 'Software', items: ['Revit', 'AutoCAD'] }],
    experience: [{ role: 'Intern', firm: 'Studio X', bullets: ['Responsible for drawings.', 'I made BIM models in Revit for a housing project with my team.'] }],
    projects: [],
    education: [{ degree: 'B.Arch' }],
  };
  const q = scoreCv(cv, { asked, ownedText: owned });

  it('finds keywords she has that the CV hides, and never asks for ones she lacks', () => {
    assert.ok(q.missingOwned.includes('clash detection'));
    assert.ok(!q.missingOwned.includes('Navisworks'), 'Navisworks is not in her files');
  });

  it("asks for the posting's exact wording", () => {
    assert.ok(q.wording.some((w) => w.use === 'Building Information Modelling' && w.cvSays === 'BIM'));
  });

  it('flags weak, first-person and short bullets, a thin summary and few skills', () => {
    assert.equal(bulletProblem('Responsible for drawings.'), 'starts weakly');
    assert.equal(bulletProblem('I made BIM models in Revit for a housing project with my team.'), 'uses first person');
    assert.equal(bulletProblem('Designed things.'), 'is too short to say what was done');
    assert.equal(bulletProblem('Prepared working drawings and door schedules for a residential villa in Revit.'), null);
    assert.ok(q.issues.includes('summary too short') && q.issues.includes('few skills listed'));
    assert.ok(q.score < 60, `score ${q.score}`);
  });

  it('gives a clean CV a high score', () => {
    const good = {
      summary: 'Final-year B.Arch student with internship experience in Building Information Modelling, Revit documentation and clash detection on residential projects. Skilled in AutoCAD and Revit, with a portfolio of housing and institutional work. Seeking a BIM internship where coordinated models and drawings matter.',
      skills: [{ group: 'Software', items: ['Revit', 'AutoCAD', 'Lumion', 'SketchUp'] }, { group: 'Technical', items: ['Building Information Modelling', 'clash detection', 'Working drawings'] }],
      experience: [{ role: 'Intern', firm: 'Studio X', bullets: ['Built the Revit model for a housing block and ran clash detection before each drawing issue.', 'Prepared working drawings and door schedules in Revit and AutoCAD for the tender set.'] }],
      projects: [],
      education: [{ degree: 'B.Arch' }],
    };
    const g = scoreCv(good, { asked, ownedText: owned });
    assert.equal(g.missingOwned.length, 0);
    assert.ok(g.score >= 90, `score ${g.score}: ${g.issues.join('; ')}`);
  });
});

describe('the playbook', () => {
  it('picks examples from the right field and the posting keywords', () => {
    const civil = pickExamples({ discipline: 'civil', labels: ['STAAD.Pro', 'ETABS'] });
    assert.ok(civil.bullets.length >= 3);
    assert.ok(civil.bullets.slice(0, 2).every((e) => e.disciplines.includes('civil')));
    assert.ok(civil.bullets.some((e) => e.tags.includes('STAAD.Pro')));
    assert.ok(civil.summary.disciplines.includes('civil'));
    assert.match(playbookPrompt(civil), /never their facts/);
    assert.ok(pickExamples({ discipline: 'mechanical', labels: [] }).bullets.every((e) => e.disciplines.includes('mechanical') || e.disciplines.includes('all')));
  });
});

describe('write, score, revise', () => {
  const profile = { name: 'Ravi Kumar', discipline: 'Civil engineering', stage: 'graduate', experience_months: 6, education: [{ degree: 'B.Tech Civil', institution: 'COEP', year: 2026 }], experience: [{ role: 'Site Engineer Intern', firm: 'L and T', months: 6, what: 'Supervised slab casting, checked reinforcement against the bar bending schedule, kept QC records' }], software: [{ name: 'STAAD.Pro', level: 'listed' }, { name: 'AutoCAD', level: 'listed' }], skills: ['Site execution'], projects: [], certifications: [] };
  const resumeText = 'Ravi Kumar. B.Tech Civil, COEP, 2026. Site Engineer Intern, L and T: supervised slab casting, checked reinforcement against the bar bending schedule (BBS), kept quality control records. Software: STAAD.Pro, AutoCAD.';
  const posting = { title: 'Site Engineer', company: 'Acme', description: 'Site Engineer. STAAD Pro and AutoCAD required. Prepare BBS and maintain quality control records. Primavera P6 is a plus.' };
  const weak = {
    headline: 'Civil engineer',
    summary: 'Civil engineer.',
    skills: [{ group: 'Software', items: ['AutoCAD'] }],
    experience: [{ role: 'Site Engineer Intern', firm: 'L and T', dates: null, bullets: ['Responsible for site work.'] }],
    projects: [],
    cover_letter: { greeting: 'Dear Hiring Team,', paragraphs: ['At L and T I supervised slab casting.'], sign_off: 'Regards,\nRavi' },
  };
  const strong = {
    headline: 'B.Tech Civil graduate | STAAD Pro, site execution',
    summary: 'B.Tech Civil graduate from COEP with six months of site-execution experience at L and T, supervising slab casting and checking reinforcement against the BBS. Skilled in STAAD Pro and AutoCAD, with daily quality control records kept on site. Seeking a site engineer role on building projects.',
    skills: [{ group: 'Software', items: ['STAAD.Pro', 'AutoCAD'] }, { group: 'Site', items: ['Site execution', 'Bar bending schedule', 'Quality control', 'Slab casting'] }],
    experience: [{ role: 'Site Engineer Intern', firm: 'L and T', dates: null, bullets: ['Supervised slab casting and checked reinforcement against the BBS before each pour on site.', 'Maintained daily quality control records for concrete and steel work on the building site.'] }],
    projects: [],
    cover_letter: weak.cover_letter,
  };

  it('sends the problems back once and keeps the better version', async () => {
    const calls = [];
    const ask = async ({ system, user, validate }) => {
      calls.push({ system, user });
      return validate(calls.length === 1 ? weak : strong);
    };
    const out = await tailor({ profile, resumeText, posting, ask });
    assert.equal(calls.length, 2);
    assert.match(calls[0].user, /ATS keywords the posting asks for that the person really has/);
    assert.match(calls[0].user, /"STAAD Pro" \(required\)/);
    assert.match(calls[0].user, /leave them out entirely: "Primavera P6"/);
    assert.match(calls[0].user, /Examples of the writing wanted/);
    assert.match(calls[1].user, /Problems to fix:/);
    assert.match(calls[1].user, /Responsible for site work/);
    assert.equal(out.match.quality.passes, 2);
    assert.ok(out.match.quality.score > out.match.quality.first, JSON.stringify(out.match.quality));
    assert.equal(out.resume.summary, strong.summary);
  });

  it('keeps the first version when the revision is worse or fails', async () => {
    let n = 0;
    const ask = async ({ validate }) => {
      n += 1;
      if (n === 2) throw new Error('busy');
      return validate(weak);
    };
    const out = await tailor({ profile, resumeText, posting, ask });
    assert.equal(out.resume.summary, 'Civil engineer.');
    assert.equal(out.match.quality.passes, 1);
  });

  it('can be run as a single pass without the playbook (for the comparison)', async () => {
    const calls = [];
    const ask = async ({ user, validate }) => {
      calls.push(user);
      return validate(weak);
    };
    await tailor({ profile, resumeText, posting, ask, options: { playbook: false, revise: false } });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls[0], /Examples of the writing wanted/);
  });
});

describe('facts the checker must never bend', () => {
  it('never tells a B.Tech to write "B.E." because the posting does', () => {
    const asked = jobKeywords({ title: 'Site Engineer', description: 'B.E. Civil required. AutoCAD required.' });
    const q = scoreCv({ summary: 'B.Tech Civil graduate.', skills: [{ group: 'Software', items: ['AutoCAD'] }], experience: [], projects: [] }, { asked, ownedText: 'B.Tech Civil, AutoCAD' });
    assert.ok(!q.wording.some((w) => /B\.E/.test(w.use)), JSON.stringify(q.wording));
    assert.ok(!q.missingOwned.some((m) => /B\.E/.test(m)));
    assert.doesNotMatch(keywordBrief(asked, 'B.Tech Civil, AutoCAD', false), /B\.E/);
  });

  it('flags a summary written with a name or pronouns', () => {
    const q = scoreCv({ summary: 'Meera Nair is a final-year B.Arch student. She completed an internship at a studio in Pune and seeks a junior architect role in residential and institutional practice with a design focus.', skills: [], experience: [], projects: [] }, { name: 'Meera Nair' });
    assert.ok(q.issues.includes('summary uses a name or pronouns'));
  });

  it('replaces a degree the person does not hold with their own', async () => {
    const { checkTailored } = await import('../server/lib/tailor.js');
    const { profileFacts } = await import('../server/lib/fill.js');
    const profile = { name: 'Arjun', education: [{ degree: 'B.E. Mechanical Engineering', institution: 'Sample College' }], experience: [], projects: [{ title: 'Solar pump', tools: ['SolidWorks'] }], software: [{ name: 'SolidWorks' }], skills: [] };
    const facts = profileFacts(profile, {});
    const out = checkTailored(
      { headline: 'B.Tech Mechanical graduate', summary: 'B.Tech Mechanical graduate with SolidWorks experience.', skills: [], experience: [], projects: [{ title: 'Solar pump', bullets: ['Modelled the pump housing and impeller assembly in SolidWorks for the prototype build.'] }] },
      { profile, resumeText: 'B.E. Mechanical Engineering, Sample College. Solar pump project in SolidWorks.', facts },
    );
    assert.match(out.resume.summary, /^B\.E\. Mechanical graduate/);
    assert.match(out.resume.headline, /^B\.E\./);
    assert.ok(out.dropped.some((d) => /degree "B\.Tech"/.test(d)));
    const kept = checkTailored({ summary: 'B.E. Mechanical graduate with SolidWorks experience.', projects: [{ title: 'Solar pump', bullets: ['Modelled the pump housing and impeller assembly in SolidWorks for the prototype build.'] }] }, { profile, resumeText: 'B.E. Mechanical Engineering. Solar pump.', facts });
    assert.match(kept.resume.summary, /^B\.E\. Mechanical graduate/, 'a degree they hold stays');
  });
});

describe('keywords she has always reach the CV', () => {
  it('adds a posting keyword the person has to the skills list when the model leaves it out twice', async () => {
    const profile = { name: 'Sana', discipline: 'Interior design', education: [{ degree: 'B.Des', institution: 'Sample Institute' }], experience: [], projects: [{ title: 'Courtyard Cafe', tools: ['SketchUp', 'V-Ray'] }], software: [{ name: 'SketchUp' }, { name: 'V-Ray' }], skills: [] };
    const reply = {
      summary: 'Interior design graduate with café and apartment fit-out projects, visualised in SketchUp, with joinery details and material palettes prepared for each scheme. Seeking a junior interior designer role in a hospitality studio.',
      skills: [{ group: 'Software', items: ['SketchUp'] }],
      projects: [{ title: 'Courtyard Cafe', bullets: ['Planned the seating layout for the café and modelled the interior in SketchUp for review.', 'Detailed the bar counter joinery with sections and material callouts for the workshop.'] }],
    };
    const out = await tailor({ profile, resumeText: 'Courtyard Cafe: SketchUp and V-Ray renders.', posting: { title: 'Interior Designer', description: 'SketchUp with V-Ray renders required.' }, ask: async ({ validate }) => validate(reply) });
    assert.ok(out.resume.skills[0].items.includes('V-Ray'));
    assert.equal(out.match.quality.coverage, 100);
    assert.equal(out.match.quality.missing.length, 0);
  });
});
