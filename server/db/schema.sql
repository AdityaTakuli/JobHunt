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
  classifier VARCHAR(8) NULL,                -- groq / gemini / rules / manual
  classify_reason VARCHAR(300) NULL,
  classify_attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  classified_at DATETIME NULL,
  is_hidden TINYINT(1) NOT NULL DEFAULT 0,
  hidden_at DATETIME NULL,
  hide_reason VARCHAR(200) NULL,
  is_archived TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_jobs_dedupe (dedupe_key),
  KEY idx_jobs_feed (is_archived, is_hidden, is_relevant, created_at),
  KEY idx_jobs_classifier (classifier, classify_attempts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS applications (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
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
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uq_app_job (job_id),
  KEY idx_app_status (status),
  CONSTRAINT fk_app_job FOREIGN KEY (job_id) REFERENCES jobs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS firms (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
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
  KEY idx_firms_status (status)
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
  query VARCHAR(120) NOT NULL,
  location VARCHAR(80) NOT NULL DEFAULT '',
  searched_at DATETIME NOT NULL,
  job_ids JSON NULL,
  found INT UNSIGNED NOT NULL DEFAULT 0,
  KEY idx_searches_lookup (query, location, searched_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- AI tokens and requests spent per provider per IST day, for the guardrails in lib/aiBudget.js.
CREATE TABLE IF NOT EXISTS ai_usage (
  provider VARCHAR(12) NOT NULL,             -- groq / gemini
  day DATE NOT NULL,
  requests INT UNSIGNED NOT NULL DEFAULT 0,
  tokens INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (provider, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
