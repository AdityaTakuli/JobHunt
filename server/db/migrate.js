import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rankApplyOptions } from '../lib/normalize.js';
import { parseExperience } from '../lib/rules.js';
import { closePool, parseJson, query } from './pool.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

// Columns added after the first release. CREATE TABLE IF NOT EXISTS does not touch an existing
// table, so each is added here when missing (works on MySQL 8 and MariaDB alike).
const ADDED_COLUMNS = [
  ['jobs', 'exp_min', 'TINYINT UNSIGNED NULL AFTER match_score'],
  ['jobs', 'exp_max', 'TINYINT UNSIGNED NULL AFTER exp_min'],
  ['jobs', 'exp_parsed', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER exp_max'],
  ['jobs', 'apply_options', 'JSON NULL AFTER apply_url_rank'],
  ['jobs', 'apply_kind', 'VARCHAR(12) NULL AFTER apply_options'],
];

async function addMissingColumns() {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const [row] = await query(
      'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [table, column],
    );
    if (!Number(row.n)) await query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  }
}

// Jobs stored before the experience filter existed get their years worked out once.
// Jobs stored before apply links were ranked by kind get their links sorted once, and their
// apply_url_rank moved to the 1-5 scale.
async function backfillApplyOptions() {
  for (;;) {
    const rows = await query('SELECT id, company, apply_url, sources FROM jobs WHERE apply_kind IS NULL LIMIT 500');
    if (!rows.length) return;
    for (const r of rows) {
      const sources = parseJson(r.sources, []);
      const options = rankApplyOptions([...sources.map((s) => ({ url: s.url, publisher: s.publisher })), { url: r.apply_url }], r.company);
      const best = options[0] || { url: r.apply_url, rank: 2, kind: 'site' };
      await query('UPDATE jobs SET apply_options = ?, apply_kind = ?, apply_url = ?, apply_url_rank = ? WHERE id = ?', [
        JSON.stringify(options),
        best.kind,
        String(best.url).slice(0, 1000),
        best.rank,
        r.id,
      ]);
    }
  }
}

async function backfillExperience() {
  for (;;) {
    const rows = await query('SELECT id, title, description, role_type FROM jobs WHERE exp_parsed = 0 LIMIT 500');
    if (!rows.length) return;
    for (const r of rows) {
      const parsed = parseExperience(r.title, r.description);
      let min = parsed?.min ?? null;
      if (min == null && (r.role_type === 'internship' || r.role_type === 'fresher')) min = 0;
      await query('UPDATE jobs SET exp_min = ?, exp_max = ?, exp_parsed = 1 WHERE id = ?', [min, parsed && parsed.min === min ? parsed.max : null, r.id]);
    }
  }
}

export async function migrate() {
  const sql = await fs.readFile(schemaPath, 'utf8');
  const statements = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await query(statement);
  }
  await addMissingColumns();
  await backfillExperience();
  await backfillApplyOptions();
  return statements.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then((n) => console.log(`Schema applied (${n} statements).`))
    .catch((err) => {
      console.error('Migration failed:', err.message);
      process.exitCode = 1;
    })
    .finally(closePool);
}
