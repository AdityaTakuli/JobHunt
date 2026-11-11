// Reads the posting itself from a job's page, for jobs that arrived without one (alert emails list
// only a title and an employer). Job sites embed the full posting as schema.org JobPosting data
// for Google, so that is read first; the page's main text is the fallback. Sites that block
// servers (Glassdoor answers 403) return null, and the analysis says it had no posting to read.

import * as cheerio from 'cheerio';
import { decodeEntities } from './normalize.js';
import { safeFetch } from './safeFetch.js';

const MAX_BYTES = 3 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
export const MIN_USEFUL = 300; // shorter than this is a teaser, not a posting

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
 * The posting in a page's HTML.
 * @returns {{ description, title, company, companyAbout, source: 'jobposting' | 'page' } | null}
 */
export function postingFromHtml(html) {
  const $ = cheerio.load(String(html || ''));
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      continue;
    }
    for (const p of postingsIn(data)) {
      const description = plain(p.description);
      if (description.length < MIN_USEFUL) continue;
      const org = p.hiringOrganization || {};
      return {
        description,
        title: typeof p.title === 'string' ? p.title.trim() : null,
        company: typeof org.name === 'string' ? org.name.trim() : null,
        companyAbout: typeof org.description === 'string' ? plain(org.description).slice(0, 1500) : null,
        source: 'jobposting',
      };
    }
  }
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
