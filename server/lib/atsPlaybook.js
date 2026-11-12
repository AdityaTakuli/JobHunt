// Picks the playbook examples (server/data/cvPlaybook.js + cv_examples rows) closest to one person
// and one posting, and writes them as a style guide for the CV prompt. Free models copy a shown
// pattern far better than they follow a description of it.

import { CV_EXAMPLES } from '../data/cvPlaybook.js';
import { extraPlaybook } from './atsKeywords.js';

/**
 * @param discipline  disciplineKey() of the person
 * @param labels      ATS term labels that matter here (asked by the posting and/or owned)
 * @returns {{ bullets: object[], summary: object | null }}
 */
export function pickExamples({ discipline, labels = [] }) {
  const want = new Set(labels.map((l) => l.toLowerCase()));
  const all = [...CV_EXAMPLES, ...extraPlaybook()];
  const rank = (e) => {
    const disc = e.disciplines.includes(discipline) ? 3 : e.disciplines.includes('all') ? 1 : 0;
    const overlap = (e.tags || []).filter((t) => want.has(String(t).toLowerCase())).length;
    return disc ? disc + overlap * 2 : -1;
  };
  const scored = all.map((e) => ({ e, s: rank(e) })).filter((x) => x.s > 0);
  const bullets = scored
    .filter((x) => x.e.kind !== 'summary')
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((x) => x.e);
  const summary = scored.filter((x) => x.e.kind === 'summary').sort((a, b) => b.s - a.s)[0]?.e || null;
  return { bullets, summary };
}

export function playbookPrompt(picked) {
  if (!picked.bullets.length && !picked.summary) return null;
  const lines = ['Examples of the writing wanted. They are about OTHER people: copy the pattern (verb + what + tool or method + deliverable or result), never their facts, names or numbers.'];
  for (const e of picked.bullets) lines.push(`- Weak: "${e.before}"\n  Strong: "${e.after}"${e.note ? `\n  Why: ${e.note}` : ''}`);
  if (picked.summary) lines.push(`- Weak summary: "${picked.summary.before}"\n  Strong summary: "${picked.summary.after}"`);
  return lines.join('\n');
}
