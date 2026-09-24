// End-to-end tests against a real MySQL database: ingest pipeline, tasks and the REST API.
// Uses TEST_DB_* (defaults match docker-compose.yml + the archjobs_test database) and is skipped
// when that database is not reachable.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, it } from 'node:test';

Object.assign(process.env, {
  DB_HOST: process.env.TEST_DB_HOST || '127.0.0.1',
  DB_PORT: process.env.TEST_DB_PORT || '3307',
  DB_USER: process.env.TEST_DB_USER || 'archjobs',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'archjobs',
  DB_NAME: process.env.TEST_DB_NAME || 'archjobs_test',
  NODE_ENV: 'test',
  APP_PASSWORD: 'test-password',
  SESSION_SECRET: 'test-secret',
  CRON_SECRET: 'cron-secret',
  // Never touch real services from tests, whatever .env says.
  SERPAPI_KEY: '',
  GROQ_API_KEY: '',
  GEMINI_API_KEY: '',
  IMAP_USER: '',
  SMTP_USER: '',
});

const { config } = await import('../server/config.js');
const { query, closePool, parseJson } = await import('../server/db/pool.js');
const { migrate } = await import('../server/db/migrate.js');
const { createApp } = await import('../server/app.js');
const { createClassifier } = await import('../server/lib/classify.js');
const { ingestJobs } = await import('../server/lib/ingest.js');
const { parseLinkedInAlert } = await import('../server/sources/linkedinEmail.js');
const { normalizeSerpJob } = await import('../server/sources/serpapi.js');
const { fetchJobs, searchesForThisRun, pickQueries, searchPairs, searchText } = await import('../server/tasks/fetchJobs.js');
const { resolveLocation } = await import('../server/sources/serpapi.js');
const { feedFilters } = await import('../server/routes/jobs.js');
const { liveSearch, CACHE_HOURS } = await import('../server/tasks/liveSearch.js');
const { parseMessages } = await import('../server/tasks/readInbox.js');
const { archiveOldJobs } = await import('../server/tasks/archive.js');
const { digestDue, renderDigest } = await import('../server/tasks/sendDigest.js');

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = new Date();

let dbReady = false;
try {
  await query('SELECT 1');
  dbReady = true;
} catch (err) {
  console.warn(`Skipping integration tests: test database not reachable (${err.message}). Run \`docker compose up -d\`.`);
  await closePool();
}

describe('integration', { skip: !dbReady }, () => {
  let server;
  let base;
  let cookie = '';

  const request = async (path, { method = 'GET', body, auth = true, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
        ...(auth && cookie && { Cookie: cookie }),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data, res };
  };

  const jobIdByTitle = async (title, company) => {
    const [row] = await query('SELECT id FROM jobs WHERE title = ? AND company = ?', [title, company]);
    return row?.id;
  };

  before(async () => {
    await migrate();
    await query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of ['applications', 'jobs', 'firms', 'fetch_log', 'settings', 'ai_usage', 'searches']) await query(`TRUNCATE TABLE ${table}`);
    await query('SET FOREIGN_KEY_CHECKS = 1');
    server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await closePool();
  });

  it('ingests Google Jobs + LinkedIn alerts, dedupes and classifies', async () => {
    const serp = JSON.parse(fixture('serpapi-google-jobs.json')).jobs_results.map((j) => normalizeSerpJob(j, NOW));
    const email = parseLinkedInAlert({ html: fixture('linkedin-alert.html'), receivedAt: NOW });
    const linkChecker = async (url) => (url.includes('glassdoor') ? 'broken' : 'ok');

    const first = await ingestJobs(serp, { classifier: createClassifier(), linkChecker });
    assert.equal(first.new, 4);

    const second = await ingestJobs(email, { classifier: createClassifier(), linkChecker });
    assert.equal(second.found, 4);
    assert.equal(second.new, 3, 'Studio Lotus BIM Intern should merge into the existing row');
    assert.equal(second.updated, 1);

    const [lotus] = await query("SELECT * FROM jobs WHERE company = 'Studio Lotus'");
    const sources = typeof lotus.sources === 'string' ? JSON.parse(lotus.sources) : lotus.sources;
    assert.deepEqual(sources.map((s) => s.source).sort(), ['google_jobs', 'linkedin_email']);
    assert.equal(lotus.apply_url, 'https://studiolotus.in/careers/bim-intern', 'keeps the direct company link');
    assert.equal(lotus.classifier, 'rules');
    assert.equal(lotus.salary_min, 15000);

    const irrelevant = await query('SELECT title FROM jobs WHERE is_relevant = 0 ORDER BY title');
    assert.deepEqual(
      irrelevant.map((r) => r.title),
      ['Cloud Solution Architect', 'Software Architect - Cloud Platform'],
    );
    const [senior] = await query("SELECT link_status, role_type, city FROM jobs WHERE title = 'Senior Architect'");
    assert.deepEqual({ ...senior }, { link_status: 'broken', role_type: 'experienced', city: 'Remote' });

    // Re-ingesting the same batch changes nothing.
    const again = await ingestJobs(serp, { classifier: createClassifier(), linkChecker });
    assert.equal(again.new, 0);
  });

  it('parses raw forwarded LinkedIn emails', async () => {
    const raw = [
      'From: LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>',
      'To: jobs@example.com',
      'Subject: "bim intern": Studio Lotus - BIM Intern and more',
      'Date: Wed, 24 Sep 2026 08:30:00 +0530',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      fixture('linkedin-alert.html'),
    ].join('\r\n');
    const junk = ['From: someone@example.com', 'Subject: Hello', 'Content-Type: text/plain', '', 'No jobs here'].join('\r\n');
    const { jobs, failures } = await parseMessages([Buffer.from(raw), Buffer.from(junk)]);
    assert.equal(jobs.length, 4);
    assert.equal(jobs[0].postedAt.toISOString(), '2026-09-24T03:00:00.000Z');
    assert.equal(failures.length, 1);
    assert.match(failures[0], /Hello.*no LinkedIn job links/);
  });

  it('requires login', async () => {
    assert.equal((await request('/api/jobs', { auth: false })).status, 401);
    assert.equal((await request('/api/login', { method: 'POST', body: { password: 'nope' }, auth: false })).status, 401);
    const ok = await request('/api/login', { method: 'POST', body: { password: 'test-password' }, auth: false });
    assert.equal(ok.status, 200);
    cookie = ok.res.headers.get('set-cookie').split(';')[0];
    assert.match(ok.res.headers.get('set-cookie'), /HttpOnly/);
    assert.equal((await request('/api/me')).data.authenticated, true);
  });

  it('serves the filtered job feed', async () => {
    const feed = await request('/api/jobs?city=Bengaluru');
    assert.equal(feed.status, 200);
    const titles = feed.data.jobs.map((j) => j.title).sort();
    assert.deepEqual(titles, ['BIM Intern', 'Junior Architect', 'Junior Architect', 'Revit Modeler (Fresher)']);
    const lotus = feed.data.jobs.find((j) => j.company === 'Studio Lotus');
    assert.equal(lotus.is_bim, true);
    assert.deepEqual(lotus.software, ['Revit', 'Navisworks']);

    const all = await request('/api/jobs?city=all&role=all');
    assert.ok(all.data.jobs.some((j) => j.title === 'Senior Architect'), 'experienced roles appear with role=all');

    const revit = await request('/api/jobs?city=all&software=Revit');
    assert.deepEqual(revit.data.jobs.map((j) => j.title).sort(), ['BIM Intern', 'Revit Modeler (Fresher)']);

    const linkedin = await request('/api/jobs?city=all&source=linkedin_email');
    assert.equal(linkedin.data.total, 3);

    const search = await request('/api/jobs?city=all&q=morpho');
    assert.deepEqual(search.data.jobs.map((j) => j.company), ['Morphogenesis']);

    const meta = await request('/api/jobs/meta');
    assert.equal(meta.data.newToday, 4);
    assert.equal(meta.data.followUpsDue, 0);
    assert.equal(meta.data.cities[0].city, 'Bengaluru');
  });

  it('tracks applications with an automatic follow-up', async () => {
    const jobId = await jobIdByTitle('BIM Intern', 'Studio Lotus');
    const saved = await request('/api/applications', { method: 'POST', body: { job_id: jobId, status: 'saved' } });
    assert.equal(saved.status, 201);
    assert.equal(saved.data.application.status, 'saved');
    assert.equal(saved.data.application.follow_up_at, null);

    const applied = await request('/api/applications', { method: 'POST', body: { job_id: jobId, status: 'applied' } });
    const app = applied.data.application;
    assert.equal(app.id, saved.data.application.id, 'same job updates the same tracker entry');
    const days = (new Date(app.follow_up_at) - new Date(app.applied_at)) / 86_400_000;
    assert.equal(Math.round(days), 7);

    const hidden = await request('/api/jobs?city=all&hideApplied=1');
    assert.ok(!hidden.data.jobs.some((j) => j.id === jobId));

    // An overdue follow-up shows in the counter.
    await request(`/api/applications/${app.id}`, { method: 'PATCH', body: { follow_up_at: new Date(Date.now() - 86_400_000).toISOString() } });
    assert.equal((await request('/api/jobs/meta')).data.followUpsDue, 1);

    const manual = await request('/api/applications', { method: 'POST', body: { title: 'Intern at a friend’s studio', company: 'Studio X', status: 'applied' } });
    assert.equal(manual.status, 201);
    assert.equal(manual.data.application.title, 'Intern at a friend’s studio');
    assert.equal((await request('/api/applications', { method: 'POST', body: { status: 'saved' } })).status, 400);
    const badLink = await request('/api/applications', { method: 'POST', body: { title: 'X', apply_url: 'javascript:alert(1)' } });
    assert.equal(badLink.status, 400);
    assert.equal((await request(`/api/applications/${app.id}`, { method: 'PATCH', body: { status: 'ghosted' } })).status, 400);

    const list = await request('/api/applications');
    assert.equal(list.data.applications.length, 2);
  });

  it('hides, reviews and restores jobs', async () => {
    const jobId = await jobIdByTitle('Junior Architect', 'Morphogenesis');
    await request(`/api/jobs/${jobId}/hide`, { method: 'POST', body: { reason: 'Wrong city' } });
    const feed = await request('/api/jobs?city=all');
    assert.ok(!feed.data.jobs.some((j) => j.id === jobId));

    const review = await request('/api/jobs/review');
    assert.equal(review.data.hidden[0].hide_reason, 'Wrong city');
    assert.equal(review.data.filtered.length, 2);

    await request(`/api/jobs/${jobId}/unhide`, { method: 'POST' });
    const cloud = review.data.filtered.find((j) => j.title === 'Cloud Solution Architect');
    await request(`/api/jobs/${cloud.id}/restore`, { method: 'POST' });
    const after = await request('/api/jobs?city=all');
    assert.ok(after.data.jobs.some((j) => j.id === jobId));
    assert.ok(after.data.jobs.some((j) => j.id === cloud.id));
    const [row] = await query('SELECT classifier FROM jobs WHERE id = ?', [cloud.id]);
    assert.equal(row.classifier, 'manual');
    assert.equal((await request('/api/jobs/999999')).status, 404);
  });

  it('manages the firms list', async () => {
    const created = await request('/api/firms', { method: 'POST', body: { name: 'Studio Alpha', city: 'Bengaluru', website: 'alpha.in', contact_email: 'hi@alpha.in' } });
    assert.equal(created.status, 201);
    assert.equal(created.data.firm.website, 'https://alpha.in');
    assert.equal(created.data.firm.status, 'not contacted');
    assert.equal((await request('/api/firms', { method: 'POST', body: { city: 'Pune' } })).status, 400);

    const imported = await request('/api/firms/import', {
      method: 'POST',
      body: { firms: [{ name: 'studio alpha' }, { name: 'BIM Works', city: 'Pune' }, { name: 'Bad', contact_email: 'nope' }] },
    });
    assert.deepEqual(imported.data, { imported: 1, skipped: 1, errors: ['Row 3: Enter a valid email.'] });

    const suggestions = await request('/api/firms/suggestions');
    assert.equal(suggestions.data.firms[0].name, 'Studio Alpha', 'Bengaluru firms first');

    const emailed = await request(`/api/firms/${created.data.firm.id}/emailed`, { method: 'POST' });
    assert.equal(emailed.data.firm.status, 'emailed');
    assert.ok(emailed.data.firm.last_emailed_at);

    const search = await request('/api/firms?q=pune');
    assert.deepEqual(search.data.firms.map((f) => f.name), ['BIM Works']);
  });

  it('validates and saves settings', async () => {
    assert.equal((await request('/api/settings', { method: 'PUT', body: { digest_time: '8am' } })).status, 400);
    assert.equal((await request('/api/settings', { method: 'PUT', body: { search_queries: [] } })).status, 400);
    const saved = await request('/api/settings', {
      method: 'PUT',
      body: { digest_time: '07:30', notification_email: 'me@example.com', extra_exclude_keywords: ['sales', ' sales ', ''], cities: ['Bangalore', 'Bengaluru', 'pune'] },
    });
    assert.deepEqual(saved.data.settings.cities, ['Bengaluru', 'Pune']);
    assert.equal(saved.data.settings.digest_time, '07:30');
    assert.deepEqual(saved.data.settings.extra_exclude_keywords, ['sales']);
    assert.equal(saved.data.settings.display_name, 'Kothu', 'welcome name defaults');
    assert.equal((await request('/api/settings', { method: 'PUT', body: { display_name: 'x'.repeat(41) } })).status, 400);
    const renamed = await request('/api/settings', { method: 'PUT', body: { display_name: '  Bhumika   J ' } });
    assert.equal(renamed.data.settings.display_name, 'Bhumika J');
    assert.equal((await request('/api/jobs/meta')).data.displayName, 'Bhumika J');
    await request('/api/settings', { method: 'PUT', body: { display_name: 'Kothu' } });
    assert.equal(saved.data.settings.search_queries.length, 5, 'defaults kept');

    const system = await request('/api/system');
    assert.equal(system.data.configured.serpapi, false);
    assert.equal(system.data.serpapi.monthlyLimit, 250);
  });

  it('keeps the daily AI budget in MySQL, shared by every session', async () => {
    const labels = { is_relevant: true, role_type: 'internship', is_bim: true, software: ['Revit'], stipend_or_salary: null, match_score: 90, reason: 'BIM intern' };
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify(labels) } }], usage: { total_tokens: 450 } });
    };
    const groq = { apiKey: 'test', model: 'm', timeoutMs: 500, limits: { dailyTokens: 1_000 } };
    const job = { title: 'BIM Intern', company: 'Studio', city: 'Bengaluru', description: 'Revit' };

    const first = createClassifier({ groq, gemini: null, fetchImpl });
    assert.equal((await first.classify(job)).classifier, 'groq');
    // A new session (next task run) sees what the first one spent: 450 used, so the next
    // ~500-token call would pass 1,000 and is not made.
    const second = createClassifier({ groq, gemini: null, fetchImpl });
    assert.equal((await second.classify(job)).classifier, 'rules');
    assert.equal(second.groqDownReason, 'budget:daily_tokens');
    assert.equal(calls, 1);

    const system = await request('/api/system');
    assert.deepEqual(system.data.ai.groq.today, { requests: 1, tokens: 450 });
    assert.equal(system.data.ai.gemini.configured, false);
  });

  it('protects cron endpoints with the cron key', async () => {
    assert.equal((await request('/api/cron/archive', { auth: false })).status, 401);
    const ok = await request('/api/cron/archive?key=cron-secret', { auth: false });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.task, 'archive');
    assert.equal((await request('/api/cron/nope?key=cron-secret', { auth: false })).status, 404);
    const viaHeader = await request('/api/cron/retry-classify', { auth: false, headers: { 'X-Cron-Key': 'cron-secret' } });
    assert.equal(viaHeader.data.skipped, 'No AI key set (GROQ_API_KEY or GEMINI_API_KEY)');
  });

  it('archives jobs older than 30 days unless tracked', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000);
    const insert = (title) =>
      query('INSERT INTO jobs SET ?', [
        { dedupe_key: title.padEnd(40, 'x').slice(0, 40), title, apply_url: 'https://example.com', posted_at: old, created_at: old, updated_at: old },
      ]);
    const stale = await insert('Old untracked role');
    const tracked = await insert('Old tracked role');
    await query('INSERT INTO applications SET ?', [{ job_id: tracked.insertId, status: 'saved', created_at: old, updated_at: old }]);
    assert.equal(await archiveOldJobs(), 1);
    const rows = await query('SELECT id, is_archived FROM jobs WHERE id IN (?) ORDER BY id', [[stale.insertId, tracked.insertId]]);
    assert.deepEqual(rows.map((r) => r.is_archived), [1, 0]);
  });

  it('fetches from SerpApi within the quota, rotating queries across her cities', async () => {
    const serpFixture = fixture('serpapi-google-jobs.json');
    let searchesLeft = 5;
    const searched = [];
    const lookups = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      if (u.pathname === '/account.json') return Response.json({ total_searches_left: searchesLeft, this_month_usage: 250 - searchesLeft });
      if (u.pathname === '/locations.json') {
        const city = u.searchParams.get('q');
        lookups.push(city);
        return Response.json([{ canonical_name: `${city},India`, country_code: 'IN' }]);
      }
      if (u.pathname === '/search.json') {
        searched.push(u.searchParams.get('q'));
        assert.equal(u.searchParams.get('engine'), 'google_jobs');
        assert.equal(u.searchParams.get('gl'), 'in');
        assert.equal(u.searchParams.get('location'), `${u.searchParams.get('q').split(' ').pop()},India`);
        return new Response(serpFixture, { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    };

    config.serpapi.apiKey = 'test-key';
    try {
      const paused = await fetchJobs({ fetchImpl, linkChecker: null });
      assert.match(paused.skipped, /Paused: 5 searches left/);
      assert.equal(searched.length, 0);

      searchesLeft = 200;
      const run = await fetchJobs({ fetchImpl, linkChecker: null });
      assert.equal(run.requestsUsed, 3);
      // Cities saved earlier in this suite: Bengaluru and Pune.
      assert.deepEqual(searched, ['BIM intern Bengaluru', 'BIM intern Pune', 'Revit architect intern Bengaluru']);
      assert.equal(run.new, 0, 'fixture jobs are already stored');

      searched.length = 0;
      await fetchJobs({ fetchImpl, linkChecker: null });
      assert.deepEqual(searched, ['Revit architect intern Pune', 'architectural intern Bengaluru', 'architectural intern Pune']);
      assert.deepEqual(lookups, ['Bengaluru', 'Pune'], 'each city is looked up once, then cached');

      const [log] = await query("SELECT SUM(requests_used) AS used FROM fetch_log WHERE source = 'google_jobs'");
      assert.equal(Number(log.used), 6);
    } finally {
      config.serpapi.apiKey = '';
    }
  });

  it('pairs every query with every city', async () => {
    assert.deepEqual(searchPairs(['a', 'b'], ['X', 'Y']), [
      { query: 'a', city: 'X' },
      { query: 'a', city: 'Y' },
      { query: 'b', city: 'X' },
      { query: 'b', city: 'Y' },
    ]);
    assert.deepEqual(searchPairs(['a'], []), [{ query: 'a', city: '' }]);
    assert.equal(searchText({ query: 'BIM intern', city: 'Mumbai' }), 'BIM intern Mumbai');
    assert.equal(searchText({ query: 'BIM intern Mumbai', city: 'Mumbai' }), 'BIM intern Mumbai');
    assert.equal(searchText({ query: 'BIM intern', city: 'Remote' }), 'BIM intern remote');
    assert.equal(searchText({ query: 'BIM intern', city: '' }), 'BIM intern');

    const kochi = [
      { canonical_name: 'Kochi,Japan', country_code: 'JP' },
      { canonical_name: 'Kochi,Kerala,India', country_code: 'IN' },
    ];
    assert.deepEqual(await resolveLocation('Kochi', { fetchImpl: async () => Response.json(kochi) }), { location: 'Kochi,Kerala,India', gl: 'in' });
    assert.deepEqual(await resolveLocation('Dubai', { fetchImpl: async () => Response.json([{ canonical_name: 'Dubai,United Arab Emirates', country_code: 'AE' }]) }), {
      location: 'Dubai,United Arab Emirates',
      gl: 'ae',
    });
    assert.equal(await resolveLocation('Nowhere', { fetchImpl: async () => Response.json([]) }), null);
  });

  it('filters the feed to her cities', async () => {
    const mine = feedFilters({ city: 'mine' }, new Date(), ['Pune', 'Mumbai']);
    assert.match(mine.where, /j\.city IN \(\?\) OR j\.city IN \('', 'Remote'\)/);
    assert.deepEqual(mine.params, [['Pune', 'Mumbai']]);
    assert.doesNotMatch(feedFilters({ city: 'mine' }, new Date(), []).where, /j\.city/, 'no cities = no city filter');

    const meta = await request('/api/jobs/meta');
    assert.deepEqual(meta.data.myCities, ['Bengaluru', 'Pune']);
    const feed = await request('/api/jobs?city=mine');
    assert.equal(feed.status, 200);
    assert.ok(feed.data.jobs.every((j) => ['Bengaluru', 'Pune', '', 'Remote'].includes(j.city)));
  });

  it('keeps every apply link, best first, and filters by where she can apply', async () => {
    const now = new Date();
    const job = (applyOptions) => ({
      source: 'google_jobs',
      title: 'Architecture Apply Intern',
      company: 'Nest Studio',
      locationText: 'Pune',
      description: '',
      applyOptions,
      applyUrl: applyOptions[0].url,
      postedAt: now,
    });
    const classifier = createClassifier({ groq: null, gemini: null });
    await ingestJobs([job([{ url: 'https://in.bebee.com/job/9', publisher: 'BeBee' }])], { classifier, linkChecker: null, now });
    let [row] = await query("SELECT apply_url, apply_kind, apply_url_rank, apply_options FROM jobs WHERE title = 'Architecture Apply Intern'");
    assert.equal(row.apply_kind, 'aggregator');
    const direct = async () => (await request('/api/jobs?city=Pune&exp=any&apply=direct')).data.jobs.map((j) => j.title);
    assert.ok(!(await direct()).includes('Architecture Apply Intern'), 'reposting-site jobs are left out of "company & LinkedIn"');

    // Seen again with the firm's own careers page: that becomes the Apply link, and both are kept.
    await ingestJobs([job([{ url: 'https://neststudio.in/careers/intern', publisher: 'Nest Studio Careers' }])], { classifier, linkChecker: null, now });
    [row] = await query("SELECT apply_url, apply_kind, apply_url_rank, apply_options FROM jobs WHERE title = 'Architecture Apply Intern'");
    assert.equal(row.apply_url, 'https://neststudio.in/careers/intern');
    assert.equal(row.apply_kind, 'company');
    assert.deepEqual(parseJson(row.apply_options, []).map((o) => o.kind), ['company', 'aggregator']);
    assert.ok((await direct()).includes('Architecture Apply Intern'));
    const [card] = (await request('/api/jobs?city=Pune&exp=any&apply=company')).data.jobs;
    assert.equal(card.apply_options.length, 2, 'the app gets every option');
    const linkedinOnly = async () => (await request('/api/jobs?city=pune&exp=any&linkedin=1')).data.jobs.map((j) => j.title);
    assert.ok(!(await linkedinOnly()).includes('Architecture Apply Intern'), 'no LinkedIn link yet (and "pune" matches Pune)');
    await ingestJobs([job([{ url: 'https://in.linkedin.com/jobs/view/42', publisher: 'LinkedIn' }])], { classifier, linkChecker: null, now });
    assert.ok((await linkedinOnly()).includes('Architecture Apply Intern'), 'a LinkedIn apply option counts');
    await query("DELETE FROM jobs WHERE title = 'Architecture Apply Intern'");
  });

  it('filters the feed by years of experience', async () => {
    const make = (title, exp_min, role_type) =>
      query('INSERT INTO jobs SET ?', [
        { dedupe_key: `exp-${title}`.padEnd(40, 'x').slice(0, 40), title, company: 'Exp Studio', city: 'Pune', apply_url: 'https://x.in', role_type, exp_min, exp_parsed: 1, created_at: NOW, updated_at: NOW },
      ]);
    await make('Exp Fresher', 0, 'fresher');
    await make('Exp One', 1, 'fresher');
    await make('Exp Three', 3, 'experienced');
    await make('Exp Unstated Intern', null, 'internship');
    await make('Exp Unstated Senior', null, 'experienced');
    const titles = async (qs) => (await request(`/api/jobs?city=Pune&${qs}`)).data.jobs.map((j) => j.title).sort();
    assert.deepEqual(await titles('exp=0'), ['Exp Fresher', 'Exp Unstated Intern']);
    assert.deepEqual(await titles('exp=1'), ['Exp Fresher', 'Exp One', 'Exp Unstated Intern']);
    assert.deepEqual(await titles('exp=3'), ['Exp Fresher', 'Exp One', 'Exp Three', 'Exp Unstated Intern']);
    assert.equal((await titles('exp=any')).length, 5, 'filter off shows every level');
    assert.deepEqual(await titles('exp=any&role=internship'), ['Exp Unstated Intern']);
    assert.ok(!(await titles('exp=any&role=job')).includes('Exp Unstated Intern'));
    const [first] = (await request('/api/jobs?city=Pune&exp=any')).data.jobs;
    assert.ok('exp_min' in first && 'exp_max' in first, 'years are sent to the app');
    await query("DELETE FROM jobs WHERE company = 'Exp Studio'");
  });

  it('runs a typed search on Google Jobs, then reuses it for a few hours', async () => {
    const serpFixture = fixture('serpapi-google-jobs.json');
    const calls = [];
    const fetchImpl = async (url) => {
      const u = new URL(url);
      calls.push(u.pathname);
      if (u.pathname === '/account.json') return Response.json({ total_searches_left: 200, this_month_usage: 50 });
      if (u.pathname === '/locations.json') return Response.json([{ canonical_name: 'Mumbai,Maharashtra,India', country_code: 'IN' }]);
      if (u.pathname === '/search.json') {
        assert.equal(u.searchParams.get('q'), 'BIM intern');
        assert.equal(u.searchParams.get('location'), 'Mumbai,Maharashtra,India');
        return new Response(serpFixture, { headers: { 'content-type': 'application/json' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    config.serpapi.apiKey = 'test-key';
    try {
      const first = await liveSearch({ q: '  BIM intern ', location: 'Mumbai', fetchImpl });
      assert.equal(first.cached, false);
      assert.ok(first.ids.length >= 1);
      assert.equal(first.found, JSON.parse(serpFixture).jobs_results.length);

      // The feed shows exactly those jobs, whatever the city filter says.
      const feed = await request(`/api/jobs?ids=${first.ids.join(',')}&city=Nowhere&exp=any`);
      assert.deepEqual(feed.data.jobs.map((j) => j.id).sort(), [...first.ids].sort());

      calls.length = 0;
      const again = await liveSearch({ q: 'BIM intern', location: 'mumbai', fetchImpl });
      assert.equal(again.cached, true, `repeat within ${CACHE_HOURS}h is free, however the city is spelt`);
      assert.equal(again.place, 'Mumbai');
      assert.deepEqual(again.ids, first.ids);
      assert.deepEqual(calls, [], 'no SerpApi call for a repeat');

      const limit = config.serpapi.manualDailyLimit;
      config.serpapi.manualDailyLimit = 1;
      await assert.rejects(liveSearch({ q: 'junior architect', location: 'Mumbai', fetchImpl }), (err) => err.status === 429);
      config.serpapi.manualDailyLimit = limit;
      await assert.rejects(liveSearch({ q: 'x', fetchImpl }), (err) => err.status === 400);
    } finally {
      config.serpapi.apiKey = '';
    }
    const meta = await request('/api/jobs/meta');
    assert.equal(meta.data.search.configured, false);
    assert.equal(typeof meta.data.search.leftToday, 'number');
  });

  it('spreads the SerpApi quota over the month', () => {
    const base = { reserve: 10, queriesPerRun: 3, runsPerDay: 2 };
    assert.equal(searchesForThisRun({ ...base, searchesLeft: 250, daysLeft: 30 }), 3);
    assert.equal(searchesForThisRun({ ...base, searchesLeft: 70, daysLeft: 30 }), 1);
    assert.equal(searchesForThisRun({ ...base, searchesLeft: 10, daysLeft: 3 }), 0);
    assert.deepEqual(pickQueries(['a', 'b'], 1, 3), { picked: ['b', 'a'], nextIndex: 1 });
  });

  it('decides when the digest is due and renders it', () => {
    const at = (iso) => new Date(iso);
    const settings = { digest_enabled: true, digest_time: '08:00', last_digest_on: null };
    assert.equal(digestDue(settings, at('2026-09-24T02:00:00Z')), false, '07:30 IST');
    assert.equal(digestDue(settings, at('2026-09-24T02:35:00Z')), true, '08:05 IST');
    assert.equal(digestDue({ ...settings, last_digest_on: '2026-09-24' }, at('2026-09-24T05:00:00Z')), false);
    assert.equal(digestDue({ ...settings, digest_enabled: false }, at('2026-09-24T05:00:00Z')), false);

    const email = renderDigest({
      jobs: [{ title: 'BIM <Intern>', company: 'Studio', city: 'Bengaluru', apply_url: 'https://x.in', role_type: 'internship', is_bim: 1, salary_min: 15000, salary_max: 20000, salary_period: 'month' }],
      followUps: [{ title: 'Junior Architect', company: 'Firm', follow_up_at: new Date() }],
      firms: [],
    });
    assert.equal(email.subject, 'ArchJobs · 1 new role · 1 follow-up due');
    assert.match(email.html, /BIM &lt;Intern&gt;/);
    assert.match(email.text, /₹15k–20k\/mo/);

    const empty = renderDigest({ jobs: [], followUps: [], firms: [{ name: 'Studio Alpha', city: 'Bengaluru' }] });
    assert.equal(empty.subject, 'ArchJobs · No new roles today');
    assert.match(empty.html, /firms to cold-email/);
  });
});
