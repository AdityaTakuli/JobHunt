// Every 10 min: reads unseen mail in the dedicated jobs mailbox (LinkedIn alerts forwarded from
// Gmail), parses each job card and ingests it. Messages are marked \Seen only after they are stored.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { createClassifier } from '../lib/classify.js';
import { ingestJobs } from '../lib/ingest.js';
import { getSettings } from '../lib/settings.js';
import { countJobLinks, parseLinkedInAlert, SOURCE } from '../sources/linkedinEmail.js';

const MAX_MESSAGES_PER_RUN = 50;

// Parses raw messages (Buffers) into jobs. Split out so it can be tested without IMAP.
export async function parseMessages(sources) {
  const jobs = [];
  const failures = [];
  for (const source of sources) {
    const mail = await simpleParser(source);
    const html = typeof mail.html === 'string' ? mail.html : '';
    const text = mail.text || '';
    const parsed = parseLinkedInAlert({ html, text, receivedAt: mail.date || new Date() });
    if (!parsed.length) {
      const links = countJobLinks(html, text);
      failures.push(`"${mail.subject || '(no subject)'}": ${links ? `${links} job links but no cards parsed` : 'no LinkedIn job links'}`);
    }
    jobs.push(...parsed);
  }
  return { jobs, failures };
}

export async function readInbox({ linkChecker, fetchImpl = fetch } = {}) {
  const { imap } = config;
  if (!imap.user || !imap.pass) return { source: SOURCE, skipped: 'IMAP_USER / IMAP_PASSWORD not set' };

  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
  });

  const summary = { source: SOURCE, messages: 0 };
  let errorText = null;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(imap.mailbox);
    try {
      const uids = ((await client.search({ seen: false }, { uid: true })) || []).slice(0, MAX_MESSAGES_PER_RUN);
      summary.messages = uids.length;
      if (uids.length) {
        const sources = [];
        for await (const msg of client.fetch(uids, { source: true }, { uid: true })) sources.push(msg.source);

        const { jobs, failures } = await parseMessages(sources);
        const settings = await getSettings();
        const classifier = createClassifier({ extraExclude: settings.extra_exclude_keywords, fetchImpl });
        const result = await ingestJobs(jobs, { classifier, ...(linkChecker !== undefined && { linkChecker }) });
        await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });

        Object.assign(summary, result, { classifiedBy: classifier.stats });
        if (failures.length) {
          summary.parseFailures = failures;
          errorText = `Parse failures:\n${failures.join('\n')}`;
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    errorText = `IMAP: ${err.message}`;
    summary.error = errorText;
  } finally {
    await client.logout().catch(() => {});
  }

  // Skip logging quiet runs with nothing to report; this task runs 144 times a day.
  if (summary.messages || errorText) {
    await query('INSERT INTO fetch_log SET ?', [
      {
        source: SOURCE,
        run_at: new Date(),
        jobs_found: summary.found || 0,
        jobs_new: summary.new || 0,
        requests_used: summary.messages,
        error: errorText?.slice(0, 2000) ?? null,
      },
    ]);
  }
  return summary;
}
