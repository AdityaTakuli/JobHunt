// Job emails from any sender (Glassdoor, Naukri, newsletters): the email as text with numbered
// links, the AI answer check, and the job rows made from it. The Glassdoor fixture is rebuilt
// from a real alert (27 Oct 2026); its links are made up.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { memoryUsageStore } from '../server/lib/aiBudget.js';
import { JOB_EMAIL_QUERY } from '../server/lib/google.js';
import { createMailTriage } from '../server/lib/mailTriage.js';
import { parseSalary } from '../server/lib/salary.js';
import { emailToText, jobsFromEmail, mightListJobs, publisherOf, resolveJobLink, stripTracking, validateJobList } from '../server/sources/jobEmail.js';

const html = readFileSync(new URL('./fixtures/glassdoor-alert.html', import.meta.url), 'utf8');
const MAIL = {
  from: 'Glassdoor Jobs <noreply@glassdoor.com>',
  fromName: 'Glassdoor Jobs',
  fromAddress: 'noreply@glassdoor.com',
  subject: 'Internationalisation Architect at Moyo Innovations and 11 more jobs in Bengaluru for you. Apply Now.',
  receivedAt: new Date('2026-10-27T10:35:00Z'),
};

describe('job email text', () => {
  it('numbers job links, wraps whole-card links and leaves out footer and unsubscribe links', () => {
    const { text, links } = emailToText({ html });
    assert.match(text, /\[L2\]\ncapstone Life\nArchitect Designer\nBengaluru\n₹1M \(Employer Est\.\)\n⚡ Easy Apply\nJust posted\n\[\/L2\]/);
    assert.match(text, /See more jobs \[L8\]/);
    assert.match(links[1], /jobListingId=1000234567/);
    assert.doesNotMatch(text, /unsubscribe|privacy|student@example\.com|display:none|Internationalisation Architect at Moyo/i);
    assert.ok(!links.some((l) => /unsubscribe|privacy|settings/.test(l)));
    assert.ok(mightListJobs({ subject: MAIL.subject, text }, links));
  });

  it('numbers bare links in plain-text emails', () => {
    const { text, links } = emailToText({ text: 'BIM Intern at RSP, Bengaluru\nApply: https://rsp.example.com/jobs/12?utm_source=mail\n\nUnsubscribe: https://x.example.com/u' });
    assert.equal(text, 'BIM Intern at RSP, Bengaluru\nApply: [L1]\nUnsubscribe: [L2]');
    assert.equal(links[0], 'https://rsp.example.com/jobs/12?utm_source=mail');
  });

  it('skips the AI for emails without links or job words', () => {
    assert.equal(mightListJobs({ subject: 'Your OTP', text: 'Use 4829' }, ['https://a.example.com']), false);
    assert.equal(mightListJobs({ subject: 'We are hiring', text: 'Reply to this email' }, []), false);
  });

  it('searches every sender by job words, leaving LinkedIn alerts to their own parser', () => {
    assert.match(JOB_EMAIL_QUERY, /^-from:\(jobalerts-noreply@linkedin\.com/);
    assert.match(JOB_EMAIL_QUERY, /"job alert"/);
    assert.match(JOB_EMAIL_QUERY, /subject:\(job OR jobs OR hiring/);
  });
});

describe('job email answer', () => {
  it('accepts only the expected shape and drops openings without a title', () => {
    assert.equal(validateJobList({ jobs: 'none' }), null);
    assert.equal(validateJobList([]), null);
    assert.deepEqual(validateJobList({ jobs: [] }), { jobs: [] });
    const { jobs } = validateJobList({
      jobs: [
        { title: ' Senior Architect ', company: 'buildAhome', location: 'Bengaluru', salary: '₹51K - ₹86K', posted_days_ago: 3, link: 'L5' },
        { title: '', company: 'X', link: 'L2' },
        { title: 'Architect', company: 'N/A', location: null, salary: null, posted_days_ago: -1, link: '[L4]' },
        { title: 'Architect', link: 'see more' },
      ],
    });
    assert.deepEqual(jobs, [
      { title: 'Senior Architect', company: 'buildAhome', location: 'Bengaluru', salary: '₹51K - ₹86K', postedDaysAgo: 3, link: 5 },
      { title: 'Architect', company: null, location: null, salary: null, postedDaysAgo: null, link: 4 },
      { title: 'Architect', company: null, location: null, salary: null, postedDaysAgo: null, link: null },
    ]);
  });

  it('makes job rows with the link, pay, city and posting date, skipping openings without a link', () => {
    const { links } = emailToText({ html });
    const rows = jobsFromEmail(
      {
        jobs: [
          { title: 'Internationalisation Architect', company: 'Moyo Innovations', location: 'Bengaluru', salary: '₹3M - ₹4M (Employer Est.)', postedDaysAgo: 0, link: 3 },
          { title: 'Senior Architect', company: 'buildAhome', location: 'Bengaluru', salary: '₹51K - ₹86K (Employer Est.)', postedDaysAgo: 3, link: 5 },
          { title: 'Architect', company: 'Somewhere', location: 'India', salary: null, postedDaysAgo: null, link: null },
          { title: 'Ghost', company: 'Nobody', location: null, salary: null, postedDaysAgo: null, link: 99 },
        ],
      },
      { links, mail: MAIL },
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      { ...rows[0], salary: undefined },
      {
        source: 'job_email',
        title: 'Internationalisation Architect',
        company: 'Moyo Innovations',
        locationText: 'Bengaluru',
        city: 'Bengaluru',
        description: '',
        applyUrl: links[2],
        publisher: 'Glassdoor',
        postedAt: MAIL.receivedAt,
        salary: undefined,
      },
    );
    assert.deepEqual(rows[0].salary, { text: '₹3M - ₹4M', min: 3_000_000, max: 4_000_000, period: 'year' });
    assert.equal(rows[1].postedAt.toISOString(), '2026-10-24T10:35:00.000Z');
    assert.equal(rows[1].salary.period, 'month');
  });

  it('names the site that sent the email', () => {
    assert.equal(publisherOf({ fromName: 'Glassdoor Jobs', fromAddress: 'noreply@glassdoor.com' }), 'Glassdoor');
    assert.equal(publisherOf({ fromName: 'Naukri Job Alerts', fromAddress: 'info@naukri.com' }), 'Naukri');
    assert.equal(publisherOf({ fromName: 'Internshala', fromAddress: 'student@internshala.com' }), 'Internshala');
    assert.equal(publisherOf({ fromName: 'no-reply', fromAddress: 'alerts@mail.archinect.com' }), 'Archinect');
  });

  it('reads millions as Glassdoor writes them', () => {
    assert.deepEqual(parseSalary('₹1M (Employer Est.)'), { text: '₹1M', min: 1_000_000, max: 1_000_000, period: 'year' });
    assert.equal(parseSalary('stipend for 3 months'), null);
  });
});

describe('job email links', () => {
  it('follows click trackers to the job page and drops tracking parameters', async () => {
    const hops = {
      'https://click.example.com/c/abc?e=student%40example.com': 'https://www.glassdoor.co.in/partner/jobListing.htm?jobListingId=1009&utm_source=jobalert&uid=42&pos=3',
    };
    const fetchImpl = async (url, init) => {
      assert.equal(init.redirect, 'manual');
      return hops[url] ? new Response(null, { status: 302, headers: { location: hops[url] } }) : new Response('job page', { status: 200 });
    };
    assert.equal(await resolveJobLink('https://click.example.com/c/abc?e=student%40example.com', { fetchImpl }), 'https://www.glassdoor.co.in/partner/jobListing.htm?jobListingId=1009&pos=3');
  });

  it('keeps a tracker link whole when it cannot be followed', async () => {
    const url = 'https://click.example.com/c/abc?token=t1';
    assert.equal(await resolveJobLink(url, { fetchImpl: async () => { throw new Error('offline'); } }), url);
    assert.equal(stripTracking('https://naukri.com/job-listings-123?src=mail&experience=0&utm_medium=email'), 'https://naukri.com/job-listings-123?experience=0');
  });
});

describe('job email AI', () => {
  const freellm = { url: 'https://llm.example.com', apiKey: 'k', model: 'm1', mailModel: 'mail-model', timeoutMs: 200, limits: {} };

  it('asks the mail model for the openings, with the email text and numbered links', async () => {
    const { text } = emailToText({ html });
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'mail-model');
      assert.match(body.messages[0].content, /list the job openings/);
      assert.match(body.messages[1].content, /^From: Glassdoor Jobs <noreply@glassdoor\.com>\nSubject: Internationalisation Architect/);
      assert.match(body.messages[1].content, /\[L3\]\nMoyo Innovations/);
      const content = JSON.stringify({ jobs: [{ title: 'Internationalisation Architect', company: 'Moyo Innovations', location: 'Bengaluru', salary: '₹3M - ₹4M', posted_days_ago: 0, link: 'L3' }] });
      return Response.json({ choices: [{ message: { content } }], usage: { total_tokens: 900 } });
    };
    const t = createMailTriage({ freellm, fetchImpl, usageStore: memoryUsageStore() });
    const out = await t.extractJobs(MAIL, text);
    assert.equal(out.jobs.length, 1);
    assert.equal(out.jobs[0].link, 3);
    assert.equal(t.stats.ai, 1);
  });

  it('answers null while the AI is out, so the email is read on a later run', async () => {
    const t = createMailTriage({ freellm, fetchImpl: async () => new Response('', { status: 429 }), usageStore: memoryUsageStore() });
    assert.equal(await t.extractJobs(MAIL, 'text'), null);
    assert.equal(t.down, 'rate_limit');
    const off = createMailTriage({ freellm: { ...freellm, apiKey: '' }, fetchImpl: () => assert.fail('no call'), usageStore: memoryUsageStore() });
    assert.equal(await off.extractJobs(MAIL, 'text'), null);
  });
});
