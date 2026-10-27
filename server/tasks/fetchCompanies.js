// Daily: reads the careers feed of every watched company that has one (lib/companies.js) and adds
// their India architecture and design roles to the shared list. Free: company feeds only, no
// SerpApi searches. A firm whose feed fails is noted on the Companies page and tried next day.

import { query } from '../db/pool.js';
import { createClassifier } from '../lib/classify.js';
import { COMPANIES } from '../lib/companies.js';
import { ingestJobs } from '../lib/ingest.js';
import { dedupeKey } from '../lib/normalize.js';
import { classifierContext } from '../lib/settings.js';
import { fetchCompanyJobs, SOURCE } from '../sources/companyFeeds.js';

// `slugs` limits the run to those firms (a "Check now" on the Companies page).
export async function fetchCompanies({ companies = COMPANIES, slugs, fetchImpl = fetch, classifier, now = new Date() } = {}) {
  const watched = companies.filter((c) => c.feed && (!slugs?.length || slugs.includes(c.slug)));
  const ai = classifier || createClassifier({ ...(await classifierContext()) });
  const summary = { source: SOURCE, companies: watched.length, found: 0, new: 0, requests: 0 };
  const errors = [];

  for (const company of watched) {
    try {
      // Roles stored already: their details are not fetched again.
      const known = new Set((await query('SELECT dedupe_key FROM jobs WHERE company = ?', [company.name])).map((r) => r.dedupe_key));
      const { jobs, requests } = await fetchCompanyJobs(company, { fetchImpl, now, isKnown: (job) => known.has(dedupeKey(job)) });
      summary.requests += requests;
      // The feed itself says the posting is open: no link check needed.
      const result = jobs.length ? await ingestJobs(jobs, { classifier: ai, linkChecker: null, now }) : { found: 0, new: 0 };
      summary.found += result.found;
      summary.new += result.new;
      await query('UPDATE companies SET last_checked_at = ?, last_found = ?, last_new = ?, last_error = NULL WHERE slug = ?', [now, jobs.length, result.new, company.slug]);
    } catch (err) {
      errors.push(err.message);
      await query('UPDATE companies SET last_checked_at = ?, last_error = ? WHERE slug = ?', [now, err.message.slice(0, 300), company.slug]);
    }
  }

  if (errors.length) summary.errors = errors;
  await query('INSERT INTO fetch_log SET ?', [
    { source: SOURCE, run_at: now, jobs_found: summary.found, jobs_new: summary.new, requests_used: summary.requests, error: errors.join('\n').slice(0, 2000) || null },
  ]);
  return summary;
}
