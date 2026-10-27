import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyseJob, analysisGateways, parseAnalysis, validateAnalysis } from '../server/lib/jobAnalysis.js';
import { inIndia, isDesignRole } from '../server/sources/companyFeeds.js';
import { normalizeCity } from '../server/lib/normalize.js';

const GOOD = {
  summary: 'Junior landscape role drawing plans and planting schemes.',
  level: 'junior',
  experience: '0-3 years',
  fit_score: 62,
  fit_verdict: 'Stretch',
  fit_reason: 'Asks for a landscape masters, but takes 0 years.',
  must_have: ['AutoCAD', 'AutoCAD', 'Planting design'],
  nice_to_have: ['Revit'],
  software: ['AutoCAD', 'Lumion'],
  highlight: ['Landscape studio project'],
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
    assert.equal(a.fit_verdict, 'stretch');
    assert.deepEqual(a.must_have, ['AutoCAD', 'Planting design']);
    assert.equal(validateAnalysis({ ...GOOD, fit_verdict: 'maybe' }), null);
    assert.equal(validateAnalysis({ ...GOOD, must_have: 'AutoCAD' }), null);
  });

  it('reads JSON wrapped in a code fence', () => {
    assert.equal(parseAnalysis('```json\n' + JSON.stringify(GOOD) + '\n```', 'm').fit_score, 62);
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
