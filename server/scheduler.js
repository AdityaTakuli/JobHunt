// In-process schedule (ENABLE_SCHEDULER=true). The same tasks can instead be triggered by
// Hostinger cron hitting /api/cron/<task>; use one or the other, not both.
import cron from 'node-cron';
import { TIMEZONE } from './config.js';
import { runTask } from './tasks/index.js';

const SCHEDULE = [
  ['*/10 * * * *', 'read-inbox'],
  ['0 7,18 * * *', 'fetch-jobs'],
  ['20 * * * *', 'retry-classify'],
  ['*/5 * * * *', 'send-digest'], // sends once per day, after the digest time in Settings
  ['30 3 * * *', 'archive'],
];

export function startScheduler(log = console) {
  return SCHEDULE.map(([expr, name]) =>
    cron.schedule(
      expr,
      async () => {
        try {
          const result = await runTask(name);
          // Skips (not due, not configured) and empty inbox checks are routine; stay quiet.
          const routine = result.skipped || (name === 'read-inbox' && !result.messages && !result.error);
          if (!routine) log.info(`[cron] ${name}`, JSON.stringify(result));
        } catch (err) {
          log.error(`[cron] ${name} failed:`, err.message);
        }
      },
      { timezone: TIMEZONE, name, noOverlap: true },
    ),
  );
}
