import { Router } from 'express';
import { runTask } from '../tasks/index.js';
import { liveSearch } from '../tasks/liveSearch.js';

export const searchRouter = Router();

// POST /api/search { q, location, exact } -> { ids, found, new, cached, searched, place, adjusted }
searchRouter.post('/', async (req, res) => {
  const result = await liveSearch({ q: req.body?.q, location: req.body?.location, exact: req.body?.exact === true });
  // Upgrade the keyword labels with the AI in the background (it skips itself if already running).
  if (result.new) runTask('retry-classify').catch(() => {});
  res.json(result);
});
