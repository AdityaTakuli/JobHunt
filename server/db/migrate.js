import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExperience } from '../lib/rules.js';
import { closePool, query } from './pool.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

// Columns added after the first release. CREATE TABLE IF NOT EXISTS does not touch an existing
// table, so each is added here when missing (works on MySQL 8 and MariaDB alike).
const ADDED_COLUMNS = [
  ['jobs', 'exp_min', 'TINYINT UNSIGNED NULL AFTER match_score'],
  ['jobs', 'exp_max', 'TINYINT UNSIGNED NULL AFTER exp_min'],
  ['jobs', 'exp_parsed', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER exp_max'],
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
