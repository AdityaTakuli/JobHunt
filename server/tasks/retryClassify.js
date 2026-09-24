// Hourly: jobs labeled by the rule fallback are re-sent to the AI (Groq, then Gemini). Stops at
// the first sign of an outage, rate limit or spent budget and leaves the rest for the next run.

import { config } from '../config.js';
import { query } from '../db/pool.js';
import { createClassifier, labelsToColumns } from '../lib/classify.js';
import { getSettings } from '../lib/settings.js';

const BATCH = 25;
const MAX_ATTEMPTS = 5;

const describeDown = (reasons) =>
  Object.entries(reasons)
    .map(([name, reason]) => `${name}: ${reason}`)
    .join(', ');

export async function retryClassify({ fetchImpl = fetch } = {}) {
  if (!config.groq.apiKey && !config.gemini.apiKey) {
    return { source: 'groq', skipped: 'No AI key set (GROQ_API_KEY or GEMINI_API_KEY)' };
  }

  const jobs = await query(
    `SELECT id, title, company, city, location_text, description, salary_text
       FROM jobs
      WHERE classifier = 'rules' AND classify_attempts < ? AND is_archived = 0 AND is_hidden = 0
      ORDER BY created_at DESC
      LIMIT ?`,
    [MAX_ATTEMPTS, BATCH],
  );
  const summary = { source: 'groq', pending: jobs.length, upgraded: 0 };
  if (!jobs.length) return summary;

  const settings = await getSettings();
  const classifier = createClassifier({ extraExclude: settings.extra_exclude_keywords, cities: settings.cities, fetchImpl, useRules: false });

  for (const job of jobs) {
    if (!classifier.aiAvailable) break;
    const out = await classifier.classify(job);
    if (out) {
      await query('UPDATE jobs SET ?, classified_at = ?, updated_at = ? WHERE id = ?', [
        labelsToColumns(out.labels, out.classifier, job),
        new Date(),
        new Date(),
        job.id,
      ]);
      summary.upgraded += 1;
    } else if (classifier.lastOutcome === 'invalid_json') {
      // The AI answered but not in the expected shape (twice); give up after MAX_ATTEMPTS. Jobs
      // skipped for budget are not counted: they are simply tried again next hour.
      await query('UPDATE jobs SET classify_attempts = classify_attempts + 1 WHERE id = ?', [job.id]);
    }
  }

  summary.failures = classifier.stats.failures;
  summary.tokensUsed = classifier.stats.tokens;
  const down = Object.fromEntries(Object.entries(classifier.downReasons).filter(([, r]) => r && r !== 'not_configured'));
  if (!classifier.aiAvailable) summary.stoppedBecause = describeDown(down);
  await query('INSERT INTO fetch_log SET ?', [
    {
      source: 'groq',
      run_at: new Date(),
      jobs_found: jobs.length,
      jobs_new: summary.upgraded,
      requests_used: classifier.stats.requests,
      error: summary.stoppedBecause ? `AI unavailable (${summary.stoppedBecause})` : null,
    },
  ]);
  return summary;
}
