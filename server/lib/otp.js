// "Get code from Gmail" in ARCH in Chrome: the one-time code a job site just emailed, read from the
// person's connected Gmail (read-only access they already gave for job alerts). Only runs when they
// press the button, only looks at mail from the last 15 minutes, and returns the code alone.

import { simpleParser } from 'mailparser';
import { accessToken, fetchRawMessage, listMessageIds } from './google.js';
import { open } from './secretBox.js';

export const OTP_WINDOW_MINUTES = 15;

// Words that sit next to a code in these emails, in English (and the common Hindi "OTP").
const CODE_WORDS = /\b(otp|one[- ]time|verification|verify|security code|passcode|pass code|confirmation code|login code|sign[- ]?in code|access code|your code|code is|code:)/i;

/**
 * The code in one email's text, or null. Prefers a 4-8 digit (or 6-8 letter-digit) run within a
 * short distance of a code word; years, prices and phone numbers are skipped.
 */
export function extractCode(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  if (!CODE_WORDS.test(t)) return null;
  const candidates = [];
  for (const m of t.matchAll(/(?<![\w₹$.,/-])(\d{4,8}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})(?![\w,/-]|\.\d)/g)) {
    const code = m[1];
    const at = m.index;
    if (/^(19|20)\d{2}$/.test(code)) continue; // a year
    const before = t.slice(Math.max(0, at - 80), at);
    const after = t.slice(at, at + 40);
    if (/(rs\.?|inr|₹|\$|phone|mobile|call|\+\d*)\s*$/i.test(before.slice(-12))) continue;
    const near = CODE_WORDS.test(before) || /^\S+\s*(is your|is the)/i.test(after);
    candidates.push({ code, score: (near ? 10 : 0) + (code.length === 6 ? 2 : 0) - at / 10_000 });
  }
  candidates.sort((a, b) => b.score - a.score);
  // Only a code near a code word counts (the position tweak keeps the score just under 10+bonus).
  return candidates[0] && candidates[0].score >= 9 ? candidates[0].code : null;
}

// "careers.wsp.com" -> "wsp"; used to prefer mail from the site being filled in.
export const siteWord = (host) =>
  String(host || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .split('.')
    .filter((p) => !['com', 'co', 'in', 'org', 'net', 'io', 'jobs', 'careers', 'apply', 'myworkdayjobs', 'wd1', 'wd3', 'wd5', 'boards', 'job-boards', 'greenhouse', 'lever'].includes(p) && !/^wd\d+$/.test(p))[0] || '';

/**
 * @param user the users row (gmail_token sealed)
 * @param host the site asking (prefers mail mentioning it)
 * @returns {{ code, from, subject, receivedAt } | { error }}
 */
export async function findOtp(user, host, { now = new Date(), deps = { accessToken, listMessageIds, fetchRawMessage } } = {}) {
  const refresh = user?.gmail_token ? open(user.gmail_token) : null;
  if (!refresh) return { error: 'Connect Gmail in ArchJobs Settings first, so ARCH can read the code.' };
  const token = await deps.accessToken(refresh);
  const ids = await deps.listMessageIds(token, `newer_than:1h (code OR OTP OR verification OR verify OR passcode)`, 8);
  const word = siteWord(host);
  const found = [];
  for (const id of ids) {
    const msg = await deps.fetchRawMessage(token, id);
    if (!msg) continue;
    const mail = await simpleParser(msg.raw);
    const at = mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : now;
    if (now - at > OTP_WINDOW_MINUTES * 60_000) continue;
    const text = `${mail.subject || ''} ${mail.text || String(mail.html || '').replace(/<[^>]+>/g, ' ')}`;
    const code = extractCode(text);
    if (!code) continue;
    const from = mail.from?.value?.[0]?.address || '';
    const fromSite = word && `${from} ${mail.subject || ''}`.toLowerCase().includes(word);
    found.push({ code, from, subject: String(mail.subject || '').slice(0, 120), receivedAt: at, fromSite });
  }
  if (!found.length) return { error: `No code in your Gmail from the last ${OTP_WINDOW_MINUTES} minutes yet. Wait a moment and try again.` };
  found.sort((a, b) => Number(b.fromSite) - Number(a.fromSite) || b.receivedAt - a.receivedAt);
  const { code, from: sender, subject, receivedAt } = found[0];
  return { code, from: sender, subject, receivedAt };
}
