// Tracker changes made outside a click: the status rules shared with routes/applications.js, and
// moving a tracker entry when an email about it arrives (tasks/readGmail.js).

import { query } from '../db/pool.js';
import { TIMEZONE } from '../config.js';
import { DAY_MS } from './time.js';

const FOLLOW_UP_DAYS = 7;
// Title of an entry made from an email that named no role (LinkedIn's "application sent").
export const PLACEHOLDER_ROLE = 'Role from Gmail';

// Moving to "applied" stamps the date and auto-sets a follow-up 7 days later.
export function applyStatusSideEffects(fields, current = {}, now = new Date()) {
  if (fields.status === 'applied' && current.status !== 'applied') {
    const appliedAt = fields.applied_at ?? current.applied_at ?? now;
    fields.applied_at = appliedAt;
    if (!('follow_up_at' in fields) && !current.follow_up_at) {
      fields.follow_up_at = new Date(new Date(appliedAt).getTime() + FOLLOW_UP_DAYS * DAY_MS);
    }
  }
  return fields;
}

const STATUS_FOR = { applied: 'applied', interview: 'interview', assessment: 'interview', offer: 'offer', rejected: 'rejected' };
const RANK = { saved: 0, applied: 1, interview: 2, offer: 3 };
const NOTE_LABEL = { applied: 'application sent', interview: 'interview', assessment: 'test or task', offer: 'offer', rejected: 'not selected' };

// Emails are read oldest first, so a later email may move an entry on: forward (applied ->
// interview -> offer), to rejected from anything but an offer, or out of rejected when a new
// interview or offer arrives. Never backwards.
export function nextStatus(current, kind) {
  const target = STATUS_FOR[kind];
  if (!target || target === current) return null;
  if (target === 'rejected') return current === 'offer' ? null : target;
  if (current === 'rejected') return target === 'applied' ? null : target;
  return RANK[target] > (RANK[current] ?? 0) ? target : null;
}

const COMPANY_NOISE = /\b(the|pvt|private|ltd|limited|llp|llc|inc|co|company|india|group|architects?|studio|design|designs|associates|consultants?)\b/g;

export function normCompany(name) {
  const full = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ');
  const core = full.replace(COMPANY_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return core || full.replace(/\s+/g, ' ').trim();
}

const ROLE_STOP = new Set(['a', 'an', 'the', 'and', 'of', 'for', 'in', 'at', 'to', 'with', 'role', 'position', 'job']);
const roleWords = (role) => new Set(String(role || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !ROLE_STOP.has(w)));

// Share of the shorter title's words found in the other: 1 = same role, 0 = nothing in common.
export function roleOverlap(a, b) {
  const wa = roleWords(a);
  const wb = roleWords(b);
  if (!wa.size || !wb.size) return null;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

const sameCompany = (a, b) => {
  const na = normCompany(a);
  const nb = normCompany(b);
  if (!na || !nb) return false;
  return na === nb || (Math.min(na.length, nb.length) >= 4 && (na.includes(nb) || nb.includes(na)));
};

// The entry an email is about: same company, and the same role when both name one.
export function pickApplication(apps, { company, role }) {
  let best = null;
  let bestScore = -1;
  for (const app of apps) {
    if (!sameCompany(app.company, company)) continue;
    const overlap = app.title === PLACEHOLDER_ROLE ? null : roleOverlap(app.title, role);
    if (overlap === 0) continue; // a different role at the same firm
    const score = overlap ?? 0.5;
    if (score > bestScore) [best, bestScore] = [app, score];
  }
  return best;
}

// Job sites and mail robots: their address is no use as a contact.
const ROBOT = /(no-?reply|do-?not-?reply|notifications?|mailer|alerts?|jobs-noreply|talent-?acquisition-?noreply|@(.*\.)?(linkedin|naukri|indeed|myworkday|workday|greenhouse|lever|smartrecruiters|internshala|glassdoor|foundit|instahyre)\.)/i;

const shortDate = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: TIMEZONE });

function noteLine(event) {
  const subject = event.subject ? ` — "${String(event.subject).slice(0, 140)}"` : '';
  return `Gmail ${shortDate(event.receivedAt)}: ${NOTE_LABEL[event.kind]}${subject}`;
}

const appendNote = (notes, line) => (notes ? `${notes}\n${line}` : line).slice(-5000);

// A posting in the shared list that this email is about, to link the new entry to.
async function findJob(company, role) {
  if (!role) return null;
  const first = normCompany(company).split(' ')[0];
  if (!first || first.length < 3) return null;
  const rows = await query('SELECT id, title, company FROM jobs WHERE company LIKE ? ORDER BY created_at DESC LIMIT 50', [`%${first}%`]);
  const match = rows.find((r) => sameCompany(r.company, company) && (roleOverlap(r.title, role) ?? 0) >= 0.6);
  return match?.id ?? null;
}

/**
 * Applies one triaged email to her tracker. Returns the entry's id, or null when the email
 * changes nothing (not about an application, or the company is unknown).
 * @param event { kind, company, role, receivedAt, fromAddress, fromName, subject }
 */
export async function applyMailEvent(userId, event, now = new Date()) {
  if (!STATUS_FOR[event.kind] || !event.company) return null;
  const apps = await query(
    `SELECT a.id, a.status, a.applied_at, a.follow_up_at, a.notes, a.contact_email, a.contact_name,
       COALESCE(j.company, a.company) AS company, COALESCE(j.title, a.title) AS title
     FROM applications a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.user_id = ? ORDER BY a.updated_at DESC LIMIT 500`,
    [userId],
  );
  const contact = event.fromAddress && !ROBOT.test(event.fromAddress) ? { email: event.fromAddress.slice(0, 200), name: event.fromName?.slice(0, 150) || null } : null;
  const found = pickApplication(apps, event);

  if (found) {
    const fields = { notes: appendNote(found.notes, noteLine(event)) };
    const status = nextStatus(found.status, event.kind);
    if (status) Object.assign(fields, applyStatusSideEffects({ status, ...(status === 'applied' && !found.applied_at && { applied_at: event.receivedAt }) }, found, now));
    if (contact && !found.contact_email) Object.assign(fields, { contact_email: contact.email, contact_name: found.contact_name || contact.name });
    if (found.title === PLACEHOLDER_ROLE && event.role) fields.title = event.role.slice(0, 300);
    await query('UPDATE applications SET ?, updated_at = ? WHERE id = ?', [fields, now, found.id]);
    return found.id;
  }

  const status = STATUS_FOR[event.kind];
  let jobId = await findJob(event.company, event.role);
  if (jobId) {
    const [taken] = await query('SELECT id FROM applications WHERE user_id = ? AND job_id = ?', [userId, jobId]);
    if (taken) jobId = null;
  }
  const fields = applyStatusSideEffects(
    {
      status,
      ...(status === 'applied' && { applied_at: event.receivedAt }),
      title: (event.role || PLACEHOLDER_ROLE).slice(0, 300),
      company: event.company.slice(0, 200),
      notes: noteLine(event),
      ...(contact && { contact_email: contact.email, contact_name: contact.name }),
    },
    {},
    now,
  );
  const res = await query('INSERT INTO applications SET ?', [{ ...fields, user_id: userId, job_id: jobId, source: 'gmail', created_at: now, updated_at: now }]);
  return res.insertId;
}
