-- ArchJobs schema. Safe to re-run: every statement is idempotent.
-- Works on MySQL 8 and MariaDB 10.6+ (Hostinger). All DATETIMEs are UTC.

CREATE TABLE IF NOT EXISTS jobs (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  dedupe_key CHAR(40) NOT NULL,             -- sha1 of normalized company|title|city
  title VARCHAR(300) NOT NULL,
  company VARCHAR(200) NOT NULL DEFAULT '',
  city VARCHAR(120) NOT NULL DEFAULT '',
  location_text VARCHAR(200) NULL,
  description MEDIUMTEXT NULL,
  apply_url VARCHAR(1000) NOT NULL,
  apply_url_rank TINYINT NOT NULL DEFAULT 1, -- 5 company site, 4 LinkedIn, 3 job board, 2 other site, 1 reposting site
  apply_options JSON NULL,                   -- every apply link seen [{url, publisher, kind, rank}], best first
  apply_kind VARCHAR(12) NULL,               -- kind of apply_url: company / linkedin / board / site / aggregator
  link_status VARCHAR(12) NOT NULL DEFAULT 'unknown', -- ok / broken / unknown
  sources JSON NULL,                         -- [{source, publisher, url}]
  posted_at DATETIME NULL,
  salary_text VARCHAR(200) NULL,
  salary_min INT UNSIGNED NULL,
  salary_max INT UNSIGNED NULL,
  salary_period VARCHAR(12) NULL,            -- month / year / week / day / hour
  salary_is_estimate TINYINT(1) NOT NULL DEFAULT 0,
  is_relevant TINYINT(1) NOT NULL DEFAULT 1,
  role_type VARCHAR(12) NULL,                -- internship / fresher / experienced
  is_bim TINYINT(1) NOT NULL DEFAULT 0,
  software JSON NULL,
  match_score TINYINT UNSIGNED NOT NULL DEFAULT 0,
  exp_min TINYINT UNSIGNED NULL,             -- years of experience asked for (NULL = not stated)
  exp_max TINYINT UNSIGNED NULL,             -- upper end of a range ("0-1 years"), NULL = open-ended
  exp_parsed TINYINT(1) NOT NULL DEFAULT 0,  -- 1 once exp_* were worked out (see migrate.js backfill)
  classifier VARCHAR(8) NULL,                -- freellm / groq / gemini / rules / manual
  classify_reason VARCHAR(300) NULL,
  classify_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  classified_at DATETIME NULL,
  is_hidden TINYINT(1) NOT NULL DEFAULT 0,
  hidden_at DATETIME NULL,
  hide_reason VARCHAR(200) NULL,
  is_archived TINYINT(1) NOT NULL DEFAULT 0,
  deadline_at DATETIME NULL,                 -- "apply by" date found in the posting
  closed_at DATETIME NULL,                   -- set when the posting closed: gone from every list
  closed_reason VARCHAR(12) NULL,            -- deadline / removed
  link_checked_at DATETIME NULL,             -- last time the apply link was checked
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_jobs_dedupe (dedupe_key),
  KEY idx_jobs_feed (is_archived, is_hidden, is_relevant, created_at),
  KEY idx_jobs_classifier (classifier, classify_attempts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS applications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL DEFAULT 1,
  job_id INT UNSIGNED NULL,                  -- NULL for roles found outside the feed
  title VARCHAR(300) NULL,                   -- used when job_id is NULL
  company VARCHAR(200) NULL,
  apply_url VARCHAR(1000) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'saved', -- saved / applied / interview / offer / rejected
  applied_at DATETIME NULL,
  follow_up_at DATETIME NULL,
  contact_name VARCHAR(150) NULL,
  contact_email VARCHAR(200) NULL,
  notes TEXT NULL,
  source VARCHAR(12) NULL,                   -- gmail = created from her email, NULL = added by her
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_app_user_job (user_id, job_id),
  KEY idx_app_job (job_id),
  KEY idx_app_status (status),
  CONSTRAINT fk_app_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS firms (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL DEFAULT 1,
  name VARCHAR(200) NOT NULL,
  city VARCHAR(120) NULL,
  type VARCHAR(40) NULL,                     -- design studio / BIM consultancy / developer / other
  website VARCHAR(500) NULL,
  contact_email VARCHAR(200) NULL,
  last_emailed_at DATETIME NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'not contacted', -- not contacted / emailed / replied / no reply
  notes TEXT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  KEY idx_firms_status (status),
  KEY idx_firms_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS fetch_log (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  source VARCHAR(30) NOT NULL,               -- jsearch / adzuna / linkedin_email / groq / digest
  run_at DATETIME NOT NULL,
  jobs_found INT UNSIGNED NOT NULL DEFAULT 0,
  jobs_new INT UNSIGNED NOT NULL DEFAULT 0,
  requests_used INT UNSIGNED NOT NULL DEFAULT 0,
  error TEXT NULL,
  KEY idx_fetch_source_run (source, run_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Small key/value store for the Settings screen and scheduler bookkeeping.
CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) NOT NULL PRIMARY KEY,
  v TEXT NOT NULL,                           -- JSON-encoded value
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Searches typed on the Jobs page. Repeating one within a few hours reuses these results instead
-- of spending another SerpApi search.
CREATE TABLE IF NOT EXISTS searches (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL DEFAULT 1,
  query VARCHAR(120) NOT NULL,
  location VARCHAR(80) NOT NULL DEFAULT '',
  searched_at DATETIME NOT NULL,
  job_ids JSON NULL,
  found INT UNSIGNED NOT NULL DEFAULT 0,
  cached TINYINT(1) NOT NULL DEFAULT 0,      -- 1 = answered from saved results (no SerpApi search spent)
  hidden TINYINT(1) NOT NULL DEFAULT 0,      -- 1 = removed from her search history
  KEY idx_searches_lookup (query, location, searched_at),
  KEY idx_searches_user (user_id, searched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- AI tokens and requests spent per provider per IST day, for the guardrails in lib/aiBudget.js.
CREATE TABLE IF NOT EXISTS ai_usage (
  provider VARCHAR(12) NOT NULL,             -- freellm / groq / gemini
  day DATE NOT NULL,
  requests INT UNSIGNED NOT NULL DEFAULT 0,
  tokens INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (provider, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- People who can sign in. Row 1 is the owner (the original password login), created by migrate.js.
CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(254) NULL,
  google_sub VARCHAR(64) NULL,               -- Google account id
  name VARCHAR(120) NULL,
  picture VARCHAR(500) NULL,
  is_admin TINYINT(1) NOT NULL DEFAULT 0,
  gmail_token TEXT NULL,                     -- Gmail refresh token, encrypted (lib/secretBox.js)
  gmail_connected_at DATETIME NULL,
  gmail_synced_at DATETIME NULL,
  gmail_apps_synced_at DATETIME NULL,        -- last read of her application emails
  gmail_error VARCHAR(300) NULL,
  created_at DATETIME NOT NULL,
  last_login_at DATETIME NULL,
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_google (google_sub)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Each person's own settings (name, cities, searches, digest). Shared ones stay in `settings`.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id INT UNSIGNED NOT NULL,
  k VARCHAR(64) NOT NULL,
  v TEXT NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, k)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Jobs someone hid from their own feed (others still see them).
CREATE TABLE IF NOT EXISTS job_hides (
  user_id INT UNSIGNED NOT NULL,
  job_id INT UNSIGNED NOT NULL,
  reason VARCHAR(200) NULL,
  hidden_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, job_id),
  KEY idx_hides_job (job_id),
  CONSTRAINT fk_hide_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Postings that closed and were deleted, so a source still listing them cannot bring them back.
CREATE TABLE IF NOT EXISTS closed_jobs (
  dedupe_key CHAR(40) NOT NULL PRIMARY KEY,
  closed_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Application emails read from someone's Gmail (applied / interview / offer / rejected ...), one
-- row per message so none is read twice, and the tracker entry each one moved.
CREATE TABLE IF NOT EXISTS mail_events (
  user_id INT UNSIGNED NOT NULL,
  gmail_id VARCHAR(32) NOT NULL,
  received_at DATETIME NOT NULL,
  from_addr VARCHAR(254) NULL,
  subject VARCHAR(300) NULL,
  kind VARCHAR(12) NOT NULL,                 -- applied / interview / assessment / offer / rejected / other
  company VARCHAR(200) NULL,
  role VARCHAR(300) NULL,
  classifier VARCHAR(8) NOT NULL,            -- freellm / rules
  application_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL,
  PRIMARY KEY (user_id, gmail_id),
  KEY idx_mail_app (application_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
