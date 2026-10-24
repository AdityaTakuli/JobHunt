import { tidyJobs } from './archive.js';
import { fetchJobs } from './fetchJobs.js';
import { readGmail } from './readGmail.js';
import { retryClassify } from './retryClassify.js';
import { sendDigest } from './sendDigest.js';

export const TASKS = {
  'fetch-jobs': () => fetchJobs(),
  'read-gmail': () => readGmail(),
  'retry-classify': () => retryClassify(),
  // Scheduled calls only send when due; manual runs pass force.
  'send-digest': ({ force, userId } = {}) => sendDigest({ force, userId }),
  // Closes postings past their deadline or taken down, archives old ones, deletes the long gone.
  archive: () => tidyJobs(),
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
