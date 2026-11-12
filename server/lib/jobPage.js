// Reads the posting itself from a job's page, for jobs that arrived without one (alert emails list
// only a title and an employer). Job sites embed the full posting as schema.org JobPosting data
// for Google, so that is read first; the page's main text is the fallback. Sites that block
// servers (Glassdoor answers 403) return null, and the analysis says it had no posting to read.

import * as cheerio from 'cheerio';
import { decodeEntities } from './normalize.js';
import { safeFetch } from './safeFetch.js';

const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
// Page text shorter than this is a teaser or a menu, not a posting. A posting in schema.org data is
// the posting itself even when short (small firms write a few lines), so it only needs MIN_POSTING.
export const MIN_USEFUL = 300;
export const MIN_POSTING = 80;

// HTML (or text with entities) to plain text, one line per paragraph or list item.
function plain(html) {
  // JSON-LD descriptions often carry the HTML escaped (&lt;p&gt;): unescape it first.
  const source = /&lt;\/?[a-z]/i.test(String(html || '')) ? decodeEntities(String(html)) : String(html || '');
  const $ = cheerio.load(`<body>${source}</body>`);
  $('br').replaceWith('\n');
  $('p, li, h1, h2, h3, h4, h5, div, tr').append('\n');
  $('li').prepend('- ');
  return decodeEntities($('body').text())
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function postingsIn(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) postingsIn(n, out);
    return out;
  }
  const type = [].concat(node['@type'] || []).map(String);
  if (type.includes('JobPosting')) out.push(node);
  if (node['@graph']) postingsIn(node['@graph'], out);
  return out;
}

/**
 * The posting in a page's schema.org data (the text of its ld+json scripts), or null.
 * @param {string[]} blocks
 */
export function postingFromJsonLd(blocks) {
  for (const block of blocks || []) {
    let data;
    try {
      data = JSON.parse(String(block));
    } catch {
      continue;
    }
    for (const p of postingsIn(data)) {
      const description = plain(p.description);
      if (description.length < MIN_POSTING) continue;
      const org = p.hiringOrganization || {};
      return {
        description: description.slice(0, 20_000),
        title: typeof p.title === 'string' ? p.title.trim() : null,
        company: typeof org.name === 'string' ? org.name.trim() : null,
        companyAbout: typeof org.description === 'string' ? plain(org.description).slice(0, 1500) : null,
        source: 'jobposting',
      };
    }
  }
  return null;
}

/**
 * LIKE patterns that find a stored job from the address of its page. Matches on the page's
 * address without the query string, and on the listing ids job sites use (Glassdoor ?jl=,
 * jobListingId=, LinkedIn /jobs/view/<id>), so a link with different tracking still matches.
 */
const ID_PARAMS = ['jobListingId', 'jl', 'jk', 'vjk', 'gh_jid', 'jobId', 'jobid', 'job_id', 'jid', 'reqId', 'requisitionId', 'postingId', 'id'];
const GENERIC_PATH = /\/(partner\/)?joblisting\.htm$|\/viewjob$|\/rc\/clk$|\/pagead\/clk$|\/apply$|\/job$|\/jobs$|\/careers?$|\/index\.(php|html?|aspx)$/i;

export function jobUrlPatterns(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  if (!/^https?:$/.test(u.protocol)) return [];
  const like = (s) => s.replace(/[\\%_]/g, '\\$&');
  const out = new Set();
  const path = u.pathname.replace(/\/+$/, '');
  const host = u.hostname.replace(/^www\./, '');
  // The job's own id in the query string ("?jobListingId=123", "?jk=abc", "?gh_jid=42").
  let idParam = null;
  for (const key of ID_PARAMS) {
    const v = u.searchParams.get(key);
    if (v && /^[A-Za-z0-9_-]{4,64}$/.test(v)) {
      idParam = [key, v];
      break;
    }
  }
  // The path alone names one job only when it carries an id or a slug ("/jobs/view/4012345",
  // "/job-listing/bim-intern-wsp-JV_...htm"). A shared path ("/partner/jobListing.htm",
  // "/viewjob", "/apply") is the same for every job on the site: matching on it tied pages to
  // the wrong job (a Glassdoor posting's text saved on another Glassdoor job).
  const pathNamesJob = path.length > 1 && (/\d{4,}/.test(path) || path.split('/').some((seg) => (seg.length >= 12 && /[-_]/.test(seg)) || seg.length >= 25 || /\d{3,}/.test(seg))) && !GENERIC_PATH.test(path);
  if (pathNamesJob) out.add(`${like(`${u.host}${path}`)}%`);
  else if (idParam && path.length >= 1) out.add(`${like(`${u.host}${path || '/'}`)}%${like(`${idParam[0]}=${idParam[1]}`)}%`);
  if (/(^|\.)glassdoor\./.test(host)) {
    const id = u.searchParams.get('jl') || u.searchParams.get('jobListingId');
    if (/^\d{6,}$/.test(id || '')) {
      out.add(`%glassdoor.%jl=${id}%`);
      out.add(`%glassdoor.%jobListingId=${id}%`);
    }
  }
  if (/(^|\.)indeed\./.test(host)) {
    const jk = u.searchParams.get('jk') || u.searchParams.get('vjk');
    if (/^[a-f0-9]{8,32}$/i.test(jk || '')) {
      out.add(`%indeed.%jk=${jk}%`);
      out.add(`%indeed.%vjk=${jk}%`);
    }
  }
  if (/(^|\.)linkedin\.com$/.test(host)) {
    const id = u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/)?.[1] || u.searchParams.get('currentJobId');
    if (/^\d{6,}$/.test(id || '')) out.add(`%linkedin.com%/jobs/view/%${id}%`);
  }
  return [...out].map((p) => (p.startsWith('%') ? p : `%${p}`));
}

/**
 * The posting in a page's HTML.
 * @returns {{ description, title, company, companyAbout, source: 'jobposting' | 'page' } | null}
 */
export function postingFromHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const fromData = postingFromJsonLd($('script[type="application/ld+json"]').toArray().map((el) => $(el).contents().text()));
  if (fromData) return fromData;
  // No structured data: the main text of the page, without navigation and footers.
  $('script, style, noscript, nav, header, footer, form, svg, iframe, [role="navigation"], [aria-hidden="true"]').remove();
  const main = $('main, article, [class*="job-description" i], [class*="jobDescription" i], [id*="job-description" i], [class*="description" i]').first();
  const text = plain((main.length ? main : $('body')).html());
  if (text.length < MIN_USEFUL) return null;
  return { description: text.slice(0, 12_000), title: null, company: null, companyAbout: null, source: 'page' };
}

// Pages that answered but are a sign-in wall or a bot check, not a posting.
const WALL = /verify you are human|are you a robot|access denied|enable javascript|sign in to (see|view)|security check|captcha|just a moment/i;

/**
 * Fetches one job page and reads the posting from it. Never throws.
 */
export async function fetchPosting(url, { fetchImpl = safeFetch, timeoutMs = 12_000 } = {}) {
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-IN,en;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !/html/i.test(res.headers.get('content-type') || 'text/html')) {
      res.body?.cancel?.().catch(() => {});
      return null;
    }
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_BYTES) {
      res.body?.cancel?.().catch(() => {});
      return null;
    }
    const html = (await res.text()).slice(0, MAX_BYTES);
    const posting = postingFromHtml(html);
    if (!posting) return null;
    if (posting.source === 'page' && WALL.test(posting.description.slice(0, 600))) return null;
    return posting;
  } catch {
    return null;
  }
}

/**
 * Tries each link (apply link first, then the other places the job is listed) until one gives a
 * posting. @returns the posting with its url, or null
 */
export async function findPosting(urls, options) {
  for (const url of [...new Set(urls.filter(Boolean))].slice(0, 4)) {
    const posting = await fetchPosting(url, options);
    if (posting) return { ...posting, url };
  }
  return null;
}
