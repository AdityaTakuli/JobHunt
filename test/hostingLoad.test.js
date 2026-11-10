// Hostinger's Node host (LiteSpeed lsnode) starts the app with require('server/index.js'). Node can
// require() an ES module only when nothing in its import graph uses top-level await, so one such
// dependency imported at the top of any server file takes the whole site down (it happened with
// mupdf, 2026-11-10). This loads every module index.js imports through require(), as the host does.
// A library that needs top-level await must be loaded with import() inside a function instead.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything server/index.js imports (index.js itself starts the server, so it is not required here).
const MODULES = ['server/app.js', 'server/config.js', 'server/db/pool.js', 'server/db/migrate.js', 'server/lib/classify.js', 'server/scheduler.js'];

describe('the server loads the way Hostinger starts it', () => {
  it('every module index.js imports can be loaded with require()', () => {
    const script = MODULES.map((m) => `require(${JSON.stringify(path.join(root, m))});`).join('\n');
    const run = spawnSync(process.execPath, ['--experimental-print-required-tla', '-e', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ENABLE_SCHEDULER: 'false' },
    });
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 0, `require() failed; a module uses top-level await (load it with import() inside a function):\n${output.slice(0, 2000)}`);
  });
});
