// Reads a company's own careers feed into jobs for ingestJobs(). Two public, free feeds:
//   - Workday:  POST https://{host}/wday/cxs/{tenant}/{site}/jobs (search), GET .../job/... (detail)
//   - SmartRecruiters: GET https://api.smartrecruiters.com/v1/companies/{id}/postings[/{postingId}]
// Only architecture/design roles in India are kept. Details (description, apply link, date) are
// fetched only for roles not stored yet, so a daily check of a firm takes a handful of requests.
// No SerpApi: these never touch the Google Jobs quota.

import { decodeEntities, findCity, normalizeCity } from '../lib/normalize.js';
import { DAY_MS } from '../lib/time.js';

export const SOURCE = 'company_careers';

const DESIGN = /\b(architect\w*|bim|revit|interiors?|landscape|urban (design\w*|plann\w*)|master ?plann\w*|draughts\w*|drafts(man|person))\b/i;
const NOT_DESIGN =
  /\b(solutions?|data|cloud|enterprise|software|security|network|salesforce|sap|aws|azure|gcp|java|devops|platform|integration|application|systems?|technical|technology|it|infrastructure|ai|ml|mep|mech\w*|electrical|plumbing|phe|hvac|structur\w*|civil|geotech\w*|roads?|highways?|bridges?|rail\w*|water|w&wwtr|wastewater|elv|ict|fire)\b/i;

// Architecture, BIM and design roles, not IT "architects" or other engineering fields.
export const isDesignRole = (title) => DESIGN.test(title || '') && !NOT_DESIGN.test(title || '');

export function inIndia(place) {
  const text = String(place || '');
  if (/\bindia\b/i.test(text)) return true;
  const found = findCity(text);
  return Boolean(found && found.city !== 'Remote');
}

export function htmlToText(html) {
  const text = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<br\s*\/?>|<\/(p|div|li|ul|ol|h[1-6]|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[\s ]+/g, ' ').trim())
    .filter((l) => l && l !== '•')
    .join('\n');
}

// "Posted Today", "Posted 2 Days Ago", "Posted 30+ Days Ago" -> date.
function postedOn(text, now) {
  const m = String(text || '').match(/(\d+)\+?\s+days?/i);
  if (/today/i.test(text)) return now;
  if (/yesterday/i.test(text)) return new Date(now.getTime() - DAY_MS);
  return m ? new Date(now.getTime() - Number(m[1]) * DAY_MS) : null;
}

const dateOnly = (value) => {
  const d = value ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

function client(company, fetchImpl, timeoutMs) {
  let requests = 0;
  async function call(url, init) {
    requests += 1;
    let res;
    try {
      res = await fetchImpl(url, { ...init, headers: { Accept: 'application/json', ...init?.headers }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new Error(`${company.name} careers: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`);
    }
    if (!res.ok) throw new Error(`${company.name} careers answered ${res.status}`);
    return res.json();
  }
  return {
    call,
    get requests() {
      return requests;
    },
  };
}

const job = (company, fields) => ({
  source: SOURCE,
  company: company.name,
  applyKind: 'company',
  publisher: `${company.name} careers`,
  salary: null,
  ...fields,
});

// Search words for Workday, each with "India" so the firm's Indian roles come first.
export const WORKDAY_TERMS = ['architect', 'architecture', 'BIM', 'interior design', 'landscape', 'urban design'];

async function readWorkday(company, http, { terms, isKnown, maxDetails, now }) {
  const { host, tenant, site } = company.feed;
  const base = `https://${host}/wday/cxs/${tenant}/${site}`;
  const seen = new Map();
  for (const term of terms) {
    for (let offset = 0; offset < 60; offset += 20) {
      const data = await http.call(`${base}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: `${term} India` }),
      });
      const page = data.jobPostings || [];
      for (const p of page) if (p.externalPath && !seen.has(p.externalPath)) seen.set(p.externalPath, p);
      if (page.length < 20 || offset + 20 >= (data.total ?? 0)) break;
    }
  }

  const jobs = [];
  let details = 0;
  for (const p of seen.values()) {
    if (!isDesignRole(p.title)) continue;
    const several = /^\d+\s+locations?$/i.test(p.locationsText || '');
    if (!several && !inIndia(p.locationsText)) continue;
    const listed = job(company, {
      title: p.title,
      locationText: several ? '' : p.locationsText,
      city: several ? '' : normalizeCity(p.locationsText),
      applyUrl: `https://${host}/${site}${p.externalPath}`,
      postedAt: postedOn(p.postedOn, now),
      description: '',
    });
    if (!several && isKnown(listed)) {
      jobs.push(listed);
      continue;
    }
    if (details >= maxDetails) continue;
    details += 1;
    // One posting that won't load (taken down a moment ago) must not cost the rest.
    const info = (await http.call(`${base}${p.externalPath}`).catch(() => null))?.jobPostingInfo;
    if (!info) continue;
    const where = [info.location, ...(info.additionalLocations || [])].filter(Boolean);
    if (info.country?.descriptor !== 'India' && !where.some(inIndia)) continue;
    const place = where.find(inIndia) || info.location || p.locationsText;
    jobs.push({
      ...listed,
      title: info.title || p.title,
      locationText: place,
      city: normalizeCity(place),
      applyUrl: info.externalUrl || listed.applyUrl,
      postedAt: dateOnly(info.startDate) || listed.postedAt,
      description: htmlToText(info.jobDescription),
    });
  }
  return jobs;
}

async function readSmartRecruiters(company, http, { isKnown, maxDetails }) {
  const base = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company.feed.id)}/postings`;
  const postings = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const data = await http.call(`${base}?country=in&limit=100&offset=${offset}`);
    postings.push(...(data.content || []));
    if (!data.content?.length || offset + 100 >= (data.totalFound ?? 0)) break;
  }

  const jobs = [];
  let details = 0;
  for (const p of postings) {
    if (!isDesignRole(p.name) || (p.location?.country && p.location.country !== 'in')) continue;
    // SmartRecruiters leaves empty parts in: "Madhapur, , India".
    const place = (p.location?.fullLocation || [p.location?.city, 'India'].filter(Boolean).join(', ')).replace(/(,\s*)+,/g, ',');
    const listed = job(company, {
      title: p.name,
      locationText: place,
      city: normalizeCity(p.location?.city || ''),
      applyUrl: `https://jobs.smartrecruiters.com/${company.feed.id}/${p.id}`,
      postedAt: dateOnly(p.releasedDate),
      description: '',
    });
    if (isKnown(listed) || details >= maxDetails) {
      jobs.push(listed);
      continue;
    }
    details += 1;
    const detail = await http.call(`${base}/${encodeURIComponent(p.id)}`).catch(() => null);
    if (!detail) {
      jobs.push(listed);
      continue;
    }
    const sections = detail.jobAd?.sections || {};
    jobs.push({
      ...listed,
      applyUrl: detail.postingUrl || listed.applyUrl,
      description: ['jobDescription', 'qualifications', 'additionalInformation']
        .map((k) => htmlToText(sections[k]?.text))
        .filter(Boolean)
        .join('\n\n'),
    });
  }
  return jobs;
}

/**
 * All current India design roles in a company's feed.
 * @param company an entry of lib/companies.js (with `feed`)
 * @param options.isKnown (job) => true when the job is stored already: its details are not fetched
 * @returns { jobs, requests }
 */
export async function fetchCompanyJobs(company, { fetchImpl = fetch, terms = WORKDAY_TERMS, isKnown = () => false, maxDetails = 30, timeoutMs = 20_000, now = new Date() } = {}) {
  const http = client(company, fetchImpl, timeoutMs);
  const read = { workday: readWorkday, smartrecruiters: readSmartRecruiters }[company.feed?.type];
  if (!read) throw new Error(`${company.name} has no feed`);
  const jobs = await read(company, http, { terms, isKnown, maxDetails, now });
  return { jobs, requests: http.requests };
}
