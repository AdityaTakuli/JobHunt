// Parses LinkedIn job-alert emails (forwarded from her Gmail) into job rows.
// Works from the job links, not from LinkedIn's exact layout, so format changes degrade
// gracefully: any linkedin.com/jobs/view/<id> link plus the text near it becomes a job.

import * as cheerio from 'cheerio';
import { APPLY_RANK, cleanText, decodeEntities, normalizeCity } from '../lib/normalize.js';

export const SOURCE = 'linkedin_email';
const JOB_LINK_RE = /linkedin\.com\/(?:comm\/)?jobs\/view\/(?:[^/?#"'\s]*?-)?(\d{6,})/i;
const JOB_LINK_RE_G = new RegExp(JOB_LINK_RE.source, 'gi');

const NOISE = [
  /^view (job|all jobs|similar jobs)$/i,
  /^(see all jobs|apply( now)?|easy apply|promoted|save|new|view)$/i,
  /^actively (recruiting|hiring)/i,
  /^be an early applicant/i,
  /^\d+\s+(school\s+)?alumni/i,
  /\bconnections?\b/i,
  /^\d+\+?\s+applicants?/i,
  /^(your job alert|jobs? similar to|new jobs? match|\d+ new jobs? match)/i,
  /^(on-site|remote|hybrid)$/i,
  /^(fast growing|in your network|top applicant|responses managed off linkedin)/i,
  /^\d+\s+(minutes?|hours?|days?|weeks?)\s+ago$/i,
  /^[·•|\-–\s]*$/,
];

const isNoise = (line) => NOISE.some((re) => re.test(line));

export function canonicalJobUrl(id) {
  return `https://www.linkedin.com/jobs/view/${id}/`;
}

function htmlToLines(html) {
  const text = String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|td|th|tr|table|li|h[1-6]|a)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[\s ​‌͏]+/g, ' ').trim())
    .filter(Boolean);
}

// Picks title / company / location from the lines of one job card.
export function cardFromLines(lines) {
  const useful = lines.filter((l) => !isNoise(l) && l.length <= 200);
  if (!useful.length) return null;

  const dotIndex = useful.findIndex((l) => /\s[·•]\s/.test(l));
  let title;
  let company = '';
  let location = '';
  if (dotIndex >= 0) {
    const [c, ...rest] = useful[dotIndex].split(/\s[·•]\s/);
    company = c;
    location = rest.join(', ');
    title = useful.slice(0, dotIndex).find((l) => l !== company) || useful[dotIndex + 1];
  } else {
    [title, company = '', location = ''] = useful;
  }
  if (!title || title.length < 3) return null;
  return {
    title: cleanText(title, 300),
    company: cleanText(company, 200),
    locationText: cleanText(location, 200),
  };
}

function parseHtml(html) {
  const $ = cheerio.load(html);
  const byId = new Map();

  $('a[href]').each((_, a) => {
    const m = String($(a).attr('href')).match(JOB_LINK_RE);
    if (!m) return;
    const id = m[1];
    if (!byId.has(id)) byId.set(id, { id, anchors: [] });
    byId.get(id).anchors.push(a);
  });

  const cards = [];
  for (const { id, anchors } of byId.values()) {
    // Text inside the job's own links first (title, sometimes the whole card).
    let lines = anchors.flatMap((a) => htmlToLines($.html(a)));
    let card = cardFromLines(lines);

    // Then widen to the largest ancestor that holds only this job's links: the card block.
    if (!card || !card.company) {
      let node = $(anchors[0]);
      let best = null;
      for (let depth = 0; depth < 8; depth += 1) {
        const parent = node.parent();
        if (!parent.length || parent.is('body, html')) break;
        const ids = new Set(
          parent
            .find('a[href]')
            .map((__, el) => String($(el).attr('href')).match(JOB_LINK_RE)?.[1])
            .get()
            .filter(Boolean),
        );
        if (ids.size > 1) break;
        best = parent;
        node = parent;
      }
      if (best) {
        lines = htmlToLines($.html(best));
        card = cardFromLines(lines) || card;
      }
    }
    if (card) cards.push({ id, ...card });
  }
  return cards;
}

// Plain-text alerts: "Title\nCompany\nLocation\nView job: https://www.linkedin.com/comm/jobs/view/123/"
function parseText(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim());
  const cards = [];
  const seen = new Set();
  let blockStart = 0;
  lines.forEach((line, i) => {
    const m = line.match(JOB_LINK_RE);
    if (!m) {
      if (/^-{3,}|^={3,}/.test(line)) blockStart = i + 1;
      return;
    }
    const block = lines
      .slice(blockStart, i)
      .filter((l) => l && !JOB_LINK_RE.test(l) && !/^https?:\/\//i.test(l));
    blockStart = i + 1;
    if (seen.has(m[1])) return;
    seen.add(m[1]);
    // Title, company, location are the last three meaningful lines before the link.
    const card = cardFromLines(block.filter((l) => !isNoise(l)).slice(-3));
    if (card) cards.push({ id: m[1], ...card });
  });
  return cards;
}

export function parseLinkedInAlert({ html, text, receivedAt = new Date() }) {
  let cards = html ? parseHtml(html) : [];
  if (!cards.length && text) cards = parseText(text);
  return cards.map((card) => ({
    source: SOURCE,
    externalId: card.id,
    title: card.title,
    company: card.company,
    locationText: card.locationText,
    city: normalizeCity(card.locationText),
    description: '',
    applyUrl: canonicalJobUrl(card.id),
    applyRank: APPLY_RANK.linkedin,
    postedAt: receivedAt,
    salary: null,
    publisher: 'LinkedIn',
  }));
}

// Quick check used to log emails that had job links we could not turn into cards.
export function countJobLinks(html, text) {
  const ids = new Set();
  for (const m of `${html || ''}\n${text || ''}`.matchAll(JOB_LINK_RE_G)) ids.add(m[1]);
  return ids.size;
}
