import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { formatRange, formatSalary } from '../shared/format.js';
import { dedupeKey, normalizeCity, normalizeCompany, normalizeTitle } from '../server/lib/normalize.js';
import { parseSalary } from '../server/lib/salary.js';
import { countJobLinks, parseLinkedInAlert } from '../server/sources/linkedinEmail.js';
import { isJobBoard, normalizeSerpJob, parsePostedAt, pickApplyLink } from '../server/sources/serpapi.js';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

describe('parseSalary', () => {
  const cases = [
    ['Stipend: ₹15,000 - ₹20,000 per month', 15000, 20000, 'month'],
    ['Stipend: 10k/month', 10000, 10000, 'month'],
    ['CTC 3-4 LPA', 300000, 400000, 'year'],
    ['INR 3,00,000 - 4,00,000 per annum', 300000, 400000, 'year'],
    ['Rs. 12,000/- per month', 12000, 12000, 'month'],
    ['₹15K–₹25K a month', 15000, 25000, 'month'],
    ['15K–25K a month', 15000, 25000, 'month'],
    ['54,770.35–67,093.68 a year', 54770, 67094, 'year'],
    ['paid internship with 10-15k stipend', 10000, 15000, 'month'],
    ['Rs 5 lakhs per annum', 500000, 500000, 'year'],
  ];
  for (const [text, min, max, period] of cases) {
    it(text, () => {
      const s = parseSalary(text);
      assert.equal(s.min, min);
      assert.equal(s.max, max);
      assert.equal(s.period, period);
    });
  }

  it('keeps a stipend mention without an amount', () => {
    assert.deepEqual(parseSalary('Stipend will be provided'), { text: 'Stipend will be provided', min: null, max: null, period: null });
  });

  it('ignores numbers that are not pay', () => {
    assert.equal(parseSalary('5-year B.Arch programme, 2 architects in team'), null);
    assert.equal(parseSalary('Stipend for 6 months duration'), null);
  });
});

describe('format', () => {
  it('formats monthly and yearly ranges', () => {
    assert.equal(formatRange(15000, 20000, 'month'), '₹15k–20k/mo');
    assert.equal(formatRange(300000, 450000, 'year'), '₹3–4.5 LPA');
    assert.equal(formatSalary({ salary_text: 'Stipend will be provided' }), 'Stipend will be provided');
  });
});

describe('normalize + dedupe', () => {
  it('normalizes Indian city names', () => {
    assert.equal(normalizeCity('Bengaluru East, Karnataka, India'), 'Bengaluru');
    assert.equal(normalizeCity('Bangalore Urban'), 'Bengaluru');
    assert.equal(normalizeCity('Gurgaon, Haryana'), 'Gurugram');
    assert.equal(normalizeCity('Anywhere'), 'Remote');
    assert.equal(normalizeCity('Kolkata, West Bengal'), 'Kolkata');
    assert.equal(normalizeCity('Karnataka, India'), '');
  });

  it('treats company suffixes and title noise as the same job', () => {
    assert.equal(normalizeCompany('XYZ BIM Services Pvt. Ltd.'), 'xyz bim services');
    assert.equal(normalizeTitle('BIM Intern (Revit) - Bengaluru'), 'bim intern');
    assert.equal(
      dedupeKey({ company: 'Studio Lotus Pvt Ltd', title: 'BIM Intern', city: 'Bengaluru' }),
      dedupeKey({ company: 'studio lotus', title: 'BIM Intern (On-site)', city: 'Bengaluru' }),
    );
    assert.notEqual(
      dedupeKey({ company: 'Studio Lotus', title: 'BIM Intern', city: 'Bengaluru' }),
      dedupeKey({ company: 'Studio Lotus', title: 'BIM Intern', city: 'Delhi' }),
    );
  });
});

describe('LinkedIn alert emails', () => {
  it('parses all three HTML card layouts', () => {
    const jobs = parseLinkedInAlert({ html: fixture('linkedin-alert.html'), receivedAt: new Date('2026-09-24T03:00:00Z') });
    assert.deepEqual(
      jobs.map((j) => [j.title, j.company, j.city]),
      [
        ['BIM Intern', 'Studio Lotus', 'Bengaluru'],
        ['Junior Architect', 'Morphogenesis', 'Bengaluru'],
        ['Revit Modeler (Fresher)', 'XYZ BIM Services Pvt. Ltd.', 'Bengaluru'],
        ['Cloud Solution Architect', 'Acme Software', 'Bengaluru'],
      ],
    );
    assert.equal(jobs[0].applyUrl, 'https://www.linkedin.com/jobs/view/4012345678/');
    assert.equal(jobs[2].applyUrl, 'https://www.linkedin.com/jobs/view/4034567890/');
    assert.equal(jobs[0].postedAt.toISOString(), '2026-09-24T03:00:00.000Z');
  });

  it('falls back to the plain-text body', () => {
    const jobs = parseLinkedInAlert({ html: '', text: fixture('linkedin-alert.txt') });
    assert.deepEqual(
      jobs.map((j) => [j.title, j.company, j.city]),
      [
        ['Architectural Intern', 'Mistry Architects', 'Bengaluru'],
        ['Design Intern - Interiors', 'Collage Architecture Studio', 'Bengaluru'],
      ],
    );
  });

  it('counts job links for parse-failure logging', () => {
    assert.equal(countJobLinks(fixture('linkedin-alert.html'), ''), 4);
    assert.equal(countJobLinks('<p>Welcome to LinkedIn</p>', ''), 0);
  });
});

describe('SerpApi Google Jobs', () => {
  const now = new Date('2026-09-24T06:00:00Z');
  const results = JSON.parse(fixture('serpapi-google-jobs.json')).jobs_results;

  it('prefers the firm careers page, then LinkedIn, then job boards', () => {
    const pick = pickApplyLink([
      { title: 'Indeed', link: 'https://in.indeed.com/viewjob?jk=1' },
      { title: 'LinkedIn', link: 'https://in.linkedin.com/jobs/view/1' },
    ]);
    assert.equal(pick.publisher, 'LinkedIn');
    assert.equal(normalizeSerpJob(results[0], now).applyUrl, 'https://studiolotus.in/careers/bim-intern');
    assert.equal(isJobBoard('https://www.naukri.com/x'), true);
    assert.equal(isJobBoard('https://careers.studio.in/x'), false);
  });

  it('normalizes a result', () => {
    const job = normalizeSerpJob(results[2], now);
    assert.equal(job.title, 'Junior Architect');
    assert.equal(job.company, 'Collage Architecture Studio');
    assert.equal(job.city, 'Bengaluru');
    assert.deepEqual(job.salary, { text: '₹25K–₹35K a month', min: 25000, max: 35000, period: 'month' });
    assert.equal(job.postedAt.toISOString(), '2026-09-23T10:00:00.000Z');
    assert.equal(normalizeSerpJob(results[3], now).city, 'Remote');
  });

  it('parses relative posted times', () => {
    assert.equal(parsePostedAt('3 days ago', now).toISOString(), '2026-09-21T06:00:00.000Z');
    assert.equal(parsePostedAt('30+ days ago', now).toISOString(), '2026-08-25T06:00:00.000Z');
    assert.equal(parsePostedAt('Just posted', now).toISOString(), now.toISOString());
    assert.equal(parsePostedAt('', now), null);
  });
});
