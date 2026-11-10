import { SKILL_GROUPS } from '../../shared/skills.js';

// What a posting asks for, grouped, so she knows what to put first on her CV and portfolio.
// Matched against the description text; also used to highlight those words in it. The list
// itself is shared with the server (shared/skills.js), which scores the fit with the same words.
const GROUPS = SKILL_GROUPS;

/**
 * @returns { groups: [{ name, items: string[] }], pattern: RegExp | null } — pattern matches every
 *   found keyword in the text, for highlighting.
 */
export function extractKeywords(text, extraTools = []) {
  const t = String(text || '');
  const found = [];
  const groups = GROUPS.map((g) => {
    const items = [];
    for (const [label, re] of g.items) {
      if (re.test(t)) {
        items.push(label);
        found.push(re.source);
      }
    }
    return { name: g.name, items };
  });
  // Tools the classifier spotted that are not in the list above.
  const tools = groups[0].items;
  for (const s of extraTools) if (s && !tools.some((x) => x.toLowerCase() === s.toLowerCase())) tools.push(s);
  return {
    groups: groups.filter((g) => g.items.length),
    pattern: found.length ? new RegExp(found.map((s) => `(?:${s})`).join('|'), 'gi') : null,
  };
}

// Splits text into strings and { mark } pieces for the keywords `pattern` finds.
export function highlightParts(text, pattern) {
  if (!pattern || !text) return [text];
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (!m[0]) continue;
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push({ mark: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
