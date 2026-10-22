// Every 30 min: reads the LinkedIn job alerts in the Gmail of everyone who connected it, and adds
// the jobs to the shared list. Read-only: nothing in their mailbox is changed. Each run looks back
// to a day before the last sync, so a missed run loses nothing (repeats merge into the same job).

import { query } from '../db/pool.js';
import { createClassifier } from '../lib/classify.js';
import { accessToken, fetchAlertEmails, googleConfigured } from '../lib/google.js';
import { ingestJobs } from '../lib/ingest.js';
import { open } from '../lib/secretBox.js';
import { classifierContext } from '../lib/settings.js';
import { DAY_MS } from '../lib/time.js';
import { parseMessages } from './readInbox.js';

export const SOURCE = 'gmail';
const FIRST_LOOK_BACK_DAYS = 7;

// Access she removed (or a token the server can no longer read): stop trying until she reconnects.
const GONE = new Set(['invalid_grant', 'unauthorized_client']);

export async function syncGmail(user, { linkChecker, now = new Date() } = {}) {
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
    const sources = await fetchAlertEmails(token, { after: since });
    const summary = { user: user.id, messages: sources.length, found: 0, new: 0 };
    if (sources.length) {
      const { jobs, failures } = await parseMessages(sources);
      const classifier = createClassifier({ ...(await classifierContext()) });
      const result = await ingestJobs(jobs, { classifier, ...(linkChecker !== undefined && { linkChecker }), now });
      Object.assign(summary, { found: result.found, new: result.new });
      if (failures.length) summary.parseFailures = failures.length;
    }
    await query('UPDATE users SET gmail_synced_at = ?, gmail_error = NULL WHERE id = ?', [now, user.id]);
    return summary;
  } catch (err) {
    const gone = GONE.has(err.code);
    const message = gone ? 'Gmail access was removed. Connect it again to keep getting alerts.' : `Gmail: ${err.message}`.slice(0, 300);
    await query(`UPDATE users SET gmail_error = ?${gone ? ', gmail_token = NULL' : ''} WHERE id = ?`, [message, user.id]);
    return { user: user.id, error: message };
  }
}

export async function readGmail({ linkChecker, now = new Date(), userId } = {}) {
  if (!googleConfigured()) return { source: SOURCE, skipped: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set' };
  const users = await query(`SELECT * FROM users WHERE gmail_token IS NOT NULL${userId ? ' AND id = ?' : ''}`, userId ? [userId] : []);
  if (!users.length) return { source: SOURCE, skipped: 'Nobody has connected Gmail' };

  const results = [];
  for (const user of users) results.push(await syncGmail(user, { linkChecker, now }));
  const messages = results.reduce((n, r) => n + (r.messages || 0), 0);
  const errors = results.filter((r) => r.error).map((r) => `user ${r.user}: ${r.error}`);
  const summary = {
    source: SOURCE,
    people: users.length,
    messages,
    found: results.reduce((n, r) => n + (r.found || 0), 0),
    new: results.reduce((n, r) => n + (r.new || 0), 0),
    ...(errors.length && { errors }),
  };
  // Quiet runs are not logged; this runs 48 times a day.
  if (messages || errors.length) {
    await query('INSERT INTO fetch_log SET ?', [
      { source: SOURCE, run_at: now, jobs_found: summary.found, jobs_new: summary.new, requests_used: messages, error: errors.join('\n').slice(0, 2000) || null },
    ]);
  }
  return summary;
}

