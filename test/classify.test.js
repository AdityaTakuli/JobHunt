import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBudget, memoryUsageStore, SERVER_REQUEST_RESERVE } from '../server/lib/aiBudget.js';
import { canonicalSoftware, createClassifier, labelsToColumns } from '../server/lib/classify.js';
import { classifyWithGemini } from '../server/lib/gemini.js';
import { classifyWithGroq, validateLabels } from '../server/lib/groq.js';
import { requestEstimate, userPrompt } from '../server/lib/llm.js';
import { classifyWithRules, detectRoleType, minYearsRequired } from '../server/lib/rules.js';
import { istDateString } from '../server/lib/time.js';

const GOOD = {
  is_relevant: true,
  role_type: 'internship',
  is_bim: true,
  software: ['Autodesk Revit', 'navisworks'],
  stipend_or_salary: '₹15,000 per month',
  match_score: 92,
  reason: 'BIM internship in Bengaluru',
};

const asText = (content) => (typeof content === 'string' ? content : JSON.stringify(content));
const groqResponse = (content, { tokens, remaining } = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content: asText(content) } }], ...(tokens && { usage: { total_tokens: tokens } }) }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(remaining != null && { 'x-ratelimit-remaining-requests': String(remaining) }) },
  });
const geminiResponse = (content, tokens) =>
  Response.json({ candidates: [{ content: { parts: [{ text: asText(content) }] } }], ...(tokens && { usageMetadata: { totalTokenCount: tokens } }) });

const JOB = { title: 'BIM Intern', company: 'Studio', city: 'Bengaluru', description: 'Revit modelling intern' };
const groqConfig = { apiKey: 'test', model: 'test-model', timeoutMs: 200 };
const geminiConfig = { apiKey: 'test', model: 'test-gemini', timeoutMs: 200 };
const TODAY = istDateString();

// A classifier session that never touches MySQL or the real .env keys.
const session = (options) => createClassifier({ gemini: null, usageStore: memoryUsageStore(), ...options });

describe('rule-based classifier', () => {
  it('keeps architecture/BIM roles and scores them per the PRD', () => {
    const job = { title: 'BIM Intern', city: 'Bengaluru', description: 'Revit and Navisworks. Stipend ₹12,000 per month.' };
    const labels = classifyWithRules(job, { cities: ['Mumbai', 'Bengaluru'] });
    assert.equal(labels.is_relevant, true);
    assert.equal(labels.role_type, 'internship');
    assert.equal(labels.is_bim, true);
    assert.deepEqual(labels.software, ['Revit', 'Navisworks']);
    assert.equal(labels.match_score, 100); // 40 + BIM 20 + intern 20 + one of her cities 20
    assert.equal(classifyWithRules(job, { cities: ['Pune'] }).match_score, 80, 'no city bonus outside her cities');
    assert.match(labels.stipend_or_salary, /12,000/);
  });

  it('drops IT "architect" roles', () => {
    for (const title of ['Software Architect', 'Cloud Solution Architect', 'Data Architect', 'Salesforce Architect', 'AWS Architect']) {
      assert.equal(classifyWithRules({ title, description: '' }).is_relevant, false, title);
    }
    const itRole = classifyWithRules({ title: 'Architect', description: 'Design Java microservices on AWS cloud with data pipelines.' });
    assert.equal(itRole.is_relevant, false);
  });

  it('does not drop BIM roles whose description mentions data', () => {
    const labels = classifyWithRules({ title: 'BIM Modeler', description: 'Manage BIM data and cloud-based model coordination in Revit.' });
    assert.equal(labels.is_relevant, true);
  });

  it('honours extra exclude keywords from Settings', () => {
    assert.equal(classifyWithRules({ title: 'Architectural Sales Executive' }, { extraExclude: ['sales'] }).is_relevant, false);
  });

  it('detects role type', () => {
    assert.equal(detectRoleType('Junior Architect', ''), 'fresher');
    assert.equal(detectRoleType('Architect', 'Minimum 5 years of experience required'), 'experienced');
    assert.equal(detectRoleType('Architect', '0-1 years of experience'), 'fresher');
    assert.equal(detectRoleType('Senior BIM Coordinator', ''), 'experienced');
    assert.equal(detectRoleType('Architectural Trainee', ''), 'internship');
    assert.equal(minYearsRequired('A 5-year B.Arch degree is required'), null);
    assert.equal(minYearsRequired('3+ years of relevant experience'), 3);
  });
});

describe('Groq classifier', () => {
  it('validates the strict JSON shape', () => {
    assert.ok(validateLabels(GOOD));
    assert.equal(validateLabels({ ...GOOD, role_type: 'senior' }), null);
    assert.equal(validateLabels({ ...GOOD, match_score: '90' }), null);
    assert.equal(validateLabels({ ...GOOD, is_bim: 'yes' }), null);
    assert.equal(validateLabels([GOOD]), null);
    assert.equal(validateLabels({ ...GOOD, match_score: 180 }).match_score, 100);
  });

  it('returns labels from a good response', async () => {
    const labels = await classifyWithGroq(JOB, { ...groqConfig, fetchImpl: async () => groqResponse(GOOD) });
    assert.equal(labels.match_score, 92);
  });

  it('retries invalid JSON once', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls === 1 ? groqResponse('not json') : groqResponse(GOOD);
    };
    const labels = await classifyWithGroq(JOB, { ...groqConfig, fetchImpl });
    assert.equal(calls, 2);
    assert.equal(labels.is_bim, true);
  });

  it('falls back to rules on 429 and stops calling Groq for the batch', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return new Response('{"error":"rate"}', { status: 429 });
    };
    const classifier = session({ groq: groqConfig, fetchImpl });
    const a = await classifier.classify(JOB);
    const b = await classifier.classify(JOB);
    assert.equal(a.classifier, 'rules');
    assert.equal(b.classifier, 'rules');
    assert.equal(calls, 1);
    assert.equal(classifier.groqDownReason, 'rate_limit');
  });

  it('falls back to rules after invalid JSON twice, but keeps using Groq for the next job', async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return calls <= 2 ? groqResponse('{"is_relevant": "maybe"}') : groqResponse(GOOD);
    };
    const classifier = session({ groq: groqConfig, fetchImpl });
    assert.equal((await classifier.classify(JOB)).classifier, 'rules');
    assert.equal((await classifier.classify(JOB)).classifier, 'groq');
    assert.equal(calls, 3);
  });

  it('falls back to rules on timeout', async () => {
    const fetchImpl = (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    const classifier = session({ groq: { ...groqConfig, timeoutMs: 50 }, fetchImpl });
    // AbortSignal.timeout() timers are unref'd; keep the loop alive as a real socket would.
    const keepAlive = setTimeout(() => {}, 1000);
    const out = await classifier.classify(JOB);
    clearTimeout(keepAlive);
    assert.equal(out.classifier, 'rules');
    assert.equal(classifier.groqDownReason, 'timeout');
  });

  it('uses rules when no API key is set', async () => {
    const classifier = session({ groq: { ...groqConfig, apiKey: '' }, fetchImpl: () => assert.fail('should not call Groq') });
    assert.equal((await classifier.classify(JOB)).classifier, 'rules');
  });

  it('maps Groq labels onto job columns', () => {
    assert.deepEqual(canonicalSoftware(['Autodesk Revit', 'revit', 'Blender']), ['Revit', 'Blender']);
    const cols = labelsToColumns(validateLabels(GOOD), 'groq', { salary_text: null });
    assert.equal(cols.software, '["Revit","Navisworks"]');
    assert.equal(cols.salary_min, 15000);
    assert.equal(cols.salary_period, 'month');
  });
});

describe('Gemini classifier', () => {
  it('returns labels and asks for JSON without thinking tokens', async () => {
    let sent;
    const fetchImpl = async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return geminiResponse(GOOD, 180);
    };
    const usage = [];
    const labels = await classifyWithGemini(JOB, { ...geminiConfig, thinkingLevel: 'minimal', fetchImpl, onUsage: (u) => usage.push(u) });
    assert.equal(labels.match_score, 92);
    assert.match(sent.url, /models\/test-gemini:generateContent$/);
    assert.equal(sent.headers['x-goog-api-key'], 'test');
    assert.equal(sent.body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(sent.body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
    assert.deepEqual(usage, [{ tokens: 180 }]);
  });

  it('takes over when Groq is rate-limited', async () => {
    const fetchImpl = async (url) =>
      url.includes('groq.com') ? new Response('{}', { status: 429 }) : geminiResponse(GOOD, 150);
    const classifier = session({ groq: groqConfig, gemini: geminiConfig, fetchImpl });
    const out = await classifier.classify(JOB);
    assert.equal(out.classifier, 'gemini');
    assert.equal(classifier.downReasons.groq, 'rate_limit');
    assert.equal(classifier.aiAvailable, true);
  });
});

describe('AI token guardrails', () => {
  const okGroq = (tokens = 400, remaining) => async () => groqResponse(GOOD, { tokens, remaining });

  it('counts the tokens each call reports against today', async () => {
    const usageStore = memoryUsageStore();
    const classifier = session({ groq: { ...groqConfig, limits: { dailyTokens: 10_000 } }, fetchImpl: okGroq(400), usageStore });
    await classifier.classify(JOB);
    await classifier.classify(JOB);
    assert.deepEqual(usageStore.days.get(`groq:${TODAY}`), { requests: 2, tokens: 800 });
    assert.equal(classifier.stats.tokens, 800);
    assert.equal(classifier.stats.requests, 2);
  });

  it('does not call Groq when the daily token budget would be exceeded', async () => {
    const usageStore = memoryUsageStore({ [`groq:${TODAY}`]: { requests: 10, tokens: 9_900 } });
    const classifier = session({
      groq: { ...groqConfig, limits: { dailyTokens: 10_000 } },
      usageStore,
      fetchImpl: () => assert.fail('should not call Groq'),
    });
    const out = await classifier.classify(JOB);
    assert.equal(out.classifier, 'rules');
    assert.equal(classifier.groqDownReason, 'budget:daily_tokens');
  });

  it('does not call Groq past the daily request limit', async () => {
    const usageStore = memoryUsageStore({ [`groq:${TODAY}`]: { requests: 900, tokens: 0 } });
    const classifier = session({ groq: { ...groqConfig, limits: { dailyRequests: 900 } }, usageStore, fetchImpl: () => assert.fail('no call') });
    assert.equal((await classifier.classify(JOB)).classifier, 'rules');
    assert.equal(classifier.groqDownReason, 'budget:daily_requests');
  });

  it('caps what one session (task run) may spend', async () => {
    const estimate = requestEstimate(JOB, {});
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return groqResponse(GOOD, { tokens: estimate });
    };
    // Room for two calls, not three.
    const classifier = session({ groq: { ...groqConfig, limits: { runTokens: estimate * 2.5 } }, fetchImpl });
    const labeledBy = [];
    for (let i = 0; i < 4; i += 1) labeledBy.push((await classifier.classify(JOB)).classifier);
    assert.deepEqual(labeledBy, ['groq', 'groq', 'rules', 'rules']);
    assert.equal(calls, 2);
    assert.equal(classifier.groqDownReason, 'budget:run_tokens');
  });

  it("stops when Groq's own count of requests left today runs low", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return groqResponse(GOOD, { tokens: 300, remaining: SERVER_REQUEST_RESERVE });
    };
    const classifier = session({ groq: groqConfig, fetchImpl });
    assert.equal((await classifier.classify(JOB)).classifier, 'groq');
    assert.equal((await classifier.classify(JOB)).classifier, 'rules');
    assert.equal(calls, 1);
    assert.equal(classifier.groqDownReason, 'budget:daily_requests');
  });

  it('counts the estimate when Groq rejects invalid JSON without reporting usage', async () => {
    const usageStore = memoryUsageStore();
    const fetchImpl = async () => new Response('{"error":{"code":"json_validate_failed"}}', { status: 400 });
    const classifier = session({ groq: groqConfig, fetchImpl, usageStore });
    assert.equal((await classifier.classify(JOB)).classifier, 'rules');
    const used = usageStore.days.get(`groq:${TODAY}`);
    assert.equal(used.requests, 2); // first try + one retry
    assert.equal(used.tokens, requestEstimate(JOB, {}) * 2);
  });

  it('does not spend tokens when usage cannot be read', async () => {
    const usageStore = {
      ...memoryUsageStore(),
      get: async () => {
        throw new Error('db down');
      },
    };
    const classifier = session({ groq: groqConfig, usageStore, fetchImpl: () => assert.fail('no call') });
    assert.equal((await classifier.classify(JOB)).classifier, 'rules');
    assert.equal(classifier.groqDownReason, 'budget:budget_unavailable');
  });

  it('waits for the per-minute window, but not longer than maxWaitMs', async () => {
    let clock = 0;
    const slept = [];
    const opts = { store: memoryUsageStore(), now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } };
    const budget = createBudget('groq', { minuteTokens: 1_000 }, { ...opts, maxWaitMs: 90_000 });
    assert.equal(await budget.reserve(600), null);
    await budget.record({ tokens: 600 });
    clock = 10_000;
    assert.equal(await budget.reserve(600), null, 'waits until the first call leaves the window');
    assert.equal(slept.length, 1);
    assert.ok(clock >= 60_000);

    const impatient = createBudget('groq', { minuteTokens: 1_000 }, { ...opts, maxWaitMs: 5_000 });
    await impatient.record({ tokens: 900 });
    assert.equal(await impatient.reserve(600), 'minute_tokens');
    assert.equal(await impatient.reserve(5_000), 'minute_tokens', 'a call bigger than the window never fits');
  });

  it('hands a job to Gemini while the Groq minute window is full, then goes back to Groq', async () => {
    const usageStore = memoryUsageStore();
    usageStore.window('groq').push({ at: Date.now(), tokens: 7_000 });
    const fetchImpl = async (url) => (url.includes('groq.com') ? groqResponse(GOOD, { tokens: 400 }) : geminiResponse(GOOD, 400));
    const classifier = session({
      groq: { ...groqConfig, limits: { minuteTokens: 7_000 } },
      gemini: geminiConfig,
      ai: { maxWaitMs: 0 },
      usageStore,
      fetchImpl,
    });
    assert.equal((await classifier.classify(JOB)).classifier, 'gemini');
    assert.equal(classifier.groqDownReason, null, 'Groq stays available');
    usageStore.window('groq').length = 0; // a minute later
    assert.equal((await classifier.classify(JOB)).classifier, 'groq');
    assert.equal(classifier.stats.failures['groq:budget:minute_tokens'], 1);
  });

  it('tells a malformed answer apart from a job skipped for budget', async () => {
    const bad = session({ groq: groqConfig, useRules: false, fetchImpl: async () => groqResponse('{"is_relevant":"maybe"}') });
    assert.equal(await bad.classify(JOB), null);
    assert.equal(bad.lastOutcome, 'invalid_json');

    const usageStore = memoryUsageStore();
    usageStore.window('groq').push({ at: Date.now(), tokens: 7_000 });
    const full = session({ groq: { ...groqConfig, limits: { minuteTokens: 7_000 } }, ai: { maxWaitMs: 0 }, useRules: false, usageStore, fetchImpl: () => assert.fail('no call') });
    assert.equal(await full.classify(JOB), null);
    assert.equal(full.lastOutcome, 'skipped');
  });

  it('tells the AI which cities she picked', () => {
    assert.match(userPrompt(JOB, { cities: ['Mumbai', 'Remote'] }), /The student's cities: Mumbai, Remote\./);
    assert.doesNotMatch(userPrompt(JOB, {}), /cities/);
  });

  it('cuts long descriptions before sending', () => {
    const prompt = userPrompt({ ...JOB, description: 'x'.repeat(10_000) }, { maxDescriptionChars: 2500 });
    assert.ok(prompt.length < 2700);
    assert.ok(requestEstimate({ ...JOB, description: 'x'.repeat(10_000) }, { maxDescriptionChars: 2500 }) < 1500);
  });
});
