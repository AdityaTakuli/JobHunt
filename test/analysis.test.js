import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyseJob, analysisGateways, analysisPrompt, parseAnalysis, validateAnalysis } from '../server/lib/jobAnalysis.js';
import { postingFromHtml } from '../server/lib/jobPage.js';
import { jobFacts } from '../server/lib/fit.js';
import { inIndia, isDesignRole } from '../server/sources/companyFeeds.js';
import { normalizeCity } from '../server/lib/normalize.js';

const GOOD = {
  summary: 'Junior landscape role drawing plans and planting schemes.',
  level: 'junior',
  experience: '0-3 years',
  company: 'Landscape practice doing public parks.',
  must_have: ['AutoCAD', 'AutoCAD', 'Planting design'],
  nice_to_have: ['Revit'],
  software: ['AutoCAD', 'Lumion'],
  highlight: ['Landscape studio project', 'Highlight your communication skills'],
  portfolio: ['Site plan with planting'],
  gaps: ['No masters: show landscape electives'],
  cover_note: 'I am a final-year B.Arch student…',
  interview: ['Grading basics'],
  red_flags: [],
};

const cfg = (over = {}) => ({
  omniroute: { url: '', apiKey: '' },
  freellm: { url: 'https://llm.example/v1', apiKey: 'k' },
  analysis: { omnirouteModels: '', freellmModels: 'a,b', maxOutputTokens: 100, timeoutMs: 1000, deadlineMs: 80_000, maxDescriptionChars: 100 },
  ...over,
});

const reply = (status, content) => ({
  ok: status === 200,
  status,
  headers: { get: () => null },
  json: async () => ({ choices: [{ message: { content } }], usage: { total_tokens: 900 } }),
  text: async () => 'busy',
});

describe('job analysis', () => {
  it('validates and tidies an answer', () => {
    const a = validateAnalysis(GOOD);
    assert.equal(a.company, 'Landscape practice doing public parks.');
    assert.deepEqual(a.must_have, ['AutoCAD', 'Planting design']);
    assert.equal(a.fit_score, undefined, 'the analysis has no score of its own');
    assert.deepEqual(a.highlight, ['Landscape studio project'], 'generic advice is dropped');
    assert.equal(validateAnalysis({ ...GOOD, summary: '' }), null);
    assert.equal(validateAnalysis({ ...GOOD, must_have: 'AutoCAD' }), null);
  });

  it('reads JSON wrapped in a code fence', () => {
    assert.equal(parseAnalysis('```json\n' + JSON.stringify(GOOD) + '\n```', 'm').level, 'junior');
    assert.throws(() => parseAnalysis('not json', 'm'), /invalid JSON/);
  });

  it('puts OmniRoute first when it is set up', () => {
    const g = analysisGateways(cfg({ omniroute: { url: 'https://omni.example', apiKey: 'o' }, analysis: { ...cfg().analysis, omnirouteModels: 'x' } }));
    assert.deepEqual(
      g.map((x) => [x.name, x.url, x.models]),
      [
        ['omniroute', 'https://omni.example/v1/chat/completions', ['x']],
        ['freellm', 'https://llm.example/v1/chat/completions', ['a', 'b']],
      ],
    );
    assert.deepEqual(analysisGateways(cfg({ freellm: { url: '', apiKey: '' } })), []);
  });

  it('moves to the next model when one is rate-limited', async () => {
    const asked = [];
    const fetchImpl = async (url, init) => {
      const { model } = JSON.parse(init.body);
      asked.push(model);
      return model === 'a' ? reply(429) : reply(200, JSON.stringify(GOOD));
    };
    const usage = [];
    const out = await analyseJob({ title: 'Landscape Architect', description: 'x' }, { cfg: cfg(), fetchImpl, onUsage: (g, t) => usage.push([g, t]) });
    assert.deepEqual(asked, ['a', 'b']);
    assert.equal(out.model, 'b');
    assert.equal(out.gateway, 'freellm');
    assert.deepEqual(usage, [['freellm', 900]]);
  });

  it('stops trying models after the deadline', async () => {
    let t = 0;
    const fetchImpl = async () => {
      t += 50_000;
      return reply(429);
    };
    const c = cfg();
    c.analysis.deadlineMs = 40_000;
    await assert.rejects(analyseJob({ title: 'x' }, { cfg: c, fetchImpl, now: () => t }), /rate limit/);
    assert.equal(t, 50_000); // b was never asked
  });
});

describe('company feeds', () => {
  it('leaves out plumbing and mechanical BIM roles', () => {
    assert.equal(isDesignRole('BIM Engineer - PHE'), false);
    assert.equal(isDesignRole('BIM Engineer - Mechnical'), false);
    assert.equal(isDesignRole('BIM Engineer/BIM Coordinator'), true);
  });

  it('knows Hyderabad by its office districts', () => {
    assert.equal(normalizeCity('Madhapur, India'), 'Hyderabad');
    assert.equal(inIndia('HITEC City'), true);
  });
});

describe('analysis is written from the posting and the firm', () => {
  const job = { title: 'Senior Architect', company: 'WSP', city: 'Bengaluru', description: '' };

  it('says when there is no posting text, instead of letting the model guess', () => {
    const p = analysisPrompt(job, { source: 'none' });
    assert.match(p, /NO POSTING TEXT/);
    assert.doesNotMatch(p, /Posting text/);
  });

  it('gives the posting and what is known about the firm', () => {
    const description = 'Lead healthcare projects in Revit. '.repeat(20);
    const p = analysisPrompt({ ...job, description }, { source: 'posting', sourceHost: 'careers.wsp.com', firm: { name: 'WSP', kind: 'Engineering & design', note: 'BIM trainees', about: 'Global engineering consultancy.' } });
    assert.match(p, /Posting text \(from careers\.wsp\.com\):\nLead healthcare/);
    assert.match(p, /Firm: WSP \(Engineering & design\)/);
    assert.match(p, /What the firm says about itself: Global engineering consultancy\./);
  });

  it('reads the posting from schema.org JobPosting data, escaped HTML included', () => {
    const description = '&lt;p&gt;We need a &lt;b&gt;Senior Architect&lt;/b&gt;.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;8+ years&lt;/li&gt;&lt;li&gt;Revit&lt;/li&gt;&lt;/ul&gt;' + ' Healthcare and campus work in Bengaluru.'.repeat(10);
    const html = `<script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'JobPosting', title: 'Senior Architect', description, hiringOrganization: { name: 'WSP', description: 'Engineering consultancy.' } }] })}</script>`;
    const p = postingFromHtml(html);
    assert.equal(p.source, 'jobposting');
    assert.equal(p.company, 'WSP');
    assert.equal(p.companyAbout, 'Engineering consultancy.');
    assert.match(p.description, /^We need a Senior Architect\.\n- 8\+ years\n- Revit\n/);
    assert.equal(postingFromHtml('<p>Sign in</p>'), null, 'a page with no posting gives nothing');
  });

  it('counts the analysis must-haves in the fit facts (card and details use the same facts)', () => {
    const row = { id: 1, title: 'Architect', software: ['Revit', 'AutoCAD'], description: 'Revit and AutoCAD.' };
    const without = jobFacts(row);
    const withAnalysis = jobFacts(row, { must_have: ['Revit'], nice_to_have: ['AutoCAD'] });
    assert.notDeepEqual(without, withAnalysis);
    assert.equal(withAnalysis.reqs.find((r) => r.label === 'AutoCAD').required, false);
  });
});
