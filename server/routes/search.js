import { Router } from 'express';
import { parseJson, query } from '../db/pool.js';
import { STILL_OPEN } from '../lib/deadline.js';
import { runTask } from '../tasks/index.js';
import { liveSearch } from '../tasks/liveSearch.js';

export const searchRouter = Router();

// POST /api/search { q, location, exact } -> { ids, found, new, cached, searched, place, adjusted }
searchRouter.post('/', async (req, res) => {
  const result = await liveSearch({ q: req.body?.q, location: req.body?.location, exact: req.body?.exact === true, userId: req.user.id });
  // Upgrade the keyword labels with the AI in the background (it skips itself if already running).
  if (result.new) runTask('retry-classify').catch(() => {});
  res.json(result);
});

const HISTORY_SIZE = 12;

// Her searches, newest first, one entry per search (query + place) with every result it ever
// found that is still open: not closed, not archived, not hidden by her. Searches with nothing
// open left are dropped.
searchRouter.get('/history', async (req, res) => {
  const uid = req.user.id;
  const rows = await query(
    'SELECT query, location, searched_at, job_ids FROM searches WHERE user_id = ? AND hidden = 0 ORDER BY searched_at DESC, id DESC LIMIT 300',
    [uid],
  );
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.query.toLowerCase()}|${r.location.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { query: r.query, location: r.location, searchedAt: r.searched_at, firstAt: r.searched_at, runs: 0, ids: [] });
    const g = groups.get(key);
    g.runs += 1;
    g.firstAt = r.searched_at;
    for (const id of parseJson(r.job_ids, [])) if (!g.ids.includes(id)) g.ids.push(id);
  }
  const all = [...new Set([...groups.values()].flatMap((g) => g.ids))];
  const open = new Set(
    all.length
      ? (
          await query(
            `SELECT j.id FROM jobs j
              WHERE j.id IN (?) AND ${STILL_OPEN} AND j.is_archived = 0
                AND NOT EXISTS (SELECT 1 FROM job_hides h WHERE h.job_id = j.id AND h.user_id = ?)`,
            [all, uid],
          )
        ).map((r) => r.id)
      : [],
  );
  const searches = [...groups.values()]
    .map((g) => ({ ...g, ids: g.ids.filter((id) => open.has(id)).slice(0, 200) }))
    .filter((g) => g.ids.length)
    .slice(0, HISTORY_SIZE)
    .map((g) => ({ ...g, open: g.ids.length }));
  res.json({ searches });
});

// Removes a search from her history (the jobs stay; the daily count is not refunded).
searchRouter.delete('/history', async (req, res) => {
  const q = String(req.body?.query ?? '');
  const location = String(req.body?.location ?? '');
  await query('UPDATE searches SET hidden = 1 WHERE user_id = ? AND query = ? AND location = ?', [req.user.id, q, location]);
  res.json({ ok: true });
});
