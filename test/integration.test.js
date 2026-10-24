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
  FREELLM_URL: '',
  FREELLM_API_KEY: '',
  GROQ_API_KEY: '',
  GEMINI_API_KEY: '',
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
const { parseMessages } = await import('../server/sources/linkedinEmail.js');
const { archiveOldJobs } = await import('../server/tasks/archive.js');
const { digestDue, renderDigest } = await import('../server/tasks/sendDigest.js');
const { createSessionToken } = await import('../server/auth.js');
const { signInWithGoogle } = await import('../server/lib/users.js');
const google = await import('../server/lib/google.js');
const { open: unseal } = await import('../server/lib/secretBox.js');
const { tidyJobs, deleteOldJobs } = await import('../server/tasks/archive.js');
const { syncApplications } = await import('../server/tasks/readGmail.js');
const { fetchCompanies } = await import('../server/tasks/fetchCompanies.js');
const { COMPANIES } = await import('../server/lib/companies.js');

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
    for (const table of ['applications', 'jobs', 'firms', 'fetch_log', 'settings', 'ai_usage', 'searches', 'users', 'user_settings', 'job_hides', 'closed_jobs', 'mail_events']) {
      await query(`TRUNCATE TABLE ${table}`);
    }
    await query('SET FOREIGN_KEY_CHECKS = 1');
    await migrate(); // recreates the owner account
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
    const linkChecker = async (url) => (url.includes('software-architect') ? 'broken' : 'ok');

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
    assert.deepEqual({ ...senior }, { link_status: 'ok', role_type: 'experienced', city: 'Remote' });
    // A posting whose link says it is gone is stored closed, so it never shows.
    const [gone] = await query("SELECT link_status, closed_reason, closed_at IS NOT NULL AS closed FROM jobs WHERE title LIKE 'Software Architect%'");
    assert.deepEqual({ ...gone }, { link_status: 'broken', closed_reason: 'removed', closed: 1 });

    // Re-ingesting the same batch changes nothing.
    const again = await ingestJobs(serp, { classifier: createClassifier(), linkChecker });
    assert.equal(again.new, 0);
  });

  it('parses raw LinkedIn alert emails', async () => {
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
    assert.equal(review.data.filtered.length, 1, 'the closed Software Architect posting is not listed');

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
    assert.equal(viaHeader.data.skipped, 'No AI key set (FREELLM_API_KEY, GROQ_API_KEY or GEMINI_API_KEY)');
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
    const classifier = createClassifier({ freellm: null, groq: null, gemini: null });
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
        calls.push(`${u.searchParams.get('q')} @ ${u.searchParams.get('location')}`);
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
      assert.ok(calls.includes('BIM intern @ Mumbai,Maharashtra,India'));
      assert.equal(first.adjusted, false);

      // Ids come back in Google's order, and sort=relevance keeps it (relevant roles first).
      const ranked = await request(`/api/jobs?ids=${first.ids.join(',')}&exp=any&sort=relevance`);
      const relevantIds = ranked.data.jobs.filter((j) => j.is_relevant).map((j) => j.id);
      assert.deepEqual(relevantIds, first.ids.filter((id) => relevantIds.includes(id)), 'relevant ones keep Google order');

      // The feed shows exactly those jobs that are still open, whatever the city filter says.
      const feed = await request(`/api/jobs?ids=${first.ids.join(',')}&city=Nowhere&exp=any`);
      const open = (await query('SELECT id FROM jobs WHERE id IN (?) AND closed_at IS NULL', [first.ids])).map((r) => r.id);
      assert.deepEqual(feed.data.jobs.map((j) => j.id).sort(), open.sort());
      assert.ok(open.length < first.ids.length, 'the closed posting is left out');

      calls.length = 0;
      const again = await liveSearch({ q: 'BIM intern', location: 'mumbai', fetchImpl });
      assert.equal(again.cached, true, `repeat within ${CACHE_HOURS}h is free, however the city is spelt`);
      assert.equal(again.place, 'Mumbai');
      assert.deepEqual(again.ids, first.ids);
      assert.deepEqual(calls, [], 'no SerpApi call for a repeat');

      // A keyword with a typo and a city in it: tidied for Google, and the exact words on request.
      calls.length = 0;
      const typo = await liveSearch({ q: 'revti jobs in mumbai', location: 'Bengaluru', fetchImpl });
      assert.deepEqual([typo.searched, typo.place, typo.adjusted], ['Revit architect', 'Mumbai', true]);
      assert.ok(calls.includes('Revit architect @ Mumbai,Maharashtra,India'), calls.join(', '));
      calls.length = 0;
      const exact = await liveSearch({ q: 'revti', location: 'Mumbai', exact: true, fetchImpl });
      assert.deepEqual([exact.searched, exact.adjusted], ['revti', false]);
      assert.ok(calls.includes('revti @ Mumbai,Maharashtra,India'));

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
  // --- Accounts -------------------------------------------------------------------------------

  const cookieFor = (userId) => `aj_session=${createSessionToken(userId)}`;
  const as = (userId) => ({ auth: false, headers: { Cookie: cookieFor(userId) } });
  // An unsigned ID token is fine here: it only ever comes straight from Google's token endpoint.
  const idToken = (claims) =>
    ['e30', Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'cid', exp: Math.floor(Date.now() / 1000) + 600, email_verified: true, ...claims })).toString('base64url'), 'sig'].join('.');

  it("keeps each person's tracker, hidden jobs, firms, settings and searches to themselves", async () => {
    config.auth.allowedEmails = ['friend@example.com'];
    try {
      await assert.rejects(signInWithGoogle({ sub: 'g-x', email: 'stranger@example.com', name: 'Stranger' }), (err) => err.code === 'not_allowed');
      const friend = await signInWithGoogle({ sub: 'g-2', email: 'Friend@Example.com', name: 'Asha Rao' });
      assert.equal(friend.email, 'friend@example.com');

      const me = await request('/api/me', as(friend.id));
      assert.deepEqual([me.data.user.email, me.data.user.isAdmin, me.data.user.gmail.connected], ['friend@example.com', false, false]);
      assert.equal((await request('/api/jobs/meta', as(friend.id))).data.displayName, 'Asha');

      // The owner's tracker and firms are not hers.
      assert.ok((await request('/api/applications')).data.applications.length > 0);
      assert.deepEqual((await request('/api/applications', as(friend.id))).data.applications, []);
      assert.deepEqual((await request('/api/firms', as(friend.id))).data.firms, []);

      // Hiding a job hides it for her only.
      const jobId = await jobIdByTitle('Junior Architect', 'Morphogenesis');
      await request(`/api/jobs/${jobId}/hide`, { method: 'POST', body: { reason: 'Not for me' }, ...as(friend.id) });
      assert.ok(!(await request('/api/jobs?city=all', as(friend.id))).data.jobs.some((j) => j.id === jobId));
      assert.ok((await request('/api/jobs?city=all')).data.jobs.some((j) => j.id === jobId));

      // Saving the same job: one tracker entry each.
      const mine = await request('/api/applications', { method: 'POST', body: { job_id: jobId, status: 'saved' }, ...as(friend.id) });
      assert.equal(mine.status, 201);
      const ownerView = await request(`/api/jobs/${jobId}`);
      assert.notEqual(ownerView.data.job.application_id, mine.data.application.id);

      // Her settings are her own; shared ones are for admins.
      const saved = await request('/api/settings', { method: 'PUT', body: { cities: ['Pune'], extra_exclude_keywords: ['x'] }, ...as(friend.id) });
      assert.deepEqual(saved.data.settings.cities, ['Pune']);
      assert.equal(saved.data.settings.extra_exclude_keywords, undefined);
      assert.notDeepEqual((await request('/api/settings')).data.settings.cities, ['Pune']);

      // Admin-only screens.
      assert.equal((await request('/api/system', as(friend.id))).status, 403);
      assert.equal((await request('/api/people', as(friend.id))).status, 403);
      const people = await request('/api/people');
      assert.deepEqual(people.data.users.map((u) => [u.isOwner, u.email]), [[true, null], [false, 'friend@example.com']]);

      // Admins keep the list of who may join.
      const listed = await request('/api/people/allowed', { method: 'PUT', body: { emails: ['New@Example.com'] } });
      assert.deepEqual(listed.data.allowed, ['new@example.com']);
      assert.equal((await request('/api/people/allowed', { method: 'PUT', body: { emails: ['nope'] } })).status, 400);
      const joined = await signInWithGoogle({ sub: 'g-3', email: 'new@example.com', name: 'New Person' });

      // Removing someone removes their own things, not the shared jobs.
      const removed = await request(`/api/people/${friend.id}`, { method: 'DELETE' });
      assert.deepEqual(removed.data.users.map((u) => u.id), [1, joined.id]);
      assert.equal((await query('SELECT COUNT(*) AS n FROM applications WHERE user_id = ?', [friend.id]))[0].n, 0);
      assert.equal((await query('SELECT COUNT(*) AS n FROM job_hides WHERE user_id = ?', [friend.id]))[0].n, 0);
      assert.equal((await request('/api/me', as(friend.id))).data.authenticated, false);
      assert.equal((await request('/api/people/1', { method: 'DELETE' })).status, 400);
    } finally {
      config.auth.allowedEmails = [];
    }
  });

  it('serves the privacy policy to anyone, signed in or not', async () => {
    for (const path of ['/privacy', '/privacy.html']) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const html = await res.text();
      assert.match(html, /<title>Privacy policy · ArchJobs<\/title>/);
      assert.match(html, /Limited Use\s+requirements/, 'the statement Google asks of apps that read Gmail');
    }
  });

  it('signs in with Google, then reads LinkedIn alerts from Gmail', async () => {
    Object.assign(config.google, { clientId: 'cid', clientSecret: 'secret' });
    config.auth.allowedEmails = ['gmail.user@example.com'];
    const realFetch = google.deps.fetch;
    const calls = [];
    const raw = Buffer.from(
      ['From: LinkedIn Job Alerts <jobalerts-noreply@linkedin.com>', 'To: gmail.user@example.com', 'Subject: New jobs', 'Content-Type: text/html; charset=utf-8', '', fixture('linkedin-alert.html')].join('\r\n'),
    ).toString('base64url');
    const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toUTCString();
    const mail = (headers, body) => Buffer.from([...headers, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n')).toString('base64url');
    const appMail = {
      applied: mail(
        ['From: LinkedIn <jobs-noreply@linkedin.com>', `Date: ${daysAgo(5)}`, 'Subject: Gmail User, your application was sent to Morphogenesis'],
        'Your application was sent to Morphogenesis.',
      ),
      interview: mail(
        ['From: Priya Rao <priya@morphogenesis.org>', `Date: ${daysAgo(2)}`, 'Subject: Interview next week'],
        'Hello, we would like to invite you to an interview for the position of Architectural Intern at Morphogenesis.\n> On Mon you wrote:\n> thanks',
      ),
    };
    let grant = {};
    google.deps.fetch = async (url, init = {}) => {
      const u = new URL(url);
      calls.push(`${init.method || 'GET'} ${u.host}${u.pathname}`);
      if (u.pathname === '/token') {
        const form = new URLSearchParams(init.body);
        if (form.get('grant_type') === 'refresh_token') {
          assert.equal(form.get('refresh_token'), 'refresh-1');
          return Response.json({ access_token: 'access-1' });
        }
        assert.equal(form.get('code'), 'the-code');
        return Response.json({ access_token: 'a', id_token: idToken({ sub: 'g-gmail', email: 'gmail.user@example.com', name: 'Gmail User' }), ...grant });
      }
      if (u.pathname === '/revoke') return Response.json({});
      if (u.pathname.endsWith('/messages')) {
        const q = u.searchParams.get('q');
        if (q.includes('your application was sent to')) return Response.json({ messages: [{ id: 'a2' }, { id: 'a1' }] });
        assert.match(q, /from:\(jobalerts-noreply@linkedin\.com/);
        return Response.json({ messages: [{ id: 'm1' }] });
      }
      if (u.pathname.endsWith('/messages/m1')) return Response.json({ id: 'm1', raw });
      if (u.pathname.endsWith('/messages/a1')) return Response.json({ id: 'a1', raw: appMail.applied });
      if (u.pathname.endsWith('/messages/a2')) return Response.json({ id: 'a2', raw: appMail.interview });
      throw new Error(`unexpected ${url}`);
    };
    const go = (path, cookies = '') => fetch(`${base}${path}`, { redirect: 'manual', headers: cookies ? { Cookie: cookies } : {} });
    const cookiesFrom = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]).filter((c) => !c.endsWith('='));
    try {
      // 1. Sign in.
      const start = await go('/api/auth/google/start');
      assert.equal(start.status, 302);
      const to = new URL(start.headers.get('location'));
      assert.equal(to.host, 'accounts.google.com');
      assert.equal(to.searchParams.get('scope'), 'openid email profile');
      const state = to.searchParams.get('state');
      const oauthCookie = cookiesFrom(start).join('; ');

      const forged = await go(`/api/auth/google/callback?state=wrong&code=the-code`, oauthCookie);
      assert.equal(forged.headers.get('location'), '/?auth_error=expired');

      const back = await go(`/api/auth/google/callback?state=${state}&code=the-code`, oauthCookie);
      assert.equal(back.headers.get('location'), '/#/jobs');
      const session = cookiesFrom(back).find((c) => c.startsWith('aj_session='));
      const me = await (await fetch(`${base}/api/me`, { headers: { Cookie: session } })).json();
      assert.equal(me.user.email, 'gmail.user@example.com');

      // 2. Connect Gmail (read-only, offline).
      const gstart = await go('/api/auth/google/start?mode=gmail', session);
      const gto = new URL(gstart.headers.get('location'));
      assert.match(gto.searchParams.get('scope'), /gmail\.readonly/);
      assert.equal(gto.searchParams.get('access_type'), 'offline');
      grant = { refresh_token: 'refresh-1', scope: `openid email profile ${google.GMAIL_SCOPE}` };
      const gback = await go(`/api/auth/google/callback?state=${gto.searchParams.get('state')}&code=the-code`, `${session}; ${cookiesFrom(gstart).join('; ')}`);
      assert.equal(gback.headers.get('location'), '/?gmail=connected#/settings');
      const [row] = await query('SELECT gmail_token FROM users WHERE email = ?', ['gmail.user@example.com']);
      assert.equal(unseal(row.gmail_token), 'refresh-1', 'stored encrypted');
      assert.ok(!row.gmail_token.includes('refresh-1'));

      // Connecting started the first read in the background; let it finish.
      for (let i = 0; i < 100 && !(await query('SELECT gmail_apps_synced_at AS at FROM users WHERE email = ?', ['gmail.user@example.com']))[0].at; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      // 3. Read the alerts.
      const synced = await (await fetch(`${base}/api/account/gmail/sync`, { method: 'POST', headers: { Cookie: session } })).json();
      assert.equal(synced.result.messages, 0, 'the alert was read by the first run, and is not parsed again');
      assert.ok(synced.account.gmail.connected);
      assert.ok(synced.account.gmail.syncedAt);
      assert.ok(calls.includes('GET gmail.googleapis.com/gmail/v1/users/me/messages/m1'));

      // ...and the emails about her applications (read by the first run), oldest first: sent, then
      // an interview. The role named in the second fills in the first entry instead of adding one.
      assert.deepEqual([synced.result.emails, synced.result.tracked], [0, 0]);
      const tracker = (await (await fetch(`${base}/api/applications`, { headers: { Cookie: session } })).json()).applications;
      assert.equal(tracker.length, 1);
      const [entry] = tracker;
      assert.deepEqual(
        [entry.title, entry.company, entry.status, entry.source, entry.contact_email],
        ['Architectural Intern', 'Morphogenesis', 'interview', 'gmail', 'priya@morphogenesis.org'],
      );
      assert.ok(entry.applied_at, 'the application date came from the first email');
      assert.match(entry.notes, /application sent[\s\S]*interview — "Interview next week"/);
      const events = await query("SELECT gmail_id, kind, classifier FROM mail_events WHERE application_id = ? ORDER BY received_at", [entry.id]);
      assert.deepEqual(events.map((e) => [e.gmail_id, e.kind, e.classifier]), [['a1', 'applied', 'rules'], ['a2', 'interview', 'rules']]);

      // Emails read, by day, newest first: today's alert, then the interview, then the application.
      const { days } = await (await fetch(`${base}/api/account/gmail/emails`, { headers: { Cookie: session } })).json();
      assert.deepEqual(days.map((d) => d.emails.map((e) => e.kind)), [['alert'], ['interview'], ['applied']]);
      const [alert] = days[0].emails;
      assert.ok(alert.jobsFound > 0 && alert.from === 'jobalerts-noreply@linkedin.com', JSON.stringify(alert));
      const interview = days[1].emails[0];
      assert.deepEqual([interview.subject, interview.company, interview.tracker.status], ['Interview next week', 'Morphogenesis', 'interview']);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(days[1].day));
      assert.equal((await fetch(`${base}/api/account/gmail/emails`)).status, 401);


      // 4. Disconnect: the permission is withdrawn at Google too.
      const off = await (await fetch(`${base}/api/account/gmail/disconnect`, { method: 'POST', headers: { Cookie: session } })).json();
      assert.equal(off.account.gmail.connected, false);
      assert.ok(calls.includes('POST oauth2.googleapis.com/revoke'));
    } finally {
      google.deps.fetch = realFetch;
      Object.assign(config.google, { clientId: '', clientSecret: '' });
      config.auth.allowedEmails = [];
    }
  });

  it('keeps the tracker up to date from application emails, retrying them while the AI is out', async () => {
    const now = new Date();
    const { insertId: uid } = await query('INSERT INTO users SET ?', [{ email: 'mailer@example.com', name: 'Mailer', created_at: now }]);
    const { insertId: jobId } = await query('INSERT INTO jobs SET ?', [
      { dedupe_key: 'mail-test-hok', title: 'Architectural Designer Intern', company: 'HOK India Pvt Ltd', city: 'Mumbai', apply_url: 'https://hok.example/jobs/1', created_at: now, updated_at: now },
    ]);
    // Saved by hand earlier.
    await query('INSERT INTO applications SET ?', [{ user_id: uid, title: 'Junior Architect', company: 'Studio Lotus', status: 'applied', created_at: now, updated_at: now }]);

    const mail = (id, from, subject, body, date) => ({
      id,
      raw: Buffer.from([`From: ${from}`, `Date: ${date}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n')),
    });
    const inbox = [
      mail('h1', 'Talent <talent@hok.com>', 'Next step: design task', 'Please complete the design exercise for the Architectural Designer Intern role.', 'Wed, 22 Oct 2026 09:00:00 +0530'),
      mail('l1', 'Careers <no-reply@myworkday.com>', 'Update on your application', 'Unfortunately we will not be moving forward.', 'Tue, 21 Oct 2026 09:00:00 +0530'),
      mail('x1', 'Archdaily <news@archdaily.com>', 'Houses of the year', 'This week: 20 houses.', 'Mon, 20 Oct 2026 09:00:00 +0530'),
    ];
    const realFetch = google.deps.fetch;
    google.deps.fetch = async (url) => {
      const u = new URL(url);
      if (u.pathname.endsWith('/messages')) return Response.json({ messages: inbox.map((m) => ({ id: m.id })) });
      const m = inbox.find((x) => u.pathname.endsWith(`/messages/${x.id}`));
      return Response.json({ id: m.id, raw: m.raw.toString('base64url') });
    };
    // Stand-in for FreeLLMAPI: what the model answers for each email, or down.
    const answers = {
      'Next step: design task': { kind: 'assessment', company: 'HOK', role: 'Architectural Designer Intern' },
      'Update on your application': { kind: 'rejected', company: 'Studio Lotus', role: 'Junior Architect' },
      'Houses of the year': { kind: 'other', company: null, role: null },
    };
    const aiTriage = { down: null, triage: async (m) => ({ ...answers[m.subject], reason: '', classifier: 'freellm' }) };
    const outage = { down: 'rate_limit', triage: async () => ({ kind: 'other', company: null, role: null, reason: '', classifier: 'rules' }) };
    const user = async () => (await query('SELECT * FROM users WHERE id = ?', [uid]))[0];
    try {
      // 1. AI out: nothing placed, nothing recorded, read position unchanged.
      assert.deepEqual(await syncApplications(await user(), 'token', { triage: outage, now }), { emails: 3, tracked: 0 });
      assert.equal((await query('SELECT COUNT(*) AS n FROM mail_events WHERE user_id = ?', [uid]))[0].n, 0);
      assert.equal((await user()).gmail_apps_synced_at, null);

      // 2. AI back: the same three emails are read. Two reads at once (connecting Gmail starts one,
      //    "Check now" another) still apply each email once.
      const both = await Promise.all([1, 2].map(async () => syncApplications(await user(), 'token', { triage: aiTriage, now })));
      assert.equal(both[0].tracked + both[1].tracked, 2);
      const apps = await query('SELECT * FROM applications WHERE user_id = ? ORDER BY id', [uid]);
      assert.equal(apps.length, 2);
      const [lotus, hok] = apps;
      assert.deepEqual([lotus.status, lotus.source, lotus.contact_email], ['rejected', null, null], 'moved on; a job-site robot is no contact');
      assert.match(lotus.notes, /not selected/);
      assert.deepEqual([hok.status, hok.job_id, hok.source, hok.contact_email], ['interview', jobId, 'gmail', 'talent@hok.com'], 'linked to the posting in the list');
      const kinds = await query('SELECT gmail_id, kind, application_id FROM mail_events WHERE user_id = ? ORDER BY received_at', [uid]);
      assert.deepEqual(kinds.map((k) => [k.gmail_id, k.kind, k.application_id]), [['x1', 'other', null], ['l1', 'rejected', lotus.id], ['h1', 'assessment', hok.id]]);
      assert.ok((await user()).gmail_apps_synced_at);

      // 3. Again: all already read.
      assert.deepEqual(await syncApplications(await user(), 'token', { triage: aiTriage, now }), { emails: 0, tracked: 0 });

      // 4. Removing the person removes what was read from their mail.
      await query('DELETE FROM users WHERE id = ?', [uid]);
      const { deleteUser } = await import('../server/lib/users.js');
      await deleteUser(uid);
      assert.equal((await query('SELECT COUNT(*) AS n FROM mail_events WHERE user_id = ?', [uid]))[0].n, 0);
    } finally {
      google.deps.fetch = realFetch;
      await query('DELETE FROM jobs WHERE id = ?', [jobId]);
    }
  });

  it('reads company careers feeds into the job list, without SerpApi', async () => {
    const sj = COMPANIES.find((c) => c.slug === 'surbana-jurong');
    const ramboll = COMPANIES.find((c) => c.slug === 'ramboll');
    const calls = [];
    let rambollDown = false;
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(url);
      calls.push(`${init.method || 'GET'} ${u.host}${u.pathname}`);
      assert.ok(!u.host.includes('serpapi'), 'company feeds never use SerpApi');
      if (u.host === sj.feed.host && u.pathname.endsWith('/jobs')) {
        const { offset } = JSON.parse(init.body);
        return Response.json({
          total: 2,
          jobPostings: offset ? [] : [
            { title: 'Graduate Architect', externalPath: '/job/Noida/Graduate-Architect_JR1', locationsText: 'Noida', postedOn: 'Posted 2 Days Ago' },
            { title: 'Data Architect', externalPath: '/job/Noida/Data-Architect_JR2', locationsText: 'Noida', postedOn: 'Posted Today' },
          ],
        });
      }
      if (u.host === sj.feed.host) {
        return Response.json({ jobPostingInfo: { title: 'Graduate Architect', location: 'Noida', country: { descriptor: 'India' }, startDate: '2026-10-20', jobDescription: '<p>Fresh B.Arch graduates, 0-2 years. Revit, AutoCAD.</p>', externalUrl: `https://${sj.feed.host}/SJ_Careers/job/Noida/Graduate-Architect_JR1` } });
      }
      if (u.host === 'api.smartrecruiters.com') {
        if (rambollDown) return new Response('down', { status: 503 });
        if (u.pathname.endsWith('/postings')) return Response.json({ totalFound: 1, content: [{ id: '9', name: 'Architectural Designer', releasedDate: '2026-10-22T00:00:00Z', location: { city: 'Gurugram', country: 'in', fullLocation: 'Gurugram, India' } }] });
        return Response.json({ id: '9', postingUrl: 'https://jobs.smartrecruiters.com/Ramboll3/9-architectural-designer', jobAd: { sections: { jobDescription: { text: '<p>Architecture intern role. B.Arch final year.</p>' } } } });
      }
      throw new Error(`unexpected ${url}`);
    };
    const classifier = createClassifier({ freellm: null, groq: null, gemini: null });
    const now = new Date();

    const first = await fetchCompanies({ companies: [sj, ramboll], fetchImpl, classifier, now });
    assert.deepEqual([first.companies, first.found, first.new, first.errors], [2, 2, 2, undefined]);
    const rows = await query("SELECT title, company, city, apply_kind, sources FROM jobs WHERE JSON_SEARCH(sources, 'one', 'company_careers', NULL, '$[*].source') IS NOT NULL ORDER BY title");
    assert.deepEqual(rows.map((r) => [r.title, r.company, r.city, r.apply_kind]), [['Architectural Designer', 'Ramboll', 'Gurugram', 'company'], ['Graduate Architect', 'Surbana Jurong', 'Noida', 'company']]);
    assert.ok(!calls.some((c) => c.includes('Data-Architect')), 'no detail call for an IT role');
    const [log] = await query("SELECT jobs_new, requests_used, error FROM fetch_log WHERE source = 'company_careers' ORDER BY id DESC LIMIT 1");
    assert.deepEqual([log.jobs_new, log.error], [2, null]);
    assert.equal(log.requests_used, calls.length);

    // Next day: nothing new, no detail calls for roles already stored. One feed down: the other still runs.
    calls.length = 0;
    rambollDown = true;
    const second = await fetchCompanies({ companies: [sj, ramboll], fetchImpl, classifier, now });
    assert.equal(second.new, 0);
    assert.match(second.errors[0], /Ramboll careers answered 503/);
    assert.ok(!calls.some((c) => c.includes('Graduate-Architect_JR1')), 'known role: details not fetched again');

    // The Companies page.
    const { status, data } = await request('/api/companies');
    assert.equal(status, 200);
    assert.equal(data.companies.length, COMPANIES.length);
    const sjRow = data.companies.find((c) => c.slug === 'surbana-jurong');
    assert.deepEqual([sjRow.tracked, sjRow.openRoles, sjRow.lastError], [true, 1, null]);
    assert.ok(data.companies[0].openRoles >= data.companies[data.companies.length - 1].openRoles, 'firms with openings come first');
    assert.ok(sjRow.lastCheckedAt);
    const rRow = data.companies.find((c) => c.slug === 'ramboll');
    assert.match(rRow.lastError, /503/);
    assert.equal(data.companies.find((c) => c.slug === 'gensler').tracked, false);
    assert.equal((await request('/api/companies', { auth: false })).status, 401);
  });

  it('once re-queues architecture jobs the AI wrongly called not relevant', async () => {
    const now = new Date();
    const add = (title, classifier, relevant) =>
      query('INSERT INTO jobs SET ?', [{ dedupe_key: `relabel-${title}`, title, company: 'Relabel Co', city: 'Noida', apply_url: 'https://example.com/r', is_relevant: relevant, classifier, classify_attempts: 1, created_at: now, updated_at: now }]);
    await add('Landscape Architect I', 'freellm', 0);
    await add('Solution Architect', 'freellm', 0);
    await add('Senior Architect', 'freellm', 1);
    await query("DELETE FROM settings WHERE k = 'relevance_relabel_v1'");
    await migrate();
    const rows = await query("SELECT title, classifier, classify_attempts FROM jobs WHERE company = 'Relabel Co' ORDER BY title");
    assert.deepEqual(rows.map((r) => [r.title, r.classifier, r.classify_attempts]), [
      ['Landscape Architect I', 'rules', 0],
      ['Senior Architect', 'freellm', 1],
      ['Solution Architect', 'freellm', 1],
    ]);
    // Only once: a later AI answer of "not relevant" stands.
    await query("UPDATE jobs SET classifier = 'freellm' WHERE company = 'Relabel Co'");
    await migrate();
    assert.equal((await query("SELECT classifier FROM jobs WHERE title = 'Landscape Architect I' AND company = 'Relabel Co'"))[0].classifier, 'freellm');
    await query("DELETE FROM jobs WHERE company = 'Relabel Co'");
  });

  it('keeps her search history, with only the results still open', async () => {
    const [a, b] = (await query('SELECT id FROM jobs WHERE closed_at IS NULL AND is_archived = 0 ORDER BY id LIMIT 2')).map((r) => r.id);
    const [closed] = (await query('SELECT id FROM jobs WHERE closed_at IS NOT NULL LIMIT 1')).map((r) => r.id);
    const at = (h) => new Date(Date.now() - h * 3_600_000);
    await query('INSERT INTO searches (user_id, query, location, searched_at, job_ids, found) VALUES ?', [
      [
        [1, 'Revit architect', 'Pune', at(30), JSON.stringify([a, closed]), 2],
        [1, 'revit architect', 'pune', at(2), JSON.stringify([b]), 1],
        [1, 'Old search', '', at(50), JSON.stringify([closed]), 1],
        [2, 'Not hers', '', at(1), JSON.stringify([a]), 1],
      ],
    ]);
    const history = await request('/api/search/history');
    const revit = history.data.searches.find((h) => h.query.toLowerCase() === 'revit architect' && h.location.toLowerCase() === 'pune');
    assert.deepEqual(revit.ids, [b, a], 'both runs merged, newest first, closed one left out');
    assert.equal(revit.runs, 2);
    assert.ok(!history.data.searches.some((h) => h.query === 'Old search'), 'nothing open left');
    assert.ok(!history.data.searches.some((h) => h.query === 'Not hers'));

    await request('/api/search/history', { method: 'DELETE', body: { query: 'Revit architect', location: 'Pune' } });
    await request('/api/search/history', { method: 'DELETE', body: { query: 'revit architect', location: 'pune' } });
    assert.ok(!(await request('/api/search/history')).data.searches.some((h) => h.location.toLowerCase() === 'pune'));
  });

  it('closes postings past their deadline or taken down, then deletes them', async () => {
    const now = new Date();
    const day = 86_400_000;
    const fmt = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
    const job = (title, extra) => ({
      source: 'google_jobs', title, company: 'Close Studio', locationText: 'Pune, Maharashtra', description: 'Architecture intern. Revit.',
      applyUrl: `https://close.example.com/${encodeURIComponent(title)}`, publisher: 'Close Studio', postedAt: new Date(now.getTime() - 2 * day), ...extra,
    });
    const ok = async (url) => (url.includes('dead') ? 'broken' : 'ok');
    await ingestJobs(
      [
        job('Past Deadline Intern', { description: `Architecture intern. Last date to apply: ${fmt(new Date(now.getTime() - 1 * day))}.` }),
        job('Future Deadline Intern', { description: `Architecture intern. Apply before ${fmt(new Date(now.getTime() + 3 * day))}.` }),
        job('Moved Link Intern', { applyOptions: [{ url: 'https://close.example.com/dead-1', publisher: 'Close Studio' }, { url: 'https://in.linkedin.com/jobs/view/77', publisher: 'LinkedIn' }] }),
        job('Gone Intern', { applyOptions: [{ url: 'https://close.example.com/ok-now', publisher: 'Close Studio' }] }),
      ],
      { classifier: createClassifier({ freellm: null, groq: null, gemini: null }), linkChecker: async () => 'ok', now },
    );
    const state = async (title) => (await query('SELECT id, closed_reason, deadline_at, apply_url FROM jobs WHERE title = ?', [title]))[0];
    assert.equal((await state('Past Deadline Intern')).closed_reason, 'deadline', 'closed as it came in');
    assert.ok((await state('Future Deadline Intern')).deadline_at);
    assert.equal((await state('Future Deadline Intern')).closed_reason, null);

    // Later: the deadline passes, one link moved, one posting was taken down.
    await query(
      "UPDATE jobs SET apply_url = 'https://close.example.com/dead-2', apply_options = JSON_ARRAY(JSON_OBJECT('url', 'https://close.example.com/dead-2')), link_checked_at = NULL WHERE title = 'Gone Intern'",
    );
    await query("UPDATE jobs SET link_checked_at = NULL WHERE title = 'Moved Link Intern'");
    const tracked = await state('Future Deadline Intern');
    await request('/api/applications', { method: 'POST', body: { job_id: tracked.id, status: 'applied' } });
    const later = new Date(now.getTime() + 4 * day);
    const summary = await tidyJobs({ now: later, linkChecker: ok });
    assert.ok(summary.closedByDeadline >= 1 && summary.closedRemoved >= 1 && summary.relinked >= 1, JSON.stringify(summary));
    assert.equal((await state('Future Deadline Intern')).closed_reason, 'deadline');
    assert.equal((await state('Gone Intern')).closed_reason, 'removed');
    assert.deepEqual([(await state('Moved Link Intern')).closed_reason, (await state('Moved Link Intern')).apply_url], [null, 'https://in.linkedin.com/jobs/view/77']);
    assert.ok(!(await request('/api/jobs?city=all&exp=any')).data.jobs.some((j) => j.company === 'Close Studio' && j.title !== 'Moved Link Intern'));
    const app = (await request('/api/applications')).data.applications.find((x) => x.job_id === tracked.id);
    assert.equal(app.closed_reason, 'deadline', 'her tracker says it closed');

    // Two weeks on they are deleted, except the one in her tracker, and stay gone.
    await deleteOldJobs(new Date(later.getTime() + 15 * day));
    assert.equal(await state('Gone Intern'), undefined);
    assert.ok(await state('Future Deadline Intern'), 'kept: it is in her tracker');
    const again = await ingestJobs([job('Gone Intern')], { classifier: createClassifier({ freellm: null, groq: null, gemini: null }), linkChecker: null, now: later });
    assert.deepEqual([again.new, again.skippedClosed], [0, 1]);
  });
});
