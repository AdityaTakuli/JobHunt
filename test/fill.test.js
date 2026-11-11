// ARCH in Chrome: which value goes in which application-form field (lib/fill.js), the checks on the
// AI's answers, the extension download (lib/zip.js) and matching a posting page to a stored job.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fillFields, matchFields, pickOption, profileFacts, sanitizeFields, validateFillAnswers } from '../server/lib/fill.js';
import { jobUrlPatterns, postingFromJsonLd } from '../server/lib/jobPage.js';
import { validateContact } from '../server/lib/profile.js';
import { zipEntries, zipStore } from '../server/lib/zip.js';

const profile = {
  name: 'Asha Kumar',
  stage: 'student',
  graduation_year: 2027,
  experience_months: 4,
  education: [{ degree: 'B.Arch', institution: 'SPA Delhi', year: 2027 }],
  experience: [{ role: 'Architecture Intern', firm: 'Studio X', months: 4, what: 'Working drawings for a villa' }],
  software: [
    { name: 'Revit', level: 'shown' },
    { name: 'AutoCAD', level: 'listed' },
  ],
  skills: ['Working drawings'],
  projects: [{ title: 'Hillside housing', typology: 'Residential', tools: ['Revit'], academic: true }],
  typologies: ['Residential'],
  cities: ['Bengaluru', 'Pune'],
  coa: false,
  certifications: [],
  summary: 'Final-year student strong in Revit documentation.',
  contact: { email: 'asha@example.com', phone: '+919876543210', linkedin: 'https://linkedin.com/in/asha', website: null, city: 'Delhi', address: null, date_of_birth: null },
};
const facts = profileFacts(profile, { name: 'Account Name', email: 'account@example.com' });

const field = (key, label, extra = {}) => ({ key, tag: 'input', type: 'text', label, ...extra });
const answerOf = (answers, key) => answers.find((a) => a.key === key);

describe('filling forms from the profile, without AI', () => {
  const fields = sanitizeFields([
    field('f1', 'First name', { autocomplete: 'given-name' }),
    field('f2', 'Last Name *'),
    field('f3', 'Full name'),
    field('f4', 'Email address', { type: 'email' }),
    field('f5', '', { name: 'candidate.phoneNumber', type: 'tel' }),
    field('f6', 'LinkedIn profile URL'),
    field('f7', 'Portfolio link'),
    { key: 'f8', tag: 'select', label: 'Total experience', options: ['Select', 'Fresher', '1-3 years', '3+ years'] },
    { key: 'f9', tag: 'select', label: 'Country', options: ['Select country', 'India', 'United States'] },
    field('f10', 'College / University'),
    field('f11', 'Current company name'),
    field('f12', 'Password', { type: 'password' }),
    { key: 'f13', tag: 'checkbox', label: 'I agree to the terms' },
    { key: 'f14', tag: 'file', label: 'Upload your resume (PDF)' },
    { key: 'f15', tag: 'file', label: 'Portfolio (PDF, max 10MB)' },
    { key: 'f16', tag: 'textarea', label: 'Why do you want to work with us?' },
    field('f17', 'Expected CTC'),
    field('f18', 'Year of graduation'),
    field('f19', 'City'),
    field('f20', "Father's name"),
    field('f21', 'Company Name'),
  ]);
  const { answers, rest, skipped } = matchFields(fields, facts, { resume: true, portfolio: false });
  const value = (k) => answerOf(answers, k)?.value;

  it('fills the standard fields straight from the CV', () => {
    assert.equal(value('f1'), 'Asha');
    assert.equal(value('f2'), 'Kumar');
    assert.equal(value('f3'), 'Asha Kumar');
    assert.equal(value('f4'), 'asha@example.com', 'the CV email wins over the account email');
    assert.equal(value('f5'), '+919876543210');
    assert.equal(value('f6'), 'https://linkedin.com/in/asha');
    assert.equal(value('f10'), 'SPA Delhi');
    assert.equal(value('f11'), 'Studio X');
    assert.equal(value('f18'), '2027');
    assert.equal(value('f19'), 'Delhi');
  });

  it('picks dropdown options that exist on the page', () => {
    assert.equal(value('f8'), 'Fresher', 'four months is the fresher band');
    assert.equal(value('f9'), 'India');
  });

  it('attaches the CV, and leaves the portfolio upload when there is none', () => {
    assert.deepEqual(answerOf(answers, 'f14'), { key: 'f14', file: 'resume', source: 'file' });
    assert.ok(skipped.some((s) => s.key === 'f15' && s.reason === 'no_file'));
  });

  it('never touches passwords, pay, tick boxes, or facts the CV lacks', () => {
    for (const k of ['f12', 'f13', 'f17', 'f7']) assert.equal(answerOf(answers, k), undefined, k);
    assert.ok(skipped.some((s) => s.key === 'f7' && s.reason === 'unknown'), 'no website on the CV: left for her, not guessed');
  });

  it("does not put her name in someone else's name field", () => {
    assert.equal(answerOf(answers, 'f20'), undefined);
    assert.notEqual(value('f21'), 'Asha Kumar');
  });

  it('leaves only what the rules could not settle for the AI step (which then refuses pay itself)', () => {
    assert.deepEqual(
      rest.map((f) => f.key),
      ['f16', 'f17', 'f20'],
    );
  });
});

describe('the AI pass', () => {
  const fields = sanitizeFields([
    { key: 'q1', tag: 'textarea', label: 'Why do you want to join us?', maxLength: 60 },
    { key: 'q2', tag: 'radio', label: 'Are you willing to relocate to Pune?', options: ['Yes', 'No'] },
    { key: 'q3', tag: 'select', label: 'How did you hear about us?', options: ['Select', 'LinkedIn', 'Job board', 'Friend'] },
    field('q4', 'Expected stipend per month'),
    field('q5', 'Notice period'),
  ]);

  it('keeps answers only for the fields asked, with real option values, within max length', () => {
    const out = validateFillAnswers(
      {
        answers: [
          { key: 'q1', value: 'I want to work on housing like my Hillside project, using Revit every day.', note: 'CV project' },
          { key: 'q2', value: 'yes', note: 'Pune is in her cities' },
          { key: 'q3', value: 'job board', note: '' },
          { key: 'zz', value: 'invented field' },
          { key: 'q1', value: 'duplicate' },
        ],
      },
      fields,
    );
    assert.equal(out.length, 3);
    assert.equal(out[0].value.length, 60);
    assert.equal(out[1].value, 'Yes');
    assert.equal(out[2].value, 'Job board');
    assert.equal(validateFillAnswers({ nope: true }, fields), null);
  });

  it('never asks the AI about pay or notice period, and counts what it answered', async () => {
    let asked;
    const ask = async ({ user, validate }) => {
      asked = JSON.parse(user.slice(user.indexOf('Fields to answer:\n') + 18));
      return validate({ answers: asked.map((f) => ({ key: f.key, value: f.key === 'q2' ? 'Yes' : null, note: '' })) });
    };
    const r = await fillFields({ profile, account: {}, page: { title: 'Apply' }, fields, files: {}, ask });
    assert.deepEqual(
      asked.map((f) => f.key),
      ['q1', 'q2', 'q3'],
    );
    assert.equal(r.ai.asked, 3);
    assert.equal(r.ai.answered, 1);
    assert.ok(r.skipped.some((s) => s.key === 'q4' && s.reason === 'never'));
    assert.ok(r.skipped.some((s) => s.key === 'q1' && s.reason === 'unknown'), 'a null answer is left for her');
  });

  it('leaves the open questions when the AI fails, and still returns the rule answers', async () => {
    const r = await fillFields({
      profile,
      account: {},
      page: {},
      fields: [...sanitizeFields([field('n', 'Email')]), ...fields],
      files: {},
      ask: async () => {
        throw new Error('busy');
      },
    });
    assert.equal(answerOf(r.answers, 'n').value, 'asha@example.com');
    assert.equal(r.ai.error, 'busy');
    assert.ok(r.skipped.some((s) => s.key === 'q1' && s.reason === 'ai_failed'));
  });

  it('makes no AI call when it is off', async () => {
    let called = false;
    const r = await fillFields({ profile, account: {}, page: {}, fields, files: {}, useAi: false, ask: async () => (called = true) });
    assert.equal(called, false);
    assert.ok(r.skipped.some((s) => s.key === 'q1' && s.reason === 'ai_off'));
  });
});

describe('form input from the extension is checked', () => {
  it('drops bad fields, duplicate keys and oversize lists', () => {
    const out = sanitizeFields([null, { key: '' }, { key: 'a', tag: 'evil', label: 'x'.repeat(500), options: Array(100).fill('o') }, { key: 'a', tag: 'input' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].tag, 'input');
    assert.equal(out[0].label.length, 300);
    assert.equal(out[0].options.length, 60);
    assert.equal(sanitizeFields('nope').length, 0);
  });

  it('picks options loosely but only real ones', () => {
    assert.equal(pickOption(['Select', 'B.Arch', 'M.Arch'], 'b.arch'), 'B.Arch');
    assert.equal(pickOption(['Yes', 'No'], 'maybe'), null);
  });

  it('tidies contact details typed or read from a CV', () => {
    const c = validateContact({ email: 'Not An Email', phone: '12', linkedin: 'linkedin.com/in/x', date_of_birth: '5 April 2003' });
    assert.equal(c.email, null);
    assert.equal(c.phone, null);
    assert.equal(c.linkedin, 'https://linkedin.com/in/x');
    assert.equal(c.date_of_birth, null);
  });
});

describe('extension download and posting matching', () => {
  it('writes a zip that reads back', () => {
    const zip = zipStore([
      { name: 'arch-in-chrome/manifest.json', data: Buffer.from('{"a":1}') },
      { name: 'arch-in-chrome/icons/i.png', data: Buffer.from([0, 1, 2, 255]) },
    ]);
    const entries = zipEntries(zip);
    assert.deepEqual(
      entries.map((e) => e.name),
      ['arch-in-chrome/manifest.json', 'arch-in-chrome/icons/i.png'],
    );
    assert.equal(entries[0].data.toString(), '{"a":1}');
    assert.deepEqual([...entries[1].data], [0, 1, 2, 255]);
  });

  it('finds the stored job from a posting page address, whatever the tracking', () => {
    const p = jobUrlPatterns('https://www.glassdoor.co.in/job-listing/senior-architect-wsp-JV_IC2940587_KO0,16_KE17,20.htm?jl=1010322090580&utm_source=jobalert');
    assert.ok(p.includes('%glassdoor.%jl=1010322090580%'));
    assert.ok(p[0].includes('JV\\_IC2940587'), 'underscores are escaped for LIKE');
    assert.deepEqual(jobUrlPatterns('https://example.com/'), []);
    assert.deepEqual(jobUrlPatterns('javascript:alert(1)'), []);
  });

  it('reads the posting the browser saw from its schema.org data', () => {
    const block = JSON.stringify({ '@type': 'JobPosting', title: 'Architect', description: '<p>Detailed drawings for hospitals in Revit.</p>'.repeat(10), hiringOrganization: { name: 'WSP' } });
    const p = postingFromJsonLd(['not json', block]);
    assert.equal(p.company, 'WSP');
    assert.match(p.description, /^Detailed drawings for hospitals in Revit\./);
    assert.equal(postingFromJsonLd([JSON.stringify({ '@type': 'JobPosting', description: 'short' })]), null);
  });
});
