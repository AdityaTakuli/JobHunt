// Daily clean-up of the job list:
//   1. postings whose "apply by" date has passed close;
//   2. apply links are re-checked, a few dozen per run: a posting whose links all say "removed"
//      or "no longer accepting applications" closes (a dead best link is swapped for a live one);
//   3. jobs older than 30 days are archived;
//   4. closed and long-archived jobs are deleted for good, unless someone has them in their
//      tracker. A note of each is kept so a source still listing it cannot bring it back.
// Closed jobs vanish from every list at once; deletion only follows later.

import { parseJson, query } from '../db/pool.js';
import { checkLink, mapLimit } from '../lib/linkCheck.js';
import { DAY_MS } from '../lib/time.js';

const RECHECK_DAYS = 3;
const LINKS_PER_RUN = 60;
const DELETE_CLOSED_AFTER_DAYS = 14;
const DELETE_ARCHIVED_AFTER_DAYS = 60;
const FORGET_AFTER_DAYS = 180;

// Jobs older than 30 days are archived unless someone saved or tracked them.
export async function archiveOldJobs(now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);
  const res = await query(
    `UPDATE jobs j
        SET j.is_archived = 1, j.updated_at = ?
      WHERE j.is_archived = 0
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id)
        AND COALESCE(j.posted_at, j.created_at) < ?`,
    [now, cutoff],
  );
  return res.affectedRows;
}

export async function closePastDeadlines(now = new Date()) {
  const res = await query(
    "UPDATE jobs SET closed_at = ?, closed_reason = 'deadline', updated_at = ? WHERE closed_at IS NULL AND deadline_at IS NOT NULL AND deadline_at < ?",
    [now, now, now],
  );
  return res.affectedRows;
}

// Re-checks the links of open jobs not checked in the last few days, oldest check first.
export async function recheckLinks({ now = new Date(), linkChecker = checkLink, limit = LINKS_PER_RUN } = {}) {
  const jobs = await query(
    `SELECT id, apply_url, apply_options FROM jobs
      WHERE closed_at IS NULL AND is_archived = 0 AND (link_checked_at IS NULL OR link_checked_at < ?)
      ORDER BY link_checked_at IS NOT NULL, link_checked_at, created_at
      LIMIT ?`,
    [new Date(now.getTime() - RECHECK_DAYS * DAY_MS), limit],
  );
  const summary = { checked: jobs.length, closed: 0, relinked: 0 };

  await mapLimit(jobs, 4, async (job) => {
    const status = await linkChecker(job.apply_url);
    if (status !== 'broken') {
      await query('UPDATE jobs SET link_status = ?, link_checked_at = ? WHERE id = ?', [status, now, job.id]);
      return;
    }
    // The best link is dead: try the other places it was listed, best first.
    const others = parseJson(job.apply_options, []).filter((o) => o.url && o.url !== job.apply_url);
    for (const option of others.slice(0, 3)) {
      const other = await linkChecker(option.url);
      if (other !== 'broken') {
        const rest = parseJson(job.apply_options, []).filter((o) => o.url !== job.apply_url);
        await query(
          'UPDATE jobs SET apply_url = ?, apply_url_rank = ?, apply_kind = ?, apply_options = ?, link_status = ?, link_checked_at = ?, updated_at = ? WHERE id = ?',
          [option.url.slice(0, 1000), option.rank ?? 1, option.kind ?? null, JSON.stringify(rest), other, now, now, job.id],
        );
        summary.relinked += 1;
        return;
      }
    }
    await query("UPDATE jobs SET link_status = 'broken', link_checked_at = ?, closed_at = ?, closed_reason = 'removed', updated_at = ? WHERE id = ?", [
      now,
      now,
      now,
      job.id,
    ]);
    summary.closed += 1;
  });
  return summary;
}

// Deletes closed jobs after a while, and long-archived ones, unless someone tracks them.
export async function deleteOldJobs(now = new Date()) {
  const gone = await query(
    `SELECT j.id, j.dedupe_key FROM jobs j
      WHERE ((j.closed_at IS NOT NULL AND j.closed_at < ?) OR (j.is_archived = 1 AND j.updated_at < ?))
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id)
      LIMIT 2000`,
    [new Date(now.getTime() - DELETE_CLOSED_AFTER_DAYS * DAY_MS), new Date(now.getTime() - DELETE_ARCHIVED_AFTER_DAYS * DAY_MS)],
  );
  if (gone.length) {
    await query('INSERT INTO closed_jobs (dedupe_key, closed_at) VALUES ? ON DUPLICATE KEY UPDATE closed_at = VALUES(closed_at)', [
      gone.map((j) => [j.dedupe_key, now]),
    ]);
    await query('DELETE FROM jobs WHERE id IN (?)', [gone.map((j) => j.id)]);
  }
  await query('DELETE FROM closed_jobs WHERE closed_at < ?', [new Date(now.getTime() - FORGET_AFTER_DAYS * DAY_MS)]);
  return gone.length;
}

export async function tidyJobs({ now = new Date(), linkChecker } = {}) {
  const closedByDeadline = await closePastDeadlines(now);
  const links = await recheckLinks({ now, ...(linkChecker && { linkChecker }) });
  const archived = await archiveOldJobs(now);
  const deleted = await deleteOldJobs(now);
  const summary = { closedByDeadline, linksChecked: links.checked, closedRemoved: links.closed, relinked: links.relinked, archived, deleted };
  await query('INSERT INTO fetch_log SET ?', [
    { source: 'cleanup', run_at: now, jobs_found: links.checked, jobs_new: 0, requests_used: 0, error: null },
  ]);
  return summary;
}
