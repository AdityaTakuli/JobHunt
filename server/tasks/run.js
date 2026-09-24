// CLI: npm run task -- fetch-jobs | read-inbox | retry-classify | send-digest [--force] | archive
import { closePool } from '../db/pool.js';
import { runTask, TASKS } from './index.js';

const [name, ...flags] = process.argv.slice(2);

if (!name || !TASKS[name]) {
  console.error(`Usage: npm run task -- <${Object.keys(TASKS).join(' | ')}> [--force]`);
  process.exit(1);
}

try {
  const result = await runTask(name, { force: flags.includes('--force') });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(`${name} failed:`, err.message);
  process.exitCode = 1;
} finally {
  await closePool();
}
