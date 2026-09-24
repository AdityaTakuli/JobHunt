// Daily digest email (08:00 IST by default): new matching roles since the last digest,
// follow-ups due, and cold-email suggestions when there is nothing new.
// The scheduler calls this every few minutes; it only sends once the digest time has passed
// and not yet today, so it works the same with node-cron or Hostinger cron.

import { formatSalary, ROLE_LABELS } from '../../shared/format.js';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { escapeHtml, mailConfigured, sendMail } from '../lib/mailer.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { DAY_MS, formatIst, istDateString, istTime } from '../lib/time.js';

export function digestDue(settings, now = new Date()) {
  if (!settings.digest_enabled) return false;
  if (settings.last_digest_on === istDateString(now)) return false;
  return istTime(now) >= settings.digest_time;
}

async function digestData(settings, now) {
  const since = settings.last_digest_at ? new Date(settings.last_digest_at) : new Date(now.getTime() - DAY_MS);
  const cities = settings.cities || [];
  const cityFilter = cities.length ? `AND (j.city IN (?) OR j.city IN ('', 'Remote'))` : '';
  const jobs = await query(
    `SELECT j.id, j.title, j.company, j.city, j.apply_url, j.role_type, j.is_bim, j.match_score,
            j.salary_text, j.salary_min, j.salary_max, j.salary_period
       FROM jobs j
      WHERE j.created_at > ? AND j.is_relevant = 1 AND j.is_hidden = 0 AND j.is_archived = 0
        AND (j.role_type IS NULL OR j.role_type <> 'experienced')
        ${cityFilter}
      ORDER BY j.match_score DESC, j.created_at DESC
      LIMIT 30`,
    cities.length ? [since, cities] : [since],
  );
  const followUps = await query(
    `SELECT a.id, a.follow_up_at, a.status, COALESCE(j.title, a.title) AS title, COALESCE(j.company, a.company) AS company
       FROM applications a LEFT JOIN jobs j ON j.id = a.job_id
      WHERE a.status IN ('applied', 'interview') AND a.follow_up_at IS NOT NULL AND a.follow_up_at <= ?
      ORDER BY a.follow_up_at`,
    [now],
  );
  const firms = jobs.length
    ? []
    : await query(
        `SELECT name, city, website, contact_email FROM firms WHERE status = 'not contacted' ORDER BY created_at LIMIT 5`,
      );
  return { jobs, followUps, firms };
}

export function renderDigest({ jobs, followUps, firms }, now = new Date()) {
  const dashboard = config.publicUrl;
  const subject = [
    'ArchJobs',
    jobs.length ? `${jobs.length} new role${jobs.length === 1 ? '' : 's'}` : 'No new roles today',
    followUps.length ? `${followUps.length} follow-up${followUps.length === 1 ? '' : 's'} due` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const tag = (label, bg) =>
    `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${bg};font-size:12px;margin-right:4px">${escapeHtml(label)}</span>`;

  const jobItems = jobs
    .map((j) => {
      const meta = [j.company, j.city, formatSalary(j)].filter(Boolean).map(escapeHtml).join(' · ');
      const tags = [j.is_bim ? tag('BIM', '#e0ecff') : '', j.role_type ? tag(ROLE_LABELS[j.role_type], '#eef0f2') : ''].join('');
      return `<tr><td style="padding:12px 0;border-bottom:1px solid #eceef0">
        <a href="${escapeHtml(j.apply_url)}" style="color:#1d4ed8;font-weight:600;font-size:15px;text-decoration:none">${escapeHtml(j.title)}</a>
        <div style="color:#4b5563;font-size:13px;margin:4px 0">${meta}</div>${tags}</td></tr>`;
    })
    .join('');

  const followItems = followUps
    .map((f) => `<li>${escapeHtml(f.title)}${f.company ? ` — ${escapeHtml(f.company)}` : ''} (due ${escapeHtml(formatIst(f.follow_up_at, { dateStyle: 'medium' }))})</li>`)
    .join('');

  const firmItems = firms
    .map((f) => {
      const link = f.website ? ` · <a href="${escapeHtml(f.website)}">website</a>` : '';
      return `<li>${escapeHtml(f.name)}${f.city ? `, ${escapeHtml(f.city)}` : ''}${f.contact_email ? ` · ${escapeHtml(f.contact_email)}` : ''}${link}</li>`;
    })
    .join('');

  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px">
    <h1 style="font-size:18px;margin:0 0 4px">Good morning ☀️</h1>
    <p style="margin:0 0 16px;color:#4b5563;font-size:14px">${escapeHtml(formatIst(now, { dateStyle: 'full' }))}</p>
    <div style="background:#fff;border-radius:12px;padding:8px 16px">
      ${
        jobs.length
          ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0">${jobItems}</table>`
          : `<p style="font-size:14px">No new BIM or architecture roles since yesterday.${firms.length ? ' Here are some firms to cold-email:' : ''}</p>${firms.length ? `<ul style="font-size:14px;padding-left:18px">${firmItems}</ul>` : ''}`
      }
    </div>
    ${followUps.length ? `<h2 style="font-size:15px;margin:20px 0 8px">Follow-ups due</h2><ul style="font-size:14px;padding-left:18px;margin:0">${followItems}</ul>` : ''}
    <p style="margin:24px 0 0"><a href="${escapeHtml(dashboard)}" style="background:#1d4ed8;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-size:14px">Open ArchJobs</a></p>
  </div></body></html>`;

  const text = [
    subject,
    '',
    ...jobs.map((j) => `• ${j.title} — ${[j.company, j.city, formatSalary(j)].filter(Boolean).join(' · ')}\n  ${j.apply_url}`),
    ...(jobs.length ? [] : ['No new roles since yesterday.', ...firms.map((f) => `• Cold-email: ${f.name}${f.contact_email ? ` <${f.contact_email}>` : ''}`)]),
    ...(followUps.length ? ['', 'Follow-ups due:', ...followUps.map((f) => `• ${f.title}${f.company ? ` — ${f.company}` : ''}`)] : []),
    '',
    dashboard,
  ].join('\n');

  return { subject, html, text };
}

export async function sendDigest({ force = false, now = new Date() } = {}) {
  const settings = await getSettings();
  if (!force && !digestDue(settings, now)) return { source: 'digest', skipped: 'not due' };
  if (!settings.notification_email) return { source: 'digest', skipped: 'No notification email in Settings' };
  if (!mailConfigured()) return { source: 'digest', skipped: 'SMTP is not configured' };

  const data = await digestData(settings, now);
  const email = renderDigest(data, now);
  let error = null;
  try {
    await sendMail({ to: settings.notification_email, ...email });
  } catch (err) {
    error = err.message;
  }
  if (!error) await saveSettings({ last_digest_at: now.toISOString(), last_digest_on: istDateString(now) });
  await query('INSERT INTO fetch_log SET ?', [
    { source: 'digest', run_at: now, jobs_found: data.jobs.length, jobs_new: 0, requests_used: error ? 0 : 1, error },
  ]);
  if (error) throw new Error(`Digest email failed: ${error}`);
  return { source: 'digest', sent: true, subject: email.subject, jobs: data.jobs.length, followUps: data.followUps.length };
}
