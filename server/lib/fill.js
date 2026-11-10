// Fills a job application form from the person's profile (ARCH in Chrome, extension/). The
// extension sends every field it can see on the page; this works out what goes in each one.
//
// Two passes:
//   1. Rules. Fields a form always has (name, email, phone, college, degree, LinkedIn...) are
//      recognised from their label, name and autocomplete attribute and filled straight from the
//      profile. No AI involved, so the answer is exactly what the CV says.
//   2. AI, only for what is left: open questions ("Why do you want to join us?", "Describe your
//      experience with Revit"), yes/no questions, and dropdowns whose options need judgement.
//      The model is given the profile, the CV text and the page, and must answer only from
//      those: a fact it cannot find comes back null and the field is left for the person.
//
// Nothing here ever submits a form; the extension marks what was filled for the person to check.

import { CONTACT_KEYS } from './profile.js';

export const FILL_VERSION = 1;
export const MAX_FIELDS = 80;
const MAX_TEXT = 1_500; // longest value we will write into a textarea
const MAX_AI_FIELDS = 30;

// ---- Facts: the profile flattened into what forms ask for ----

const yearsText = (months) => {
  if (!months) return '0';
  const y = months / 12;
  return Number.isInteger(y) ? String(y) : y.toFixed(1).replace(/\.0$/, '');
};

/**
 * @param profile the stored profile (lib/profile.js shape)
 * @param account { name, email } of the signed-in person, used when the CV has no contact line
 */
export function profileFacts(profile, account = {}) {
  const c = profile.contact || {};
  const name = (profile.name || account.name || '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  const edu = profile.education?.[0] || null;
  const exp = profile.experience?.[0] || null;
  const software = (profile.software || []).map((s) => s.name);
  const city = c.city || profile.cities?.[0] || null;
  return {
    name: name || null,
    first_name: parts[0] || null,
    last_name: parts.length > 1 ? parts.slice(1).join(' ') : null,
    email: c.email || account.email || null,
    phone: c.phone || null,
    linkedin: c.linkedin || null,
    website: c.website || null,
    city,
    address: c.address || null,
    country: 'India',
    date_of_birth: c.date_of_birth || null,
    degree: edu?.degree || null,
    institution: edu?.institution || null,
    graduation_year: profile.graduation_year || edu?.year || null,
    company: exp?.firm || null,
    title: exp?.role || null,
    experience_years: yearsText(profile.experience_months || 0),
    experience_months: profile.experience_months || 0,
    software,
    skills: [...new Set([...software, ...(profile.skills || [])])],
    cities: profile.cities || [],
    summary: profile.summary || null,
    stage: profile.stage || 'student',
    coa: Boolean(profile.coa),
    certifications: profile.certifications || [],
  };
}

// ---- Rules ----

// A field is described by everything the page says about it, in one lowercase line.
export function fieldSignature(field) {
  const camel = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return [field.label, field.placeholder, field.name, field.id, field.autocomplete]
    .map((s) => camel(s).toLowerCase().replace(/[_\-.[\]]+/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' | ');
}

// Fields no one should fill for the person.
const NEVER = /password|captcha|\botp\b|verification code|security code|card number|\bcvv\b|coupon|promo|search|signature/;

// Words that mean "name" is not the person's own.
const NOT_PERSON_NAME = /company|employer|organi[sz]ation|college|school|university|institut|father|mother|parent|guardian|user ?name|file|project|reference|referee|contact person|middle|last|sur|family|first|given|nick|display|login|brand|firm/;

const AUTOCOMPLETE = {
  'given-name': 'first_name',
  'family-name': 'last_name',
  name: 'name',
  email: 'email',
  tel: 'phone',
  'tel-national': 'phone',
  url: 'website',
  'address-level2': 'city',
  'street-address': 'address',
  'country-name': 'country',
  organization: 'company',
  'organization-title': 'title',
  bday: 'date_of_birth',
};

// Order matters: the first rule whose test matches wins.
export const RULES = [
  { fact: 'email', test: /e ?mail/ },
  { fact: 'phone', test: /phone|mobile|whatsapp|\btel\b|telephone|contact (no|number|num)/ },
  { fact: 'first_name', test: /\b(first|given|fore) ?name\b|^f ?name$|\bfname\b/ },
  { fact: 'last_name', test: /\b(last|family) ?name\b|\bsurname\b|^l ?name$|\blname\b/ },
  { fact: 'name', test: /\bname\b|^candidate$|^applicant$/, not: NOT_PERSON_NAME },
  { fact: 'linkedin', test: /linked ?in/ },
  { fact: 'website', test: /portfolio|website|web site|personal site|behance|issuu|\burl\b|online work|link to your work/, not: /linked ?in|github|resume|cv\b/ },
  { fact: 'date_of_birth', test: /date of birth|\bdob\b|birth ?date|birthday/ },
  { fact: 'cities', test: /preferred (location|city|cities)|location preference|where (would|do) you (want|prefer)|open to work in/ },
  { fact: 'address', test: /\baddress\b/, not: /e ?mail|\bip\b|web/ },
  { fact: 'country', test: /\bcountry\b|nationality/ },
  { fact: 'city', test: /\bcity\b|current location|\blocation\b|where (are you|do you) (based|live|stay)|hometown|home town|residence|residing/, not: /preferred|job|office|work ?location|relocat/ },
  { fact: 'institution', test: /college|university|institute|institution|school name|alma mater|\bschool\b|studied at/ },
  { fact: 'graduation_year', test: /graduat|passing|year of (completion|passing|study)|batch|pass ?out|completion year/ },
  { fact: 'degree', test: /\bdegree\b|qualification|education level|highest education|course name|\bcourse\b|programme|program of study/ },
  { fact: 'company', test: /current (company|employer|organi[sz]ation|firm)|employer|company name|organi[sz]ation name|where do you work|last company|previous company/ },
  { fact: 'title', test: /current (title|role|designation|position|job)|designation|job title|current profile|present role/ },
  { fact: 'experience_years', test: /experience|\bexp\b/, not: /describe|tell|explain|detail|relevant|about|internship|projects/ },
  { fact: 'skills', test: /\bskills?\b|software|tools|technical|proficien/, not: /describe|tell|explain|rate|level|how/ },
  { fact: 'summary', test: /\bsummary\b|about (you|yourself|me)|brief intro|introduce yourself|profile summary|headline|bio\b/ },
];

const titleCase = (s) => s.replace(/\b\w/g, (ch) => ch.toUpperCase());

// Picks the option a value means ("India" from ["Select...", "India", "USA"]), or null.
export function pickOption(options, value) {
  if (!Array.isArray(options) || value == null) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  const norm = (o) => String(o).trim().toLowerCase();
  return options.find((o) => norm(o) === v) ?? options.find((o) => norm(o).startsWith(v) || v.startsWith(norm(o))) ?? options.find((o) => norm(o).includes(v)) ?? null;
}

// Years-of-experience dropdowns ("0-1 years", "Fresher", "2+ years"): the band the number sits in.
function pickExperienceOption(options, months) {
  const years = months / 12;
  for (const o of options) {
    const s = String(o).toLowerCase();
    if (years < 1 && /fresher|no experience|none|\b0\b|student|entry/.test(s)) return o;
    const range = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)/);
    if (range && years >= Number(range[1]) && years < Number(range[2]) + (Number(range[2]) < 1 ? 0 : 1)) return o;
    const plus = s.match(/(\d+)\s*\+/);
    if (plus && years >= Number(plus[1]) && !range) return o;
    const lessThan = s.match(/(?:less than|under|below|<)\s*(\d+)/);
    if (lessThan && years < Number(lessThan[1])) return o;
  }
  return null;
}

function factValue(fact, facts, field) {
  const v = facts[fact];
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  if (fact === 'skills' || fact === 'cities') return v.join(', ');
  if (fact === 'experience_years' && field.type === 'number') return String(Math.round(facts.experience_months / 12));
  return String(v);
}

/**
 * Rule-based pass. Returns { answers, rest } where rest holds the fields the rules could not settle.
 * Each answer: { key, value, fact, source: 'profile' } or { key, file: 'resume'|'portfolio', source: 'file' }.
 */
export function matchFields(fields, facts, files = { resume: false, portfolio: false }) {
  const answers = [];
  const rest = [];
  const skipped = [];
  for (const field of fields) {
    const sig = fieldSignature(field);
    if (field.tag === 'checkbox' || NEVER.test(sig)) {
      skipped.push({ key: field.key, reason: field.tag === 'checkbox' ? 'checkbox' : 'never' });
      continue;
    }
    if (field.tag === 'file') {
      const kind = /portfolio|work sample|samples of work/.test(sig) ? 'portfolio' : /resume|\bcv\b|curriculum|upload/.test(sig) ? 'resume' : null;
      if (kind && files[kind]) answers.push({ key: field.key, file: kind, source: 'file' });
      else skipped.push({ key: field.key, reason: kind ? 'no_file' : 'file' });
      continue;
    }
    let fact = AUTOCOMPLETE[String(field.autocomplete || '').toLowerCase()] || null;
    if (!fact) {
      const rule = RULES.find((r) => r.test.test(sig) && !(r.not && r.not.test(sig)));
      fact = rule?.fact || null;
    }
    if (!fact) {
      rest.push(field);
      continue;
    }
    let value = factValue(fact, facts, field);
    if (value && (field.tag === 'select' || field.tag === 'radio')) {
      const option = fact === 'experience_years' ? pickExperienceOption(field.options || [], facts.experience_months) : pickOption(field.options || [], value);
      if (!option && fact === 'country') value = pickOption(field.options || [], 'india');
      else value = option;
      // A dropdown the rules can't settle (an experience band, a degree list) goes to the AI.
      if (!value) {
        rest.push(field);
        continue;
      }
    }
    if (value && field.maxLength > 0) value = value.slice(0, field.maxLength);
    if (value) answers.push({ key: field.key, value, fact, source: 'profile' });
    // A fact the profile lacks (no phone on the CV) is not a question for the AI either.
    else skipped.push({ key: field.key, reason: 'unknown', fact });
  }
  return { answers, rest, skipped };
}

// ---- The AI pass ----

export const FILL_SYSTEM_PROMPT = `You fill in a job application form for an architecture student or graduate in India, from their
profile and CV. The person will check every answer before sending, so leave a field empty rather
than guess: a wrong "fact" costs them the application.

Rules:
- Use only what the profile, the CV text and the posting say. If the answer is not there, value = null.
  Never invent employers, dates, marks, numbers, references, salary figures or a notice period.
- For a field with "options", value must be exactly one of the options (copy it character for
  character) or null. Pick "Fresher" / "0-1 years" style bands from experience_months. Pick the
  "Other" / "Job board" / "Online" kind of option for "how did you hear about us" if present.
- Yes/No questions: answer only when the profile settles it (a student is a student; they know a
  tool if it is in software; they are based in India, so they may work in India; they are willing to
  relocate if the job's city is in their cities list, else null).
- Open questions (why this firm, tell us about yourself, relevant experience, cover letter): write in
  the first person, plainly, 2-5 sentences (a cover letter up to 180 words). Name real projects, tools
  and internships from the CV that fit what the posting asks for. No clichés, no claims the CV does
  not back, nothing about the firm that the page does not state. Stay under max_length if given.
- Expected salary / CTC / stipend, notice period, references, marks / CGPA, passport or ID numbers,
  gender, caste, religion, marital status: null, always.
Reply with one JSON object and nothing else:
{ "answers": [{ "key": string, "value": string | null, "note": string }] }   // note: under 12 words on what the answer is based on
List every key you were given.`;

export function fillUserPrompt({ page, fields, facts, profile, resumeText }) {
  const compactProfile = {
    name: facts.name,
    stage: facts.stage,
    graduation_year: facts.graduation_year,
    experience_months: facts.experience_months,
    education: profile.education,
    experience: profile.experience,
    software: facts.software,
    skills: profile.skills,
    projects: profile.projects,
    typologies: profile.typologies,
    cities: facts.cities,
    current_city: facts.city,
    coa: facts.coa,
    certifications: facts.certifications,
    summary: facts.summary,
    portfolio: profile.portfolio ? { typologies: profile.portfolio.typologies, projects: profile.portfolio.projects, strengths: profile.portfolio.strengths, best_for: profile.portfolio.best_for } : null,
  };
  const list = fields.map((f) => ({
    key: f.key,
    question: f.label || f.placeholder || f.name || '',
    type: f.tag === 'radio' ? 'choice' : f.tag === 'select' ? 'dropdown' : f.tag === 'textarea' ? 'long text' : f.type || 'text',
    ...(f.options?.length ? { options: f.options } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.maxLength > 0 ? { max_length: f.maxLength } : {}),
    ...(f.required ? { required: true } : {}),
  }));
  return [
    `Form page: ${page.title || ''}\nURL: ${page.url || ''}`,
    page.text ? `What the page says (trimmed):\n${page.text}` : null,
    `Profile:\n${JSON.stringify(compactProfile)}`,
    resumeText ? `CV text:\n${resumeText}` : null,
    `Fields to answer:\n${JSON.stringify(list)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// Keeps only answers for keys that were asked, with option values matched to the real options.
export function validateFillAnswers(value, fields) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.answers)) return null;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const out = [];
  const seen = new Set();
  for (const a of value.answers) {
    const field = a && byKey.get(a.key);
    if (!field || seen.has(a.key)) continue;
    seen.add(a.key);
    let v = a.value == null ? null : String(a.value).trim();
    if (v === '') v = null;
    if (v != null && (field.tag === 'select' || field.tag === 'radio')) v = pickOption(field.options || [], v);
    if (v != null) {
      const limit = field.maxLength > 0 ? Math.min(field.maxLength, MAX_TEXT) : field.tag === 'textarea' ? MAX_TEXT : 300;
      v = v.slice(0, limit);
    }
    const note = typeof a.note === 'string' ? a.note.trim().slice(0, 120) : '';
    out.push({ key: a.key, value: v, note, source: 'ai' });
  }
  return out.length ? out : null;
}

// Fields the AI should not even be asked about.
const AI_NEVER = /salary|\bctc\b|stipend|compensation|pay expectation|notice period|reference|\bcgpa\b|\bgpa\b|percentage|marks|aadha?ar|passport|\bpan\b|gender|caste|religion|marital/;

/**
 * Fills every field it can. `ask` is the JSON call (profileBuild.askJson) and is only made when
 * open questions remain and `useAi` is on.
 * @returns {{ answers, skipped, ai: { asked, answered, error } }}
 */
export async function fillFields({ profile, account, resumeText, page, fields, files, useAi = true, ask }) {
  const facts = profileFacts(profile, account);
  const { answers, rest, skipped } = matchFields(fields, facts, files);
  const ai = { asked: 0, answered: 0, error: null };
  const forAi = [];
  for (const f of rest) {
    if (AI_NEVER.test(fieldSignature(f))) skipped.push({ key: f.key, reason: 'never' });
    else forAi.push(f);
  }
  if (!useAi || !ask || !forAi.length) {
    for (const f of forAi) skipped.push({ key: f.key, reason: useAi ? 'no_ai' : 'ai_off' });
    return { answers, skipped, ai };
  }
  const batch = forAi.slice(0, MAX_AI_FIELDS);
  for (const f of forAi.slice(MAX_AI_FIELDS)) skipped.push({ key: f.key, reason: 'too_many' });
  ai.asked = batch.length;
  try {
    const replies = await ask({
      system: FILL_SYSTEM_PROMPT,
      user: fillUserPrompt({ page, fields: batch, facts, profile, resumeText }),
      validate: (v) => validateFillAnswers(v, batch),
      maxOutputTokens: Math.min(6_000, 250 * batch.length + 400),
    });
    const got = new Map(replies.map((r) => [r.key, r]));
    for (const f of batch) {
      const r = got.get(f.key);
      if (r?.value != null) {
        answers.push(r);
        ai.answered += 1;
      } else skipped.push({ key: f.key, reason: 'unknown', note: r?.note || '' });
    }
  } catch (err) {
    ai.error = err.message;
    for (const f of batch) skipped.push({ key: f.key, reason: 'ai_failed' });
  }
  return { answers, skipped, ai };
}

// What the extension needs to check the shape of a request before anything else runs.
export function sanitizeFields(input) {
  if (!Array.isArray(input)) return [];
  const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
  const keys = new Set();
  const out = [];
  for (const f of input.slice(0, MAX_FIELDS)) {
    if (!f || typeof f !== 'object') continue;
    const key = str(f.key, 20);
    if (!key || keys.has(key)) continue;
    keys.add(key);
    const tag = ['input', 'textarea', 'select', 'radio', 'file', 'checkbox'].includes(f.tag) ? f.tag : 'input';
    out.push({
      key,
      tag,
      type: str(f.type, 20).toLowerCase(),
      label: str(f.label, 300),
      name: str(f.name, 100),
      id: str(f.id, 100),
      placeholder: str(f.placeholder, 150),
      autocomplete: str(f.autocomplete, 40),
      required: f.required === true,
      maxLength: Number.isInteger(f.maxLength) && f.maxLength > 0 ? Math.min(f.maxLength, 100_000) : null,
      options: Array.isArray(f.options) ? f.options.map((o) => str(o, 120)).filter(Boolean).slice(0, 60) : [],
    });
  }
  return out;
}

export const CONTACT_FIELDS = CONTACT_KEYS;
