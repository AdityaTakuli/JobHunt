import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, query } from './pool.js';

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'schema.sql');

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
