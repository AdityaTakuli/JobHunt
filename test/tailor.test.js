// Tailored CV and cover letter (lib/tailor.js): nothing that isn't in the CV gets through, the
// keyword match is counted honestly, the PDF is real text on one page. Also the Gmail code reader
// (lib/otp.js) and the date / dropdown parts of form filling (lib/fill.js).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchFields, profileFacts, sanitizeFields } from '../server/lib/fill.js';
import { extractCode, findOtp, siteWord } from '../server/lib/otp.js';
import { pdfText } from '../server/lib/pdf.js';
import { checkTailored, contactOf, keywordMatch, renderPdf } from '../server/lib/tailor.js';

const profile = {
  name: 'ASHA RAO',
  stage: 'student',
  graduation_year: 2027,
  experience_months: 6,
  education: [{ degree: 'B.Arch', institution: 'School of Planning and Architecture, Delhi', year: 2027 }],
  experience: [{ role: 'Architecture Intern', firm: 'Studio Lotus', months: 6, what: 'Working drawings for a residential villa in Revit' }],
  software: [
    { name: 'Revit', level: 'shown' },
    { name: 'AutoCAD', level: 'listed' },
  ],
  skills: ['Working drawings'],
  projects: [{ title: 'Hillside Housing', typology: 'Residential' }],
  certifications: [],
  contact: { email: 'asha@example.com', phone: '+919876543210', city: 'Bengaluru', date_of_birth: '2003-04-05' },
};
const resumeText = 'ASHA RAO. B.Arch, School of Planning and Architecture, Delhi, 2027. Architecture Intern, Studio Lotus, Jan-Jun 2026: prepared 12 working drawings for a residential villa in Revit. Projects: Hillside Housing, 40 units. Skills: Revit, AutoCAD.';
const facts = profileFacts(profile, {});

const reply = {
  headline: 'B.Arch student (2027) · Revit documentation',
  summary: 'Final-year B.Arch student with Revit documentation on residential work.',
  skills: ['Revit', 'AutoCAD', 'Navisworks'],
  experience: [
    { role: 'Architecture Intern', firm: 'Studio Lotus', dates: 'Jan-Jun 2026', bullets: ['Prepared 12 working drawings for a residential villa in Revit', 'Cut design time by 30% with templates'] },
    { role: 'Design Lead', firm: 'Morphogenesis', dates: '2025', bullets: ['Led a team'] },
  ],
  projects: [
    { title: 'Hillside Housing', line: 'Designed 40 units of hillside housing.' },
    { title: 'Airport Terminal', line: 'A terminal.' },
  ],
  cover_letter: { greeting: 'Dear Hiring Team,', paragraphs: ['I am writing to express my interest in the role. Your posting asks for Revit documentation, which I did at Studio Lotus.'], sign_off: 'Regards,\nAsha Rao' },
};

describe('tailored CV: only what the CV backs up', () => {
  const c = checkTailored(reply, { profile, resumeText, facts });

  it('drops tools, employers, projects and numbers the CV does not have', () => {
    assert.deepEqual(c.resume.skills, ['Revit', 'AutoCAD']);
    assert.deepEqual(
      c.resume.experience.map((e) => e.firm),
      ['Studio Lotus'],
    );
    assert.deepEqual(c.resume.experience[0].bullets, ['Prepared 12 working drawings for a residential villa in Revit'], 'the invented 30% line is gone');
    assert.deepEqual(
      c.resume.projects.map((p) => p.title),
      ['Hillside Housing'],
    );
    for (const what of ['Navisworks', 'Morphogenesis', '30%', 'Airport Terminal']) assert.ok(c.dropped.some((d) => d.includes(what)), what);
  });

  it('takes education from the profile, never from the reply', () => {
    assert.deepEqual(c.resume.education, [{ degree: 'B.Arch', institution: 'School of Planning and Architecture, Delhi', year: '2027' }]);
  });

  it('cuts stock lines out of the cover letter and keeps the rest', () => {
    assert.equal(c.cover_letter.paragraphs[0], 'Your posting asks for Revit documentation, which I did at Studio Lotus.');
  });

  it('writes the name the way a CV should', () => {
    assert.equal(c.resume.name, 'Asha Rao');
  });

  it('rejects a reply with nothing usable', () => {
    assert.equal(checkTailored({ skills: [] }, { profile, resumeText, facts }), null);
    assert.equal(checkTailored('nope', { profile, resumeText, facts }), null);
  });

  it('counts the keyword match honestly, and lists what she does not have', () => {
    const m = keywordMatch('Revit, Navisworks, AutoCAD and working drawings needed.', resumeText, c.resume, profile);
    assert.equal(m.before, 75);
    assert.equal(m.after, 75, 'Navisworks is not claimed, so 3 of 4 is as high as it honestly goes');
    assert.equal(keywordMatch('Revit and Navisworks.', resumeText, { ...c.resume, skills: [], experience: [], projects: [], headline: '', summary: '' }, profile).after, 0, 'a CV that drops a keyword shows the drop');
    assert.deepEqual(m.missing, ['Navisworks']);
  });

  it('draws one page of real text', async () => {
    const pdf = await renderPdf('resume', { resume: c.resume, contact: contactOf(profile) });
    const { text, pages } = await pdfText(pdf, { maxPages: 2 });
    assert.equal(pages, 1);
    assert.match(text, /Asha Rao/);
    assert.match(text, /Studio Lotus/);
    assert.match(text, /asha@example\.com/);
    const letter = await renderPdf('letter', { resume: c.resume, letter: c.cover_letter, contact: contactOf(profile), posting: { company: 'WSP', title: 'Junior Architect' } });
    assert.match((await pdfText(letter, { maxPages: 1 })).text, /Re: Junior Architect/);
  });

  it('keeps a long CV to one page', async () => {
    const long = structuredClone(c.resume);
    long.experience = Array.from({ length: 3 }, () => ({ ...c.resume.experience[0], bullets: Array(3).fill('Prepared 12 working drawings for a residential villa in Revit with site visits every week and detailed coordination notes') }));
    long.projects = Array(3).fill({ title: 'Hillside Housing', line: 'Designed 40 units of hillside housing with a long explanation of the site, the climate and the planning approach taken.' });
    long.summary = 'Final-year student. '.repeat(20);
    const { pages } = await pdfText(await renderPdf('resume', { resume: long, contact: contactOf(profile) }), { maxPages: 3 });
    assert.equal(pages, 1);
  });
});

describe('one-time codes from Gmail', () => {
  it('finds the code next to the code words, and nothing else', () => {
    assert.equal(extractCode('Your OTP is 482913. Valid for 10 minutes.'), '482913');
    assert.equal(extractCode('Use verification code 5521 to sign in'), '5521');
    assert.equal(extractCode('Workday: 739201 is your verification code'), '739201');
    assert.equal(extractCode('Your one-time passcode: AB12CD'), 'AB12CD');
    assert.equal(extractCode('Order 2026 total Rs. 45000 call 9876543210'), null);
    assert.equal(extractCode('Your application to Studio X on 12/05/2026 was received.'), null);
    assert.equal(extractCode('Verify your email. Amount Rs. 5000 paid.'), null);
  });

  it('names the site from its address', () => {
    assert.equal(siteWord('wsp.wd3.myworkdayjobs.com'), 'wsp');
    assert.equal(siteWord('careers.gensler.com'), 'gensler');
  });

  it('needs Gmail connected, and reads only recent mail, preferring the site asking', async () => {
    assert.match((await findOtp({ gmail_token: null }, 'x.com')).error, /Connect Gmail/);
    const now = new Date('2026-11-11T10:00:00Z');
    const raw = (from, subject, body, minutesAgo) =>
      Buffer.from(`From: ${from}\r\nSubject: ${subject}\r\nDate: ${new Date(now - minutesAgo * 60_000).toUTCString()}\r\nContent-Type: text/plain\r\n\r\n${body}\r\n`);
    const mails = {
      a: raw('noreply@other.com', 'Your code', 'Your OTP is 111111', 1),
      b: raw('no-reply@wsp.com', 'WSP verification', 'Your verification code is 222222', 3),
      c: raw('no-reply@wsp.com', 'WSP verification', 'Your verification code is 333333', 50),
    };
    const deps = { accessToken: async () => 't', listMessageIds: async () => ['a', 'b', 'c'], fetchRawMessage: async (t, id) => ({ id, raw: mails[id] }) };
    const user = { gmail_token: (await import('../server/lib/secretBox.js')).seal('refresh') };
    const found = await findOtp(user, 'wsp.wd3.myworkdayjobs.com', { now, deps });
    assert.equal(found.code, '222222', 'the site asking wins over a newer email from elsewhere; the 50-minute-old one is ignored');
  });
});

describe('dates split over boxes, and custom dropdowns', () => {
  const fields = sanitizeFields([
    { key: 'd', tag: 'select', label: 'Date of birth (day)', part: 'day', options: ['Day', ...Array.from({ length: 31 }, (_, i) => String(i + 1))] },
    { key: 'm', tag: 'select', label: 'Date of birth (month)', part: 'month', options: ['Month', 'Jan', 'Feb', 'Mar', 'Apr'] },
    { key: 'y', tag: 'input', label: 'Date of birth (year)', part: 'year' },
    { key: 'gm', tag: 'input', label: 'Graduation date (month)', part: 'month' },
    { key: 'c', tag: 'select', label: 'Country', custom: true },
    { key: 'e', tag: 'select', label: 'Years of experience', custom: true },
  ]);
  const { answers, skipped } = matchFields(fields, facts, {});
  const v = (k) => answers.find((a) => a.key === k)?.value;

  it('fills each part of a date, and leaves a part the CV does not give', () => {
    assert.equal(v('d'), '5');
    assert.equal(v('m'), 'Apr');
    assert.equal(v('y'), '2003');
    assert.ok(skipped.some((s) => s.key === 'gm'), 'the CV gives a graduation year, not a month');
  });

  it('sends custom dropdowns the value with other wordings to try', () => {
    assert.equal(v('c'), 'India');
    assert.deepEqual(answers.find((a) => a.key === 'e').alts.slice(0, 2), ['Fresher', 'No experience']);
  });
});

describe('saved files for upload boxes', () => {
  it('knows a file by its first bytes, not its name', async () => {
    const { sniff } = await import('../server/routes/documents.js');
    assert.equal(sniff(Buffer.from('%PDF-1.7 rest')).ext, '.pdf');
    assert.equal(sniff(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])).ext, '.png');
    assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])).ext, '.jpg');
    assert.equal(sniff(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('....word/document.xml')])).ext, '.docx');
    assert.equal(sniff(Buffer.from('MZ executable')), null);
    assert.equal(sniff(Buffer.concat([Buffer.from([0x50, 0x4b, 3, 4]), Buffer.from('some other zip')])), null);
  });

  it('puts a saved certificate or work sample into a box asking for one', () => {
    const fields = sanitizeFields([
      { key: 'c', tag: 'file', label: 'COA registration certificate' },
      { key: 'w', tag: 'file', label: 'Samples of your work (PDF)' },
      { key: 'a', tag: 'file', label: 'Additional attachments' },
    ]);
    const library = [
      { id: 7, kind: 'certificate' },
      { id: 9, kind: 'work_sample' },
    ];
    const { answers, skipped } = matchFields(fields, facts, { resume: true, portfolio: true, library });
    assert.equal(answers.find((a) => a.key === 'c').file, 'doc:7');
    assert.equal(answers.find((a) => a.key === 'w').file, 'doc:9');
    assert.ok(skipped.some((s) => s.key === 'a' && s.reason === 'file'), 'an unclear box is left for the picker');
    const noLibrary = matchFields(fields, facts, { resume: true, portfolio: true, library: [] });
    assert.equal(noLibrary.answers.find((a) => a.key === 'w').file, 'portfolio', 'no work sample saved: the portfolio goes');
  });
});
