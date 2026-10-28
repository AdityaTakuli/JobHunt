// Every 30 min, for everyone who connected Gmail:
//   - LinkedIn job alerts: their jobs join the shared list;
//   - job emails from any other sender (job sites, company newsletters, hiring posts): the AI
//     lists their openings, which join the shared list too (sources/jobEmail.js);
//   - emails about their own applications (sent, interview, test, offer, rejection): their own
//     tracker moves on, or gains the role (lib/mailTriage.js reads them, lib/tracker.js applies them).
// Read-only: nothing in their mailbox is changed. Each run looks back to a day before the last
// sync, so a missed run loses nothing (repeat alerts merge into the same job; emails already read
// are in mail_events).

import { simpleParser } from 'mailparser';
import { query } from '../db/pool.js';
import { createClassifier } from '../lib/classify.js';
import { config } from '../config.js';
import { accessToken, fetchAlertEmails, fetchApplicationEmails, fetchRawMessage, googleConfigured, listJobEmailIds } from '../lib/google.js';
import { ingestJobs } from '../lib/ingest.js';
import { mapLimit } from '../lib/linkCheck.js';
import { createMailTriage } from '../lib/mailTriage.js';
import { open } from '../lib/secretBox.js';
import { classifierContext } from '../lib/settings.js';
import { DAY_MS } from '../lib/time.js';
import { applyMailEvent } from '../lib/tracker.js';
import { emailToText, jobsFromEmail, mightListJobs, resolveJobLink } from '../sources/jobEmail.js';
import { parseMessages } from '../sources/linkedinEmail.js';

export const SOURCE = 'gmail';
const FIRST_LOOK_BACK_DAYS = 7;
// Application emails: the first read goes further back, to fill the tracker with recent ones.
const APPS_FIRST_LOOK_BACK_DAYS = 60;
// Job emails from other senders: always the last few days, newest first. Each is read once, so
// emails the AI had no time or budget for are simply picked up on a later run.
const JOB_EMAILS_LOOK_BACK_DAYS = 3;
const JOB_EMAILS_FIRST_LOOK_BACK_DAYS = 7;

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
    html: typeof mail.html === 'string' ? mail.html : '',
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

/**
 * Job emails from any sender other than LinkedIn's alerts. Each new one is turned into text with
 * numbered links; emails without links or job words are noted without asking the AI; the rest go
 * to the AI, whose openings join the shared Jobs list. An email the AI could not read (down or out
 * of budget) is not recorded, so a later run reads it.
 */
export async function syncJobEmails(user, token, { triage, linkChecker, resolveLink = resolveJobLink, now = new Date(), perRun = config.google.gmailJobEmailsPerRun }) {
  const days = user.gmail_synced_at ? JOB_EMAILS_LOOK_BACK_DAYS : JOB_EMAILS_FIRST_LOOK_BACK_DAYS;
  const ids = await listJobEmailIds(token, { after: new Date(now.getTime() - days * DAY_MS) });
  // Done = read here before, or found to be about one of her applications. Emails the application
  // reader set aside as "other" may still hold openings, so they are read here too.
  const done = new Set(
    ids.length
      ? (
          await query(
            "SELECT gmail_id FROM mail_events WHERE user_id = ? AND gmail_id IN (?) AND (kind <> 'other' OR jobs_found IS NOT NULL)",
            [user.id, ids],
          )
        ).map((r) => r.gmail_id)
      : [],
  );
  const todo = ids.filter((id) => !done.has(id)).slice(0, perRun);
  const summary = { jobEmails: 0, jobEmailJobs: 0, jobEmailNew: 0 };
  if (!todo.length) return summary;

  const record = (mail, kind, classifier, jobsFound) =>
    query(
      `INSERT INTO mail_events SET ?
         ON DUPLICATE KEY UPDATE kind = VALUES(kind), classifier = VALUES(classifier), jobs_found = VALUES(jobs_found)`,
      [
        {
          user_id: user.id,
          gmail_id: mail.id,
          received_at: mail.receivedAt,
          from_addr: mail.fromAddress?.slice(0, 254) ?? null,
          subject: mail.subject.slice(0, 300) || null,
          kind,
          classifier,
          jobs_found: jobsFound,
          created_at: now,
        },
      ],
    );

  const jobs = [];
  for (const id of todo) {
    const raw = await fetchRawMessage(token, id);
    if (!raw) continue;
    const mail = await readMail(raw);
    const { text, links } = emailToText(mail);
    if (!mightListJobs({ subject: mail.subject, text }, links)) {
      await record(mail, 'other', 'rules', 0);
      continue;
    }
    const found = await triage.extractJobs(mail, text);
    if (!found) break; // AI out for this run; the rest wait too.
    const rows = jobsFromEmail(found, { links, mail });
    summary.jobEmails += 1;
    if (rows.length) {
      // Follow click trackers to the job page, so the shared list never holds her tracking links.
      const urls = await mapLimit(rows, 4, (r) => resolveLink(r.applyUrl));
      rows.forEach((r, i) => {
        r.applyUrl = urls[i];
      });
      jobs.push(...rows);
    }
    await record(mail, rows.length ? 'alert' : 'other', 'freellm', rows.length);
  }
  if (jobs.length) {
    const classifier = createClassifier({ ...(await classifierContext()) });
    const result = await ingestJobs(jobs, { classifier, ...(linkChecker !== undefined && { linkChecker }), now });
    Object.assign(summary, { jobEmailJobs: result.found, jobEmailNew: result.new });
  }
  return summary;
}

// Access she removed (or a token the server can no longer read): stop trying until she reconnects.
const GONE = new Set(['invalid_grant', 'unauthorized_client']);

export async function syncGmail(user, { linkChecker, triage = createMailTriage(), jobEmailsPerRun, now = new Date() } = {}) {
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
    const applications = await syncApplications(user, token, { triage, now });
    const alerts = await syncAlerts(user, token, { since, linkChecker, now });
    const jobEmails = await syncJobEmails(user, token, { triage, linkChecker, now, ...(jobEmailsPerRun && { perRun: jobEmailsPerRun }) });
    const summary = { user: user.id, ...alerts, ...applications, ...jobEmails };
    await query('UPDATE users SET gmail_synced_at = ?, gmail_error = NULL WHERE id = ?', [now, user.id]);
    return summary;
  } catch (err) {
    const gone = GONE.has(err.code);
    const message = gone ? 'Gmail access was removed. Connect it again to keep getting alerts.' : `Gmail: ${err.message}`.slice(0, 300);
    await query(`UPDATE users SET gmail_error = ?${gone ? ', gmail_token = NULL' : ''} WHERE id = ?`, [message, user.id]);
    return { user: user.id, error: message };
  }
}

/** @param jobEmailsPerRun fewer job emails for "Check now", so the button answers quickly */
export async function readGmail({ linkChecker, now = new Date(), userId, triage, jobEmailsPerRun } = {}) {
  if (!googleConfigured()) return { source: SOURCE, skipped: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set' };
  const users = await query(`SELECT * FROM users WHERE gmail_token IS NOT NULL${userId ? ' AND id = ?' : ''}`, userId ? [userId] : []);
  if (!users.length) return { source: SOURCE, skipped: 'Nobody has connected Gmail' };

  const results = [];
  // One triage session for the run, so its token budget and down models carry across people.
  const shared = triage || createMailTriage();
  for (const user of users) results.push(await syncGmail(user, { linkChecker, triage: shared, jobEmailsPerRun, now }));
  const total = (key) => results.reduce((n, r) => n + (r[key] || 0), 0);
  // LinkedIn alerts and job emails from other senders count together.
  const messages = total('messages') + total('jobEmails');
  const errors = results.filter((r) => r.error).map((r) => `user ${r.user}: ${r.error}`);
  const summary = {
    source: SOURCE,
    people: users.length,
    messages,
    found: total('found') + total('jobEmailJobs'),
    new: total('new') + total('jobEmailNew'),
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

