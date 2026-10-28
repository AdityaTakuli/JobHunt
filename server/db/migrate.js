import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { parseDeadline } from '../lib/deadline.js';
import { rankApplyOptions } from '../lib/normalize.js';
import { COMPANIES } from '../lib/companies.js';
import { parseExperience } from '../lib/rules.js';
import { isDesignRole } from '../sources/companyFeeds.js';
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
  ['jobs', 'deadline_at', 'DATETIME NULL AFTER is_archived'],
  ['jobs', 'closed_at', 'DATETIME NULL AFTER deadline_at'],
  ['jobs', 'closed_reason', 'VARCHAR(12) NULL AFTER closed_at'],
  ['jobs', 'link_checked_at', 'DATETIME NULL AFTER closed_reason'],
  ['applications', 'user_id', 'INT UNSIGNED NOT NULL DEFAULT 1 AFTER id'],
  ['firms', 'user_id', 'INT UNSIGNED NOT NULL DEFAULT 1 AFTER id'],
  ['searches', 'user_id', 'INT UNSIGNED NOT NULL DEFAULT 1 AFTER id'],
  ['searches', 'cached', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER found'],
  ['searches', 'hidden', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER cached'],
  ['applications', 'source', 'VARCHAR(12) NULL AFTER notes'],
  ['users', 'gmail_apps_synced_at', 'DATETIME NULL AFTER gmail_synced_at'],
  ['users', 'gmail_jobs_synced_at', 'DATETIME NULL AFTER gmail_apps_synced_at'],
  ['mail_events', 'jobs_found', 'SMALLINT UNSIGNED NULL AFTER application_id'],
];

async function hasIndex(table, name) {
  const [row] = await query(
    'SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [table, name],
  );
  return Number(row.n) > 0;
}

// Indexes for separate accounts. A tracker entry is unique per person and job (it was per job).
// The job_id index goes in before the old unique key is dropped: the foreign key needs one.
async function addMissingIndexes() {
  if (!(await hasIndex('applications', 'idx_app_job'))) await query('ALTER TABLE applications ADD KEY idx_app_job (job_id)');
  if (!(await hasIndex('applications', 'uq_app_user_job'))) await query('ALTER TABLE applications ADD UNIQUE KEY uq_app_user_job (user_id, job_id)');
  if (await hasIndex('applications', 'uq_app_job')) await query('ALTER TABLE applications DROP INDEX uq_app_job');
  if (!(await hasIndex('firms', 'idx_firms_user'))) await query('ALTER TABLE firms ADD KEY idx_firms_user (user_id)');
  if (!(await hasIndex('searches', 'idx_searches_user'))) await query('ALTER TABLE searches ADD KEY idx_searches_user (user_id, searched_at)');
}

// Settings that became per person when accounts arrived. The owner keeps the values set before.
const PER_PERSON_KEYS = ['search_queries', 'cities', 'digest_enabled', 'digest_time', 'notification_email', 'display_name', 'last_digest_at', 'last_digest_on'];

// The owner account (user 1) holds everything saved before accounts existed.
async function ensureOwner() {
  const now = new Date();
  const [owner] = await query('SELECT id, email FROM users WHERE id = 1');
  if (!owner) {
    const [name] = await query("SELECT v FROM settings WHERE k = 'display_name'");
    await query('INSERT INTO users SET ?', [
      { id: 1, email: null, name: (name && parseJson(name.v, null)) || 'Kothu', is_admin: 1, created_at: now },
    ]);
    // Her settings so far become the owner's own. The welcome kept greeting her as Kothu by default.
    const rows = await query('SELECT k, v FROM settings WHERE k IN (?)', [PER_PERSON_KEYS]);
    if (!rows.some((r) => r.k === 'display_name')) rows.push({ k: 'display_name', v: JSON.stringify('Kothu') });
    if (rows.length) {
      await query('INSERT IGNORE INTO user_settings (user_id, k, v, updated_at) VALUES ?', [rows.map((r) => [1, r.k, r.v, now])]);
    }
    // So were the jobs she hid.
    await query(
      `INSERT IGNORE INTO job_hides (user_id, job_id, reason, hidden_at)
       SELECT 1, id, hide_reason, COALESCE(hidden_at, updated_at) FROM jobs WHERE is_hidden = 1`,
    );
  }
  const email = config.auth.ownerEmail;
  if (email && (!owner || owner.email !== email)) {
    const [taken] = await query('SELECT id FROM users WHERE email = ? AND id <> 1', [email]);
    if (taken) console.warn(`OWNER_EMAIL ${email} already belongs to another account; the owner account keeps its email.`);
    else await query('UPDATE users SET email = ?, is_admin = 1 WHERE id = 1', [email]);
  }
}

// "Apply by" dates for jobs stored before deadlines were read.
async function backfillDeadlines() {
  const [done] = await query("SELECT v FROM settings WHERE k = 'deadlines_backfilled'");
  if (done) return;
  const rows = await query('SELECT id, description, posted_at, created_at FROM jobs WHERE closed_at IS NULL AND description IS NOT NULL');
  for (const r of rows) {
    const deadline = parseDeadline(r.description, r.posted_at || r.created_at);
    if (deadline) await query('UPDATE jobs SET deadline_at = ? WHERE id = ?', [deadline, r.id]);
  }
  await query("INSERT INTO settings (k, v, updated_at) VALUES ('deadlines_backfilled', 'true', ?)", [new Date()]);
}

// Once: the AI used to answer "not relevant" for architecture jobs that were senior or in another
// city. Those go back to the hourly retry-classify, which labels them with the fixed prompt.
async function requeueMislabeled() {
  const [done] = await query("SELECT v FROM settings WHERE k = 'relevance_relabel_v1'");
  if (done) return;
  const rows = await query(
    "SELECT id, title FROM jobs WHERE is_relevant = 0 AND classifier IN ('freellm', 'groq', 'gemini') AND closed_at IS NULL AND is_archived = 0",
  );
  const ids = rows.filter((r) => isDesignRole(r.title)).map((r) => r.id);
  if (ids.length) await query("UPDATE jobs SET classifier = 'rules', classify_attempts = 0 WHERE id IN (?)", [ids]);
  await query("INSERT INTO settings (k, v, updated_at) VALUES ('relevance_relabel_v1', 'true', ?)", [new Date()]);
}

// The watched companies follow lib/companies.js: added, updated, and removed when taken out.
async function syncCompanies(now = new Date()) {
  for (const [i, c] of COMPANIES.entries()) {
    const row = {
      name: c.name,
      kind: c.kind || null,
      cities: c.cities.join(', '),
      careers_url: c.careersUrl,
      feed_type: c.feed?.type || null,
      note: c.note || null,
      match_names: JSON.stringify(c.match || [c.name]),
      sort_order: i,
      updated_at: now,
    };
    await query('INSERT INTO companies SET ? ON DUPLICATE KEY UPDATE ?', [{ slug: c.slug, ...row }, row]);
  }
  await query('DELETE FROM companies WHERE slug NOT IN (?)', [COMPANIES.map((c) => c.slug)]);
}

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

// schema.sql split into statements. Splits on ";", so comments must not contain one.
export function schemaStatements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrate() {
  const statements = schemaStatements(await fs.readFile(schemaPath, 'utf8'));
  for (const statement of statements) {
    await query(statement);
  }
  await addMissingColumns();
  await addMissingIndexes();
  await ensureOwner();
  await backfillExperience();
  await backfillApplyOptions();
  await backfillDeadlines();
  await syncCompanies();
  await requeueMislabeled();
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
