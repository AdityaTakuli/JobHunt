// Job emails from any sender other than LinkedIn's alerts: job sites (Glassdoor, Naukri, Indeed,
// Internshala...), company newsletters, "we're hiring" posts, placement-cell mail. No layout is
// assumed: the email becomes plain text with its links numbered [L1], [L2]..., the AI lists the
// openings it holds (lib/mailTriage.js, extractJobs), and each one becomes a job row here.

import * as cheerio from 'cheerio';
import { cleanText, decodeEntities, hostOf, normalizeCity } from '../lib/normalize.js';
import { parseSalary } from '../lib/salary.js';
import { DAY_MS } from '../lib/time.js';

export const SOURCE = 'job_email';
// Enough for a long digest (~40 openings) while keeping each call well inside the token budget.
export const MAX_EMAIL_CHARS = 9_000;
export const MAX_JOBS = 60;

// Links that never open a job: unsubscribe, settings, legal, app stores, social profiles.
const NOT_A_JOB_LINK = /unsubscribe|preferences|manage (settings|alerts|notifications)|privacy|terms|help ?cent|view (it )?(in|on) (your )?browser|app ?store|google play|^(facebook|twitter|x|instagram|youtube|linkedin)$/i;
const SKIP_HOSTS = ['facebook.com', 'twitter.com', 'x.com', 'instagram.com', 'youtube.com', 'apps.apple.com', 'play.google.com'];

// Footer lines: everything after these is unsubscribe text and addresses, not jobs.
const FOOTER = /^(this (message|email) was sent to|you (are )?receiv(ed|ing) this|to unsubscribe|unsubscribe\b|copyright|©)/i;

/**
 * Plain text of an email with its links numbered, for the AI.
 * @returns { text, links } where links[n - 1] is the URL behind [Ln]
 */
export function emailToText({ html, text }) {
  const links = [];
  const ids = new Map();
  const linkId = (url) => {
    if (!ids.has(url)) {
      links.push(url);
      ids.set(url, links.length);
    }
    return ids.get(url);
  };
  const usable = (url, label) => /^https?:\/\//i.test(url) && !NOT_A_JOB_LINK.test(label.trim()) && !SKIP_HOSTS.some((h) => hostOf(url) === h || hostOf(url).endsWith(`.${h}`));

  let lines;
  if (html) {
    const $ = cheerio.load(html);
    $('script, style, head, title').remove();
    // Hidden preview text repeats the subject.
    $('[style*="display:none"], [style*="display: none"]').remove();
    $('img').each((_, img) => {
      const alt = $(img).attr('alt');
      $(img).replaceWith(alt && alt.length > 1 ? ` ${alt} ` : ' ');
    });
    $('a[href]').each((_, a) => {
      const url = String($(a).attr('href')).trim();
      const label = $(a).text().replace(/\s+/g, ' ');
      if (!usable(url, label)) return;
      const n = linkId(url);
      // A link around a whole job card is marked at both ends, so it is clear which job it opens.
      if ($(a).find('table, div, p, td, tr, br, h1, h2, h3, h4, li').length) $(a).prepend(`\n[L${n}]\n`).append(`\n[/L${n}]\n`);
      else $(a).append(` [L${n}]`);
    });
    $('br').replaceWith('\n');
    $('p, div, td, th, tr, table, li, h1, h2, h3, h4, h5, h6').each((_, el) => {
      $(el).append('\n');
    });
    lines = decodeEntities($.root().text()).split('\n');
  } else {
    lines = String(text || '')
      .replace(/https?:\/\/[^\s<>"')\]]+/gi, (url) => (usable(url, '') ? `[L${linkId(url)}]` : ''))
      .split(/\r?\n/);
  }

  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/[\s ​-‍͏﻿]+/g, ' ').trim();
    if (!line || /^[·•|\-–—_=*\s]+$/.test(line)) continue;
    if (FOOTER.test(line) && out.length > 5) break;
    if (out[out.length - 1] !== line) out.push(line);
  }
  return { text: out.join('\n').slice(0, MAX_EMAIL_CHARS), links };
}

// Cheap check before spending AI tokens: an email that lists openings has a link and job words.
const JOB_WORDS = /\b(jobs?|hiring|vacanc(y|ies)|openings?|intern(ship)?s?|careers?|positions?|roles?|apply|recruit(ment|ing)?|walk-?in)\b/i;
export function mightListJobs({ subject, text }, links) {
  return links.length > 0 && JOB_WORDS.test(`${subject || ''}\n${text || ''}`);
}

export const JOB_EMAIL_PROMPT = `You read one email from a job seeker's inbox and list the job openings it contains.
Links in the email are written as [L1], [L2] and so on; a link wrapped around a whole job card is
written [L3] at its start and [/L3] at its end.

Reply with one JSON object and nothing else:
{
  "jobs": [
    {
      "title": string,              // the job title, as written
      "company": string | null,     // the employer (not the job site that sent the email), without ratings
      "location": string | null,    // city or area as written, e.g. "Bengaluru", "Remote", "India"
      "salary": string | null,      // pay or stipend exactly as written, e.g. "₹3M - ₹4M"
      "posted_days_ago": integer | null, // 0 for "just posted" or hours; "3d" = 3; null if not shown
      "link": string | null         // the [L..] link that opens this job, written like "L3"
    }
  ]
}
List every opening in a job alert, job recommendation, newsletter, hiring post or placement email.
Do not invent anything: copy titles and companies as written, and leave out "see more jobs",
"create alert", course, event and unsubscribe links.
Reply {"jobs": []} when the email lists no openings: updates on her own applications, OTPs,
receipts, ads for courses or paid plans, general newsletters.`;

export function jobEmailPrompt(mail, emailText) {
  return [`From: ${mail.from || 'unknown'}`, `Subject: ${mail.subject || '(no subject)'}`, '', emailText || '(empty)'].join('\n');
}

const str = (value, max) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text && !/^(null|unknown|n\/a|none)$/i.test(text) ? text.slice(0, max) : null;
};

// Strict check of the AI answer. Returns { jobs } or null when the shape is wrong.
export function validateJobList(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.jobs)) return null;
  const jobs = [];
  for (const j of value.jobs.slice(0, MAX_JOBS)) {
    if (!j || typeof j !== 'object') continue;
    const title = str(j.title, 300);
    if (!title || title.length < 2) continue;
    const days = Number.isInteger(j.posted_days_ago) && j.posted_days_ago >= 0 && j.posted_days_ago <= 90 ? j.posted_days_ago : null;
    const link = typeof j.link === 'string' ? j.link.trim().match(/^\[?L(\d{1,4})\]?$/i)?.[1] : null;
    jobs.push({ title, company: str(j.company, 200), location: str(j.location, 200), salary: str(j.salary, 120), postedDaysAgo: days, link: link ? Number(link) : null });
  }
  return { jobs };
}

// "Glassdoor Jobs <noreply@glassdoor.com>" -> "Glassdoor"; falls back to the sender's domain.
export function publisherOf({ fromName, fromAddress }) {
  const name = String(fromName || '')
    .replace(/\b(job ?alerts?|jobs?|alerts?|careers?|team|no-?reply|notifications?|updates?|recruit(ment|ing)?)\b/gi, '')
    .replace(/[\s\-–|:,.]+$/g, '')
    .replace(/^[\s\-–|:,.]+/g, '')
    .trim();
  if (name.length >= 2) return name.slice(0, 80);
  const domain = String(fromAddress || '').split('@')[1] || '';
  const parts = domain.split('.').filter((p) => !['mail', 'email', 'e', 'em', 'info', 'news', 'alerts', 'jobs', 'co', 'com', 'in', 'org', 'net', 'io'].includes(p));
  const base = parts[parts.length - 1] || domain;
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Email';
}

// The AI's openings -> job rows for ingestJobs. Openings without a link to open are left out:
// the Jobs list needs somewhere to send her.
export function jobsFromEmail(found, { links, mail }) {
  const publisher = publisherOf(mail);
  const receivedAt = mail.receivedAt || new Date();
  const out = [];
  for (const j of found.jobs) {
    const url = j.link ? links[j.link - 1] : null;
    if (!url) continue;
    const salary = j.salary ? parseSalary(j.salary) || { text: j.salary, min: null, max: null, period: null } : null;
    out.push({
      source: SOURCE,
      title: cleanText(j.title, 300),
      company: cleanText(j.company || '', 200),
      locationText: cleanText(j.location || '', 200),
      city: normalizeCity(j.location || ''),
      description: '',
      applyUrl: url,
      publisher,
      postedAt: j.postedDaysAgo != null ? new Date(receivedAt.getTime() - j.postedDaysAgo * DAY_MS) : receivedAt,
      salary,
    });
  }
  return out;
}

// Query parameters that only track the click (or carry her identity) and are dropped once a
// link has been followed to the job page.
const TRACKING_PARAM = /^(utm_\w*|mc_\w*|_hs\w*|trk\w*|tracking\w*|hsenc|hsmi|ref|refid|src|campaign|cid|eid|uid|userid|user_id|email|e|em|token|sig|signature|hash|fbclid|gclid|clickid|click_id|lid|sid)$/i;

export function stripTracking(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Email links usually go through a click tracker carrying her identity. Follows the redirects to
 * the job page itself and drops the tracking parameters, so the shared Jobs list holds a clean
 * link. Keeps the original link when it can't be followed.
 */
export async function resolveJobLink(url, { fetchImpl = fetch, timeoutMs = 8_000, maxHops = 6 } = {}) {
  let current = url;
  try {
    for (let hop = 0; hop < maxHops; hop += 1) {
      const res = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' },
      });
      res.body?.cancel?.().catch(() => {});
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      const next = new URL(location, current).toString();
      if (!/^https?:/i.test(next)) break;
      current = next;
    }
  } catch {
    // Timeout or network error: keep what was reached so far.
  }
  // A tracker that was never left still needs its own parameters to work.
  return current === url ? url : stripTracking(current);
}
