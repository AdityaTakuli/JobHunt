// Static check on the web app's React effects. An effect callback must return nothing or a
// cleanup function; React calls anything else as a function when the component unmounts and
// the whole app crashes (that is how `useEffect(() => el.scrollTo(...))` once blanked the Jobs
// page: scrollTo returned a Promise in Chrome). These shapes are banned at the source:
//   useEffect(() => expr, deps)        concise arrow body returns `expr`
//   useEffect(async () => {...}, deps) an async function returns a Promise
// Write a block body instead: useEffect(() => { expr; }, deps).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webSrc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(jsx?|tsx?)$/.test(entry.name) ? [full] : [];
  });
}

const HOOK = String.raw`use(?:Layout|Insertion)?Effect\(`;
const BANNED = [
  // () => <anything that is not a block>, also across a line break
  { re: new RegExp(HOOK + String.raw`\s*\(\s*\)\s*=>(?!\s*\{)`, 'g'), why: 'concise arrow body returns a value; use a block body `() => { ... }`' },
  { re: new RegExp(HOOK + String.raw`\s*async\b`, 'g'), why: 'async callback returns a Promise; call the async function from inside a sync effect' },
];

export function riskyEffects(source) {
  const problems = [];
  for (const { re, why } of BANNED) {
    for (const m of source.matchAll(re)) {
      const line = source.slice(0, m.index).split('\n').length;
      problems.push({ line, why });
    }
  }
  return problems;
}

describe('React effects in web/src', () => {
  it('never return a value (only nothing or a cleanup function)', () => {
    const found = [];
    for (const file of sourceFiles(webSrc)) {
      for (const p of riskyEffects(fs.readFileSync(file, 'utf8'))) {
        found.push(`${path.relative(webSrc, file)}:${p.line}: ${p.why}`);
      }
    }
    assert.deepEqual(found, [], `Effects that can crash the app on unmount:\n${found.join('\n')}`);
  });

  it('flags the shapes it is meant to catch', () => {
    assert.equal(riskyEffects('useEffect(() => el.scrollTo({ top: 0 }), [id]);').length, 1);
    assert.equal(riskyEffects('useEffect(() =>\n  setOpen(false), [id]);').length, 1);
    assert.equal(riskyEffects('useLayoutEffect(() => measure(), []);').length, 1);
    assert.equal(riskyEffects('useEffect(async () => { await load(); }, []);').length, 1);
    assert.equal(riskyEffects('useEffect(() => {\n  el.scrollTo({ top: 0 });\n}, [id]);').length, 0);
    assert.equal(riskyEffects('useEffect(load, [load]);').length, 0);
  });
});
