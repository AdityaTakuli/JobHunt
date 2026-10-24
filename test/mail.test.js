// Application emails from Gmail: what the AI answer must look like, the keyword fallback, and how
// an email picks and moves a tracker entry.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryUsageStore } from '../server/lib/aiBudget.js';
import { createMailTriage, mailPrompt, triageWithRules, validateTriage } from '../server/lib/mailTriage.js';
import { nextStatus, normCompany, pickApplication, PLACEHOLDER_ROLE, roleOverlap } from '../server/lib/tracker.js';

const freellm = { url: 'https://llm.example.com', apiKey: 'k', model: 'groq-model,backup-model', mailModel: '', timeoutMs: 200, limits: {} };
const reply = (content) => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { total_tokens: 300 } });
const MAIL = { from: 'LinkedIn <jobs-noreply@linkedin.com>', subject: 'Aditi, your application was sent to Morphogenesis', text: 'Architectural Intern · Morphogenesis · Bengaluru' };

describe('mail triage', () => {
  it('accepts only the expected answer shape', () => {
    assert.deepEqual(validateTriage({ kind: 'interview', company: ' RSP ', role: null, reason: 'Invite' }), { kind: 'interview', company: 'RSP', role: null, reason: 'Invite' });
    assert.equal(validateTriage({ kind: 'maybe', company: null, role: null }), null);
    assert.equal(validateTriage({ kind: 'applied', company: 3 }), null);
    assert.equal(validateTriage({ kind: 'applied', company: 'unknown', role: 'N/A' }).company, null);
  });

  it('sends sender, subject and the body without quoted replies', () => {
    const prompt = mailPrompt({ from: 'hr@firm.in', subject: 'Re: portfolio', text: 'Come on Monday.\n> On Fri you wrote:\n> my portfolio' });
    assert.match(prompt, /From: hr@firm\.in\nSubject: Re: portfolio\n\nCome on Monday\./);
    assert.doesNotMatch(prompt, /my portfolio/);
  });

  it('falls back to careful keyword rules', () => {
    assert.deepEqual(triageWithRules(MAIL), { kind: 'applied', company: 'Morphogenesis', role: null, reason: 'Matched keywords (AI unavailable).' });
    assert.equal(triageWithRules({ subject: 'Update', text: 'Unfortunately we will not be moving forward.' }).kind, 'rejected');
    assert.equal(triageWithRules({ subject: '12 new jobs for "BIM intern"', text: 'Interview tips inside' }).kind, 'other');
    assert.equal(triageWithRules({ subject: 'Your OTP', text: 'Use 4829' }).kind, 'other');
  });

  it('asks FreeLLMAPI with the mail model list, moving to the next model when one is down', async () => {
    const models = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      models.push(body.model);
      assert.equal(url, 'https://llm.example.com/v1/chat/completions');
      assert.match(body.messages[1].content, /application was sent to Morphogenesis/);
      if (body.model === 'groq-model') return new Response('busy', { status: 503 });
      return reply({ kind: 'applied', company: 'Morphogenesis', role: 'Architectural Intern', reason: 'Confirmation' });
    };
    const t = createMailTriage({ freellm, fetchImpl, usageStore: memoryUsageStore() });
    assert.deepEqual(await t.triage(MAIL), { kind: 'applied', company: 'Morphogenesis', role: 'Architectural Intern', reason: 'Confirmation', classifier: 'freellm' });
    await t.triage(MAIL);
    assert.deepEqual(models, ['groq-model', 'backup-model', 'backup-model'], 'the down model is skipped for the rest of the run');
  });

  it('prefers FREELLM_MAIL_MODEL and uses the rules when the AI is out', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push(JSON.parse(init.body).model);
      return new Response('', { status: 429 });
    };
    const t = createMailTriage({ freellm: { ...freellm, mailModel: 'mail-model' }, fetchImpl, usageStore: memoryUsageStore() });
    assert.equal((await t.triage(MAIL)).classifier, 'rules');
    assert.equal((await t.triage(MAIL)).classifier, 'rules');
    assert.deepEqual(seen, ['mail-model']);
    assert.equal(t.down, 'rate_limit');
  });

  it('does not call the AI without a URL and key', async () => {
    const t = createMailTriage({ freellm: { ...freellm, apiKey: '' }, fetchImpl: () => assert.fail('no call'), usageStore: memoryUsageStore() });
    assert.equal((await t.triage(MAIL)).classifier, 'rules');
    assert.equal(t.down, 'not_configured');
  });
});

describe('tracker from email', () => {
  it('only moves an entry forward, or to rejected, or back out of rejected for a new turn', () => {
    assert.equal(nextStatus('saved', 'applied'), 'applied');
    assert.equal(nextStatus('applied', 'assessment'), 'interview');
    assert.equal(nextStatus('interview', 'applied'), null);
    assert.equal(nextStatus('interview', 'rejected'), 'rejected');
    assert.equal(nextStatus('offer', 'rejected'), null);
    assert.equal(nextStatus('rejected', 'applied'), null);
    assert.equal(nextStatus('rejected', 'interview'), 'interview');
    assert.equal(nextStatus('applied', 'other'), null);
  });

  it('matches company names loosely and roles by shared words', () => {
    assert.equal(normCompany('Studio Lotus Pvt. Ltd.'), 'lotus');
    assert.equal(normCompany('CDA Architects'), 'cda');
    assert.equal(normCompany('Design Studio'), 'design studio');
    assert.equal(roleOverlap('Architectural Intern (BIM)', 'BIM Architectural Intern'), 1);
    assert.equal(roleOverlap('Junior Architect', 'Revit Modeller'), 0);
    assert.equal(roleOverlap('', 'Intern'), null);
  });

  it('picks the entry for the same firm and role, and not another role there', () => {
    const apps = [
      { id: 1, company: 'Studio Lotus', title: 'Junior Architect' },
      { id: 2, company: 'Studio Lotus Pvt Ltd', title: 'BIM Intern' },
      { id: 3, company: 'Morphogenesis', title: 'Architectural Intern' },
    ];
    assert.equal(pickApplication(apps, { company: 'Studio Lotus', role: 'BIM Intern' })?.id, 2);
    assert.equal(pickApplication(apps, { company: 'Morphogenesis', role: null })?.id, 3);
    assert.equal(pickApplication(apps, { company: 'Morphogenesis', role: 'Landscape Designer' }), null);
    assert.equal(pickApplication(apps, { company: 'HOK', role: 'Intern' }), null);
  });

  it('treats an entry made before its role was known as any role at that firm', () => {
    const apps = [{ id: 7, company: 'Morphogenesis', title: PLACEHOLDER_ROLE }];
    assert.equal(pickApplication(apps, { company: 'Morphogenesis', role: 'Architectural Intern' })?.id, 7);
  });
});
