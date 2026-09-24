# ArchJobs

One dashboard for architecture and BIM internships and fresher jobs in whichever cities she picks: a filtered job feed with direct apply links, an application tracker, a cold-email firms list and a daily digest email. Spec: [docs/PRD.md](docs/PRD.md).

**Stack:** Node.js (Express 5) + MySQL, React (Vite), node-cron. Jobs come from the [SerpApi Google Jobs API](https://serpapi.com/google-jobs-api) and from LinkedIn job-alert emails forwarded to a mailbox. Groq labels each job (Gemini as backup), inside a daily token budget, with a rule-based fallback.

```
server/
  index.js            start: migrate, listen, optional scheduler
  app.js              Express app, auth, routes, serves web/dist
  sources/            serpapi.js (Google Jobs), linkedinEmail.js (alert parser)
  lib/                ingest (normalize + dedupe + classify + store), rules, groq, gemini, aiBudget, salary, …
  tasks/              fetch-jobs, read-inbox, retry-classify, send-digest, archive
  routes/             REST API
  db/schema.sql       tables (idempotent; applied on every boot)
shared/format.js      display helpers used by server and web
web/src/              React app (Jobs, Tracker, Firms, Settings)
test/                 node:test unit + integration tests, fixtures
```

## Run locally

Needs Node 20.19+ (22 recommended) and Docker for the local MySQL.

```bash
npm install
cp .env.example .env         # set DB_PORT=3307, DB_PASSWORD=archjobs, APP_PASSWORD=…
docker compose up -d         # MySQL 8 on localhost:3307
npm run dev                  # API on :3000, web app on http://localhost:5173
```

Without API keys the app still runs: the feed stays empty until a source is configured, and classification uses the keyword rules.

- `npm test` runs all tests. The integration tests need the `archjobs_test` database:
  `docker exec jobhunt-mysql-1 mysql -uroot -parchjobs-root -e "CREATE DATABASE IF NOT EXISTS archjobs_test; GRANT ALL ON archjobs_test.* TO 'archjobs'@'%';"`
  They are skipped when that database is not reachable.
- `npm run task -- fetch-jobs` (or `read-inbox`, `retry-classify`, `send-digest --force`, `archive`) runs one task from the CLI.
- `npm run build && npm start` serves the built app from the API on :3000.

## Keys and accounts

| What | Where | `.env` |
| --- | --- | --- |
| SerpApi (Google Jobs) | [serpapi.com](https://serpapi.com/manage-api-key), free plan: 250 searches/month | `SERPAPI_KEY` |
| Groq | [console.groq.com/keys](https://console.groq.com/keys), free tier: 1,000 requests/day, 8,000 tokens/minute | `GROQ_API_KEY`, `GROQ_MODEL` |
| Gemini (backup AI) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| Jobs mailbox (IMAP) | Hostinger email, e.g. `jobs@yourdomain` | `IMAP_USER`, `IMAP_PASSWORD` |
| Digest email (SMTP) | Same Hostinger mailbox, or Brevo | `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` |
| Dashboard password | Anything strong | `APP_PASSWORD`, `SESSION_SECRET` |

**Cities.** Settings → *Cities to search* takes any list of cities (or `Remote`); there is no location in `.env`. Every search query is run in every city, one query + city pair per search, and the pairs rotate across runs, so adding a city shares the quota rather than multiplying it. Each city is turned into Google's location once through SerpApi's free locations API (Indian matches first, so "Kochi" is Kerala) and cached. Her cities also rank higher in the match score, fill the daily digest, and are the feed's default *My cities* filter.

**Searching and filtering (Jobs page).** The search bar ("what" + "where") runs that exact search on Google Jobs through SerpApi and shows the results; the same search within 6 hours reuses the stored results for free, typed searches stop at `SERPAPI_MANUAL_DAILY_LIMIT` a day (default 10), and none run once the monthly reserve is reached. Each job stores the years of experience it asks for (`exp_min`/`exp_max`: the AI's reading, else parsed from the text: "0-1 years", "2+ yrs", "freshers can apply"). The *Fresher-friendly* switch filters on it (freshers only, or up to 1, 2, 3 or 5 years); roles that state nothing count only when they are internships or fresher roles.

**SerpApi quota.** Each fetch run (07:00 and 18:00 IST) asks SerpApi's free account endpoint how many searches are left, spreads them over the rest of the month (max 3 per run), and pauses when 10 are left. Usage shows on Settings → Sources.

**AI token budget.** Every call to Groq or Gemini is checked against four limits before it is made (defaults in `.env.example`):

| Limit | Groq | Gemini | When hit |
| --- | --- | --- | --- |
| Tokens per day (IST) | 150,000 | 100,000 | provider off until midnight IST |
| Requests per day | 900 | 200 | provider off until midnight IST |
| Tokens per task run ("session") | 40,000 | 25,000 | provider off for the rest of that run |
| Tokens per minute | 7,000 | 30,000 | waits up to 30 s, else this job goes to the next provider |

Daily totals are stored in the `ai_usage` table, so every task and restart shares one budget; Groq's own "requests left today" header also stops calls 25 short of zero. Descriptions are cut to 2,500 characters and reasoning/thinking tokens are turned off, so a full-length job costs about 1,150 tokens. A job that gets no AI call is labeled by keyword rules and re-sent by the hourly `retry-classify` once budget is back. Today's usage shows on Settings → Sources.

**LinkedIn alerts (no scraping).**
1. On LinkedIn, create job alerts: "BIM intern", "Revit", "architectural intern", "junior architect", location set to each city she wants.
2. Create the mailbox `jobs@yourdomain` in Hostinger hPanel → Emails.
3. In Gmail → Settings → Forwarding, add `jobs@yourdomain` as a forwarding address and confirm it (Gmail emails a code to that mailbox).
4. Gmail → Settings → Filters → Create filter: From `jobalerts-noreply@linkedin.com` → *Forward it to* `jobs@yourdomain`.
5. `read-inbox` runs every 10 minutes, parses each job card and marks the email as read. Emails it could not parse show as errors on Settings → Sources.

## Deploy on Hostinger

The plan needs Node.js hosting (hPanel → Websites → *Node.js* / "Node.js Web App"). If it is not there, upgrade the plan or use a small VPS.

1. **Database:** hPanel → Databases → MySQL Databases → create a database and user. Put the values in `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`. Tables are created automatically on first start.
2. **App:** create the Node.js app from this repo (GitHub), framework preset **Express**, Node 22, entry file `server/index.js`. There is no build step on Hostinger: Vite's native bundler cannot run there, so `web/dist` is built locally and committed. After cloning, run `git config core.hooksPath .githooks` once; the pre-commit hook then rebuilds and adds `web/dist` whenever web code changes.
3. **Environment:** add every variable from `.env.example` in the app's environment settings (never commit `.env`). Set `NODE_ENV=production` and `PUBLIC_URL=https://yourdomain`. In production the API refuses all requests until `APP_PASSWORD` is set.
4. **Scheduling — pick one:**
   - `ENABLE_SCHEDULER=true` runs node-cron inside the app. Simplest, but only works while the app process stays up.
   - Or leave it `false`, set `CRON_SECRET`, and add Hostinger cron jobs (hPanel → Advanced → Cron Jobs):

     ```
     */10 * * * *  curl -fsS "https://yourdomain/api/cron/read-inbox?key=CRON_SECRET"
     30 1,12 * * * curl -fsS "https://yourdomain/api/cron/fetch-jobs?key=CRON_SECRET"      # 07:00, 18:00 IST
     50 * * * *    curl -fsS "https://yourdomain/api/cron/retry-classify?key=CRON_SECRET"
     */15 * * * *  curl -fsS "https://yourdomain/api/cron/send-digest?key=CRON_SECRET"   # sends once/day after digest time
     ```
     Hostinger cron runs in the server's time zone (usually UTC); the times above are UTC.

## How it works

- **Ingest:** every source produces the same job shape → normalized (city, company suffixes, title noise) → deduped on `company + title + city` → new jobs get an apply-link check and a classification → stored. A duplicate from another source merges into the existing row (source badges combined; the firm's own apply link beats LinkedIn, which beats job boards).
- **Classification:** Groq returns strict JSON (`is_relevant`, `role_type`, `is_bim`, `software`, `stipend_or_salary`, `match_score`, `reason`). On error, 10 s timeout, 429, invalid JSON twice or a spent budget, Gemini gets the job; if Gemini also fails, the rule classifier labels it (`classifier = rules`) and the hourly `retry-classify` sends it to the AI again. A 429, outage or spent budget switches that provider off for the rest of the batch at once.
- **Feed rules:** experienced roles are hidden by default; jobs older than 30 days are archived unless saved or tracked; broken apply links are flagged "Link may be expired"; times are shown in IST.
- **Tuning:** Settings → *Tune the filter* lists jobs the classifier dropped (restore with one tap) and jobs you hid with their reason. Add recurring false positives to *Also exclude roles mentioning*.
# JobHunt
