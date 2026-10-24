// Company careers feeds (Workday, SmartRecruiters): which roles are kept, and how each feed's
// answer becomes a job for ingestJobs().

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMPANIES } from '../server/lib/companies.js';
import { fetchCompanyJobs, htmlToText, inIndia, isDesignRole } from '../server/sources/companyFeeds.js';

const SJ = { slug: 'surbana-jurong', name: 'Surbana Jurong', feed: { type: 'workday', host: 'sj.wd3.myworkdayjobs.com', tenant: 'sj', site: 'SJ_Careers' } };
const RAMBOLL = { slug: 'ramboll', name: 'Ramboll', feed: { type: 'smartrecruiters', id: 'Ramboll3' } };

// A fake fetch that answers from a table of URL -> body, and records every call.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    for (const [match, answer] of routes) {
      if (String(url).includes(match)) return Response.json(typeof answer === 'function' ? answer(JSON.parse(init.body || '{}')) : answer);
    }
    return new Response('not found', { status: 404 });
  };
  return { impl, calls };
}

describe('company careers: which roles count', () => {
  it('keeps architecture, BIM and design roles, drops IT architects and other fields', () => {
    for (const t of ['Architectural Intern', 'Graduate Architect', 'BIM Modeller (Revit)', 'Senior Landscape Architect', 'Interior Designer', 'Urban Designer', 'Project Architect - Healthcare', 'Architecture Trainee']) {
      assert.ok(isDesignRole(t), t);
    }
    for (const t of ['Solution Architect', 'Data Architect', 'Cloud Infrastructure Architect', 'Enterprise Architect - SAP', 'Senior Data Engineer', 'Structural Engineer', 'MEP BIM Modeller', 'Project Accounting Analyst', 'Salesforce Technical Architect', 'BIM Engineer - Structure', 'Senior Designer - BIM, Civil Structures, REC', 'Principal Designer-BIM, Roads & Highways, REC', 'Senior Designer - BIM, Geotech, REC', 'Senior Designer- BIM, W&WWTr, REC', 'BIM modeler - ELV - High-rise', 'BIM Modeller - Civil 3D']) {
      assert.ok(!isDesignRole(t), t);
    }
  });

  it('knows Indian places', () => {
    assert.ok(inIndia('Noida'));
    assert.ok(inIndia('Bengaluru, KA'));
    assert.ok(inIndia('Gurugram, , India'));
    assert.ok(inIndia('Remote, India'));
    assert.ok(!inIndia('Singapore'));
    assert.ok(!inIndia('SJ KSA Riyadh'));
    assert.ok(!inIndia('Remote'));
  });

  it('turns HTML descriptions into readable text', () => {
    assert.equal(htmlToText('<p>Revit &amp; AutoCAD</p><ul><li>B.Arch</li><li>0-1 years</li></ul>'), 'Revit & AutoCAD\n• B.Arch\n• 0-1 years');
  });
});

describe('company careers: Workday', () => {
  const list = (body) => ({
    total: 3,
    jobPostings:
      body.offset > 0
        ? []
        : [
            { title: 'Graduate Architect', externalPath: '/job/Noida/Graduate-Architect_JR1', locationsText: 'Noida', postedOn: 'Posted 2 Days Ago' },
            { title: 'Resident Architect', externalPath: '/job/Singapore/Resident-Architect_JR2', locationsText: 'Singapore', postedOn: 'Posted Today' },
            { title: 'Solution Architect', externalPath: '/job/Noida/Solution-Architect_JR3', locationsText: 'Noida', postedOn: 'Posted Today' },
            { title: 'BIM Architect', externalPath: '/job/x/BIM-Architect_JR4', locationsText: '2 Locations', postedOn: 'Posted Today' },
          ],
  });
  const detail = (country, title, location) => ({
    jobPostingInfo: {
      title,
      location,
      country: { descriptor: country },
      startDate: '2026-10-20',
      jobDescription: '<p>B.Arch, Revit. <b>0-2 years</b>.</p>',
      externalUrl: `https://sj.wd3.myworkdayjobs.com/SJ_Careers/job/${title.replace(/ /g, '-')}`,
    },
  });

  it('reads India design roles, with details, and skips the rest', async () => {
    const { impl, calls } = fakeFetch([
      ['/jobs', list],
      ['Graduate-Architect_JR1', detail('India', 'Graduate Architect', 'Noida')],
      ['BIM-Architect_JR4', detail('India', 'BIM Architect', 'Gurugram')],
    ]);
    const { jobs, requests } = await fetchCompanyJobs(SJ, { fetchImpl: impl, terms: ['architect'] });
    assert.deepEqual(jobs.map((j) => [j.title, j.city]), [['Graduate Architect', 'Noida'], ['BIM Architect', 'Gurugram']]);
    const [g] = jobs;
    assert.equal(g.source, 'company_careers');
    assert.equal(g.company, 'Surbana Jurong');
    assert.equal(g.applyKind, 'company');
    assert.equal(g.applyUrl, 'https://sj.wd3.myworkdayjobs.com/SJ_Careers/job/Graduate-Architect');
    assert.equal(g.publisher, 'Surbana Jurong careers');
    assert.match(g.description, /B\.Arch, Revit\. 0-2 years\./);
    assert.equal(g.postedAt.toISOString().slice(0, 10), '2026-10-20');
    const search = calls.find((c) => c.method === 'POST');
    assert.equal(search.url, 'https://sj.wd3.myworkdayjobs.com/wday/cxs/sj/SJ_Careers/jobs');
    assert.match(search.body.searchText, /architect India/);
    assert.ok(!calls.some((c) => /Resident-Architect|Solution-Architect/.test(c.url)), 'no detail calls for roles outside India or outside design');
    assert.equal(requests, calls.length);
  });

  it('drops a multi-location role that is not in India', async () => {
    const { impl } = fakeFetch([
      ['/jobs', list],
      ['Graduate-Architect_JR1', detail('India', 'Graduate Architect', 'Noida')],
      ['BIM-Architect_JR4', detail('Saudi Arabia', 'BIM Architect', 'Riyadh')],
    ]);
    const { jobs } = await fetchCompanyJobs(SJ, { fetchImpl: impl, terms: ['architect'] });
    assert.deepEqual(jobs.map((j) => j.title), ['Graduate Architect']);
  });

  it('only fetches details for roles not seen before', async () => {
    const { impl, calls } = fakeFetch([['/jobs', list]]);
    const { jobs } = await fetchCompanyJobs(SJ, { fetchImpl: impl, terms: ['architect'], isKnown: (job) => job.title === 'Graduate Architect' });
    assert.ok(!calls.some((c) => c.url.includes('Graduate-Architect_JR1')));
    assert.equal(jobs.find((j) => j.title === 'Graduate Architect').applyUrl, 'https://sj.wd3.myworkdayjobs.com/SJ_Careers/job/Noida/Graduate-Architect_JR1');
    assert.ok(!jobs.some((j) => j.title === 'BIM Architect'), 'a posting whose details fail to load is skipped');
  });

  it('reports a feed that is down', async () => {
    const { impl } = fakeFetch([]);
    await assert.rejects(fetchCompanyJobs(SJ, { fetchImpl: impl, terms: ['architect'] }), /Surbana Jurong careers answered 404/);
  });
});

describe('company careers: SmartRecruiters', () => {
  it('reads India postings and their full text', async () => {
    const posting = (id, name, city) => ({ id, name, releasedDate: '2026-10-23T10:00:00Z', location: { city, country: 'in', fullLocation: `${city}, , India` } });
    const { impl, calls } = fakeFetch([
      ['/postings/11', { id: '11', name: 'Architectural Designer', postingUrl: 'https://jobs.smartrecruiters.com/Ramboll3/11-architectural-designer', jobAd: { sections: { jobDescription: { text: '<p>Revit and SketchUp</p>' }, qualifications: { text: '<p>B.Arch</p>' } } } }],
      ['/postings?', { totalFound: 2, offset: 0, limit: 100, content: [posting('11', 'Architectural Designer', 'Gurugram'), posting('12', 'Senior Project Accounting Analyst', 'Gurugram')] }],
    ]);
    const { jobs } = await fetchCompanyJobs(RAMBOLL, { fetchImpl: impl });
    assert.equal(jobs.length, 1);
    const [j] = jobs;
    assert.deepEqual([j.title, j.city, j.company, j.applyUrl], ['Architectural Designer', 'Gurugram', 'Ramboll', 'https://jobs.smartrecruiters.com/Ramboll3/11-architectural-designer']);
    assert.match(j.description, /Revit and SketchUp\n\nB\.Arch/);
    assert.match(calls[0].url, /companies\/Ramboll3\/postings\?country=in/);
  });
});

describe('company list', () => {
  it('has unique slugs, careers links and well-formed feeds', () => {
    const slugs = new Set();
    for (const c of COMPANIES) {
      assert.ok(!slugs.has(c.slug), c.slug);
      slugs.add(c.slug);
      assert.match(c.careersUrl, /^https:\/\//, c.name);
      assert.ok(c.cities.length, c.name);
      if (c.feed?.type === 'workday') assert.ok(c.feed.host.endsWith('.myworkdayjobs.com') && c.feed.tenant && c.feed.site, c.name);
      else if (c.feed) assert.ok(c.feed.type === 'smartrecruiters' && c.feed.id, c.name);
    }
    assert.ok(COMPANIES.filter((c) => c.feed).length >= 4);
  });
});
