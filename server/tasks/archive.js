import { query } from '../db/pool.js';
import { DAY_MS } from '../lib/time.js';

// Jobs older than 30 days are archived unless they are saved or tracked.
export async function archiveOldJobs(now = new Date()) {
  const cutoff = new Date(now.getTime() - 30 * DAY_MS);
  const res = await query(
    `UPDATE jobs j
       LEFT JOIN applications a ON a.job_id = j.id
        SET j.is_archived = 1, j.updated_at = ?
      WHERE j.is_archived = 0
        AND a.id IS NULL
        AND COALESCE(j.posted_at, j.created_at) < ?`,
    [now, cutoff],
  );
  return res.affectedRows;
}
