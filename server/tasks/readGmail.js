// Every 30 min, for everyone who connected Gmail:
//   - LinkedIn job alerts: their jobs join the shared list;
//   - emails about their own applications (sent, interview, test, offer, rejection): their own
//     tracker moves on, or gains the role (lib/mailTriage.js reads them, lib/tracker.js applies them).
// Read-only: nothing in their mailbox is changed. Each run looks back to a day before the last
// sync, so a missed run loses nothing (repeat alerts merge into the same job; emails already read
// are in mail_events).

import { simpleParser } from 'mailparser';
import { query } from '../db/pool.js';
import { createClassifier } from '../lib/classify.js';
import { accessToken, fetchAlertEmails, fetchApplicationEmails, googleConfigured } from '../lib/google.js';
import { ingestJobs } from '../lib/ingest.js';
import { createMailTriage } from '../lib/mailTriage.js';
import { open } from '../lib/secretBox.js';
import { classifierContext } from '../lib/settings.js';
import { DAY_MS } from '../lib/time.js';
import { applyMailEvent } from '../lib/tracker.js';
import { parseMessages } from '../sources/linkedinEmail.js';

export const SOURCE = 'gmail';
const FIRST_LOOK_BACK_DAYS = 7;
// Application emails: the first read goes further back, to fill the tracker with recent ones.
const APPS_FIRST_LOOK_BACK_DAYS = 60;

// Gmail message ids already recorded for this person.
const knownIds = async (userId, ids) =>
  new Set(ids.length ? (await query('SELECT gmail_id FROM mail_events WHERE user_id = ? AND gmail_id IN (?)', [userId, ids])).map((r) => r.gmail_id) : []);

async function readMail({ id, raw }) {
  const mail = await simpleParser(raw);
  const from = mail.from?.value?.[0] || {};
  return {
    id,
    from: mail.from?.text || from.address || '',
    fromAddress: from.address ? String(from.address).toLowerCase() : null,
    fromName: from.name || null,
    subject: mail.subject || '',
    text: mail.text || '',
    receivedAt: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : new Date(),
  };
}

/**
 * Reads her application emails since the last read and applies each to her tracker, oldest first.
 * While the AI is out, emails the keyword rules can't place are left for the next run, and the
 * read position stays put so they are seen again.
 */
export async function syncApplications(user, token, { triage = createMailTriage(), now = new Date() } = {}) {
  const since = user.gmail_apps_synced_at
    ? new Date(new Date(user.gmail_apps_synced_at).getTime() - DAY_MS)
    : new Date(now.getTime() - APPS_FIRST_LOOK_BACK_DAYS * DAY_MS);
  const found = await fetchApplicationEmails(token, { after: since });
  const seen = await knownIds(user.id, found.map((m) => m.id));
  const mails = [];
  for (const m of found) if (!seen.has(m.id)) mails.push(await readMail(m));
  mails.sort((a, b) => a.receivedAt - b.receivedAt);

  const summary = { emails: mails.length, tracked: 0 };
  let aiMissed = false;
  for (const mail of mails) {
    const out = await triage.triage(mail);
    // Rules standing in for an AI that is down or out of budget (not one that was never set up).
    const standIn = out.classifier === 'rules' && triage.down !== 'not_configured';
    if (standIn) aiMissed = true;
    if (standIn && out.kind === 'other') continue;
    // Claim the email first: a run started alongside this one (connecting Gmail starts one,
    // "Check now" another) then skips it instead of applying it twice.
    const claim = await query('INSERT IGNORE INTO mail_events SET ?', [
      {
        user_id: user.id,
        gmail_id: mail.id,
        received_at: mail.receivedAt,
        from_addr: mail.fromAddress?.slice(0, 254) ?? null,
        subject: mail.subject.slice(0, 300) || null,
        kind: out.kind,
        company: out.company,
        role: out.role,
        classifier: out.classifier,
        created_at: now,
      },
    ]);
    if (!claim.affectedRows || out.kind === 'other') continue;
    const applicationId = await applyMailEvent(user.id, { ...mail, kind: out.kind, company: out.company, role: out.role }, now);
    if (!applicationId) continue;
    summary.tracked += 1;
    await query('UPDATE mail_events SET application_id = ? WHERE user_id = ? AND gmail_id = ?', [applicationId, user.id, mail.id]);
  }
  if (!aiMissed) await query('UPDATE users SET gmail_apps_synced_at = ? WHERE id = ?', [now, user.id]);
  return summary;
}

/**
 * New LinkedIn alert emails: their jobs join the shared list, and each email is recorded (with how
 * many jobs it held) so it is shown under its date and never parsed again.
 */
export async function syncAlerts(user, token, { since, linkChecker, now = new Date() }) {
  const found = await fetchAlertEmails(token, { after: since });
  const seen = await knownIds(user.id, found.map((m) => m.id));
  const fresh = found.filter((m) => !seen.has(m.id));
  const summary = { messages: fresh.length, found: 0, new: 0 };
  if (!fresh.length) return summary;

  const parsed = [];
  for (const m of fresh) parsed.push({ mail: await readMail(m), ...(await parseMessages([m.raw])) });
  const jobs = parsed.flatMap((p) => p.jobs);
  if (jobs.length) {
    const classifier = createClassifier({ ...(await classifierContext()) });
    const result = await ingestJobs(jobs, { classifier, ...(linkChecker !== undefined && { linkChecker }), now });
    Object.assign(summary, { found: result.found, new: result.new });
  }
  const failures = parsed.filter((p) => p.failures.length).length;
  if (failures) summary.parseFailures = failures;
  await query('INSERT IGNORE INTO mail_events (user_id, gmail_id, received_at, from_addr, subject, kind, classifier, jobs_found, created_at) VALUES ?', [
    parsed.map(({ mail, jobs: j }) => [user.id, mail.id, mail.receivedAt, mail.fromAddress?.slice(0, 254) ?? null, mail.subject.slice(0, 300) || null, 'alert', 'parser', j.length, now]),
  ]);
  return summary;
}

// Access she removed (or a token the server can no longer read): stop trying until she reconnects.
const GONE = new Set(['invalid_grant', 'unauthorized_client']);

export async function syncGmail(user, { linkChecker, triage, now = new Date() } = {}) {
  const refreshToken = open(user.gmail_token);
  if (!refreshToken) {
    await query('UPDATE users SET gmail_token = NULL, gmail_error = ? WHERE id = ?', ['Gmail needs to be connected again.', user.id]);
    return { user: user.id, error: 'token unreadable' };
  }
  const since = user.gmail_synced_at
    ? new Date(new Date(user.gmail_synced_at).getTime() - DAY_MS)
    : new Date(now.getTime() - FIRST_LOOK_BACK_DAYS * DAY_MS);

  try {
    const token = await accessToken(refreshToken);
    // Application emails first: LinkedIn's "application sent" emails must not be taken for alerts.
    const applications = await syncApplications(user, token, { ...(triage && { triage }), now });
    const alerts = await syncAlerts(user, token, { since, linkChecker, now });
    const summary = { user: user.id, ...alerts, ...applications };
    await query('UPDATE users SET gmail_synced_at = ?, gmail_error = NULL WHERE id = ?', [now, user.id]);
    return summary;
  } catch (err) {
    const gone = GONE.has(err.code);
    const message = gone ? 'Gmail access was removed. Connect it again to keep getting alerts.' : `Gmail: ${err.message}`.slice(0, 300);
    await query(`UPDATE users SET gmail_error = ?${gone ? ', gmail_token = NULL' : ''} WHERE id = ?`, [message, user.id]);
    return { user: user.id, error: message };
  }
}

export async function readGmail({ linkChecker, now = new Date(), userId, triage } = {}) {
  if (!googleConfigured()) return { source: SOURCE, skipped: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set' };
  const users = await query(`SELECT * FROM users WHERE gmail_token IS NOT NULL${userId ? ' AND id = ?' : ''}`, userId ? [userId] : []);
  if (!users.length) return { source: SOURCE, skipped: 'Nobody has connected Gmail' };

  const results = [];
  // One triage session for the run, so its token budget and down models carry across people.
  const shared = triage || createMailTriage();
  for (const user of users) results.push(await syncGmail(user, { linkChecker, triage: shared, now }));
  const messages = results.reduce((n, r) => n + (r.messages || 0), 0);
  const errors = results.filter((r) => r.error).map((r) => `user ${r.user}: ${r.error}`);
  const summary = {
    source: SOURCE,
    people: users.length,
    messages,
    found: results.reduce((n, r) => n + (r.found || 0), 0),
    new: results.reduce((n, r) => n + (r.new || 0), 0),
    emails: results.reduce((n, r) => n + (r.emails || 0), 0),
    tracked: results.reduce((n, r) => n + (r.tracked || 0), 0),
    ...(errors.length && { errors }),
  };
  // Quiet runs are not logged; this runs 48 times a day.
  if (messages || summary.emails || errors.length) {
    await query('INSERT INTO fetch_log SET ?', [
      { source: SOURCE, run_at: now, jobs_found: summary.found, jobs_new: summary.new, requests_used: messages, error: errors.join('\n').slice(0, 2000) || null },
    ]);
  }
  return summary;
}

