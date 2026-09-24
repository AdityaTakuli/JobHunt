import { archiveOldJobs } from './archive.js';
import { fetchJobs } from './fetchJobs.js';
import { readInbox } from './readInbox.js';
import { retryClassify } from './retryClassify.js';
import { sendDigest } from './sendDigest.js';

export const TASKS = {
  'fetch-jobs': () => fetchJobs(),
  'read-inbox': () => readInbox(),
  'retry-classify': () => retryClassify(),
  // Scheduled calls only send when due; manual runs pass force.
  'send-digest': ({ force } = {}) => sendDigest({ force }),
  archive: async () => ({ archived: await archiveOldJobs() }),
};

const running = new Set();

// Runs a task by name, skipping it if the same task is still running (cron overlap).
export async function runTask(name, options) {
  const task = TASKS[name];
  if (!task) throw Object.assign(new Error(`Unknown task "${name}"`), { status: 404 });
  if (running.has(name)) return { task: name, skipped: 'already running' };
  running.add(name);
  const started = Date.now();
  try {
    const result = await task(options);
    return { task: name, ms: Date.now() - started, ...result };
  } finally {
    running.delete(name);
  }
}
