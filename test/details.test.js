// Application details (lib/details.js): what the person types in the popup form, how it is
// cleaned, and how ARCH in Chrome fills forms from it (lib/fill.js), with or without a CV.
// Also the job-link matching that tied a Glassdoor page to the wrong job (lib/jobPage.js).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanDetails, hasDetails, missingEssentials, niceName, prefillDetails } from '../server/lib/details.js';
import { fillFields, matchFields, profileFacts, sanitizeFields } from '../server/lib/fill.js';
import { jobUrlPatterns } from '../server/lib/jobPage.js';

const details = cleanDetails({
  name: 'Ravi Kumar',
  email: 'RAVI@Example.com ',
  phone: '+91 98765-43210',
  date_of_birth: '2002-02-30',
  gender: 'Male',
  city: 'Pune',
  state: 'Maharashtra',
  pincode: '411001',
  linkedin: 'linkedin.com/in/ravi',
  github: 'github.com/ravi',
  discipline: 'Mechanical engineering',
  degree: 'B.Tech',
  specialization: 'Mechanical',
  institution: 'COEP Technological University',
  graduation_year: 2026,
  score: '8.4 CGPA',
  expected_ctc: '4.5 LPA',
  notice_period: 'Immediate',
  available_from: '2026-07-01',
  relocate: 'Yes',
  languages: 'English, Hindi, Marathi',
  heard_from: 'LinkedIn',
  unknown_key: 'ignored',
});

describe('application details are cleaned before they are kept', () => {
  it('tidies what was typed and drops what is not real', () => {
    assert.equal(details.email, 'ravi@example.com');
    assert.equal(details.phone, '+919876543210');
    assert.equal(details.date_of_birth, '', 'there is no 30 February');
    assert.equal(details.linkedin, 'https://linkedin.com/in/ravi');
    assert.equal(details.graduation_year, '2026');
    assert.equal(details.unknown_key, undefined);
    assert.equal(cleanDetails({ gender: 'Robot' }).gender, '', 'only the listed choices');
    assert.equal(cleanDetails({ relocate: 'maybe' }).relocate, '');
  });

  it('knows which basics are still missing', () => {
    assert.ok(hasDetails(details));
    assert.ok(!hasDetails(cleanDetails({})));
    assert.deepEqual(missingEssentials(details), []);
    assert.deepEqual(missingEssentials(cleanDetails({ name: 'X' })), ['email', 'phone', 'city', 'degree', 'institution', 'graduation_year']);
  });

  it('starts the form from the CV when nothing is saved, and never overwrites what is saved', () => {
    const profile = { name: 'ASHA RAO', contact: { email: 'asha@example.com', city: 'Bengaluru' }, education: [{ degree: 'B.Arch', institution: 'SPA Delhi', year: 2027 }], cities: ['Bengaluru'] };
    const pre = prefillDetails(null, profile, {});
    assert.equal(pre.name, 'Asha Rao');
    assert.equal(pre.degree, 'B.Arch');
    assert.equal(pre.graduation_year, '2027');
    assert.equal(prefillDetails({ city: 'Mumbai' }, profile).city, 'Mumbai');
    assert.equal(niceName("ASHA D'SOUZA"), "Asha D'Souza");
  });
});

describe('forms filled from the details', () => {
  const facts = profileFacts({}, {}, details);
  const fields = sanitizeFields([
    { key: 'a', tag: 'input', label: 'Expected CTC' },
    { key: 'b', tag: 'select', label: 'Notice period', options: ['Select', 'Immediate', '15 days', '30 days'] },
    { key: 'c', tag: 'radio', label: 'Gender', options: ['Female', 'Male', 'Other'] },
    { key: 'd', tag: 'input', label: 'Pincode' },
    { key: 'e', tag: 'input', label: 'State' },
    { key: 'f', tag: 'input', label: 'CGPA' },
    { key: 'g', tag: 'input', label: 'Graduation percentage' },
    { key: 'h', tag: 'input', label: '12th marks' },
    { key: 'i', tag: 'radio', label: 'Are you willing to relocate?', options: ['Yes', 'No'] },
    { key: 'j', tag: 'input', label: 'GitHub profile' },
    { key: 'k', tag: 'input', label: 'Branch / Discipline' },
    { key: 'l', tag: 'input', label: 'Earliest start date', type: 'date' },
    { key: 'm', tag: 'input', label: 'Languages known' },
    { key: 'n', tag: 'select', label: 'How did you hear about us?', options: ['Select', 'LinkedIn', 'Friend'] },
    { key: 'o', tag: 'input', label: 'College name' },
    { key: 'p', tag: 'input', label: 'Current CTC' },
  ]);
  const { answers, rest, skipped } = matchFields(fields, facts, {});
  const v = (k) => answers.find((a) => a.key === k)?.value;

  it('fills pay, notice, gender and marks only from what she typed', () => {
    assert.equal(v('a'), '4.5 LPA');
    assert.equal(v('b'), 'Immediate');
    assert.equal(v('c'), 'Male');
    assert.equal(v('f'), '8.4 CGPA');
    assert.equal(v('g'), '8.4 CGPA', '"graduation percentage" is marks, not a year');
    assert.equal(v('h'), undefined, 'school marks are never filled');
    assert.ok(skipped.some((s) => s.key === 'p' && s.reason === 'unknown'), 'no current CTC saved: left for her');
  });

  it('fills address parts, links, discipline, dates and languages', () => {
    assert.equal(v('d'), '411001');
    assert.equal(v('e'), 'Maharashtra');
    assert.equal(v('i'), 'Yes');
    assert.equal(v('j'), 'https://github.com/ravi');
    assert.equal(v('k'), 'Mechanical engineering');
    assert.equal(v('l'), '2026-07-01');
    assert.equal(v('m'), 'English, Hindi, Marathi');
    assert.equal(v('n'), 'LinkedIn');
    assert.equal(v('o'), 'COEP Technological University');
    assert.deepEqual(rest.map((f) => f.key), ['h'], 'only the school-marks box is left (and the AI step refuses marks)');
  });

  it('hands relocation and "how did you hear" to the AI when the details leave them empty', () => {
    const blank = matchFields(fields, profileFacts({}, {}, { name: 'X' }), {});
    assert.ok(blank.rest.some((f) => f.key === 'i'));
    assert.ok(blank.rest.some((f) => f.key === 'n'));
    assert.ok(!blank.rest.some((f) => f.key === 'a'), 'pay never goes to the AI');
  });

  it('fills a form from the details alone, with no CV uploaded', async () => {
    const r = await fillFields({ profile: null, details, account: {}, page: { title: 'Apply' }, fields: sanitizeFields([{ key: 'x', tag: 'input', label: 'Full name' }, { key: 'y', tag: 'input', label: 'Email' }]), files: {}, useAi: false });
    assert.equal(r.answers.find((a) => a.key === 'x').value, 'Ravi Kumar');
    assert.equal(r.answers.find((a) => a.key === 'y').value, 'ravi@example.com');
  });
});

describe('a job page is matched only to its own job', () => {
  it('never matches every Glassdoor job by the shared partner link path', () => {
    assert.deepEqual(jobUrlPatterns('https://www.glassdoor.co.in/partner/jobListing.htm?pos=101&ao=113604'), [], 'no job id: no match at all');
    const p = jobUrlPatterns('https://www.glassdoor.co.in/partner/jobListing.htm?pos=101&jobListingId=1009876543210');
    assert.ok(p.every((x) => x.includes('1009876543210')), 'every pattern carries the job id');
  });

  it('keeps matching links whose path names the job', () => {
    assert.equal(jobUrlPatterns('https://boards.greenhouse.io/acme/jobs/1234567').length, 1);
    assert.equal(jobUrlPatterns('https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/Bengaluru/Junior-Architect_R123').length, 1);
    assert.ok(jobUrlPatterns('https://in.indeed.com/viewjob?jk=abcdef1234567890').every((x) => x.includes('abcdef1234567890')));
    assert.deepEqual(jobUrlPatterns('https://acme.com/careers'), []);
  });
});
