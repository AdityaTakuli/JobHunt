// ATS evaluation: the same postings and people written two ways with the real free models (the AI
// gateway in .env), scored with the same code check (lib/atsQuality.js).
//   old  = one pass, no keyword guidance, no playbook (how CVs were written before)
//   new  = keyword brief + playbook examples + one revision of what the checker found
// A perfect CV scores 100: every posting keyword the person has, in the posting's words, strong
// bullets, standard sections. Nothing here touches the database.
//
// Run: npm run eval:ats            (writes test/eval/ats-report.json)
//      npm run eval:ats -- --only=civil-site

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobKeywords } from '../../server/lib/atsKeywords.js';
import { scoreCv } from '../../server/lib/atsQuality.js';
import { askJson, profileAvailable } from '../../server/lib/profileBuild.js';
import { ownedTextOf, tailor } from '../../server/lib/tailor.js';
import { config } from '../../server/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { people, postings, pairs } = JSON.parse(fs.readFileSync(path.join(here, 'ats-cases.json'), 'utf8'));
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);

if (!profileAvailable()) {
  console.error('No AI gateway configured in .env: nothing to evaluate.');
  process.exit(1);
}

const cfg = { ...config, profile: { ...config.profile, timeoutMs: config.profile.tailorTimeoutMs } };
const PAUSE_MS = Number(process.argv.find((a) => a.startsWith('--pause='))?.slice(8) || 12) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rows = [];
for (const [personKey, postingKey] of pairs) {
  const id = `${personKey} → ${postingKey}`;
  if (only && !id.includes(only)) continue;
  const p = people[personKey];
  const posting = postings[postingKey];
  const asked = jobKeywords(posting);
  const ownedText = ownedTextOf({ profile: p.profile, resumeText: p.resumeText, pages: p.pages, details: p.details });
  for (const variant of ['old', 'new']) {
    let calls = 0;
    const started = Date.now();
    try {
      const out = await tailor({
        profile: p.profile,
        resumeText: p.resumeText,
        pages: p.pages || null,
        details: p.details || null,
        posting,
        // The free models allow only so many calls a minute: a pause before each, and one more
        // try after a minute when the gateway says it is busy.
        ask: async (call) => {
          calls += 1;
          await sleep(PAUSE_MS);
          try {
            return await askJson({ ...call, cfg });
          } catch (err) {
            if (!(err.kind === 'rate_limit' || err.status === 429 || /rate limit|429/.test(err.message))) throw err;
            console.log('   (gateway busy: waiting a minute)');
            await sleep(60_000);
            return askJson({ ...call, cfg });
          }
        },
        options: variant === 'old' ? { playbook: false, revise: false } : {},
      });
      const q = scoreCv(out.resume, { asked, ownedText, name: p.details?.name || p.profile.name });
      rows.push({
        id,
        variant,
        score: q.score,
        coverage: q.coverage,
        missing: q.missingOwned.length,
        wording: q.wording.length,
        weakBullets: q.issues.filter((i) => /starts weakly|first person|action verb|too short|too long|twice/.test(i)).length,
        dropped: out.dropped.length,
        bullets: [...out.resume.experience, ...out.resume.projects].reduce((n, e) => n + e.bullets.length, 0),
        calls,
        seconds: Math.round((Date.now() - started) / 1000),
        firstDraft: out.match?.quality?.first ?? null,
        issues: q.issues,
        summary: out.resume.summary,
      });
    } catch (err) {
      rows.push({ id, variant, error: err.message, calls, seconds: Math.round((Date.now() - started) / 1000) });
    }
    const r = rows.at(-1);
    console.log(`${id.padEnd(34)} ${variant.padEnd(4)} ${r.error ? `ERROR ${r.error}` : `score ${String(r.score).padStart(3)}  keywords ${String(r.coverage).padStart(3)}%  missing ${r.missing}  wording ${r.wording}  weak bullets ${r.weakBullets}  removed ${r.dropped}  bullets ${r.bullets}  ${r.calls} call(s) ${r.seconds}s`}`);
  }
}

const avg = (variant, key) => {
  const ok = rows.filter((r) => r.variant === variant && !r.error);
  return ok.length ? Math.round((ok.reduce((s, r) => s + r[key], 0) / ok.length) * 10) / 10 : null;
};
console.log('\nAverages            old     new     (perfect: score 100, keywords 100%, missing 0, wording 0, weak 0)');
for (const key of ['score', 'coverage', 'missing', 'wording', 'weakBullets', 'dropped', 'bullets', 'calls', 'seconds']) {
  console.log(`  ${key.padEnd(16)} ${String(avg('old', key)).padStart(6)}  ${String(avg('new', key)).padStart(6)}`);
}
const errors = rows.filter((r) => r.error).length;
if (errors) console.log(`  ${errors} run(s) failed (the free models were busy or returned bad JSON).`);
fs.writeFileSync(path.join(here, 'ats-report.json'), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
console.log(`\nFull report: ${path.join(here, 'ats-report.json')}`);
