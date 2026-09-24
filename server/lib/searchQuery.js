// Turns what she types into a good Google Jobs search, so a keyword or a half-remembered spelling
// is enough:
//   "revti"               -> "Revit architect"        (spelling fixed, architecture added)
//   "intern"              -> "architecture intern"
//   "arch intership pune" -> "architecture internship", place Pune
//   "BIM Architect"       -> unchanged
// Words it doesn't know (a firm's name, another profession) are left alone, and the page offers
// the exact words instead whenever something was changed.

import { cleanText, findCity, normalizeCity } from './normalize.js';

// Words that already make it an architecture search.
const DOMAIN = ['architect', 'architects', 'architecture', 'architectural', 'bim', 'interior', 'interiors', 'landscape', 'urban', 'draftsman', 'draughtsman', 'archicad', 'b.arch', 'm.arch'];

// Other professions: searched as typed.
const PROFESSIONS = ['engineer', 'engineers', 'planner', 'planners', 'manager', 'surveyor', 'estimator', 'consultant', 'developer', 'analyst', 'teacher', 'faculty', 'professor', 'lecturer', 'photographer', 'accountant', 'executive', 'officer', 'supervisor'];

// Roles and levels: "architecture" goes in front ("intern" -> "architecture intern").
const ROLES = ['intern', 'interns', 'internship', 'internships', 'trainee', 'fresher', 'freshers', 'graduate', 'apprentice', 'designer', 'designers', 'visualiser', 'visualizer', 'modeler', 'modeller', 'drafter', 'assistant', 'technician', 'coordinator', 'associate'];

// Software and skills: "architect" goes after ("revit" -> "Revit architect").
const SKILLS = ['revit', 'autocad', 'sketchup', 'rhino', 'grasshopper', 'navisworks', 'dynamo', 'lumion', 'enscape', 'v-ray', 'twinmotion', 'blender', '3ds', 'photoshop', 'illustrator', 'indesign', 'cad', '2d', '3d', 'rendering', 'renders', 'drafting', 'detailing', 'modelling', 'modeling', 'visualisation', 'visualization', 'drawings', 'parametric', 'computational', 'heritage', 'conservation', 'facade', 'sustainable', 'sustainability'];

// Spelling is checked against these (and the lists above).
const OTHER_WORDS = ['junior', 'senior', 'design', 'studio', 'project', 'projects', 'construction', 'building', 'residential', 'commercial', 'hospitality', 'working', 'drawing', 'concept', 'planning', 'furniture', 'entry'];

const CANONICAL = {
  bim: 'BIM', revit: 'Revit', autocad: 'AutoCAD', sketchup: 'SketchUp', rhino: 'Rhino', grasshopper: 'Grasshopper', navisworks: 'Navisworks',
  dynamo: 'Dynamo', lumion: 'Lumion', enscape: 'Enscape', 'v-ray': 'V-Ray', twinmotion: 'Twinmotion', blender: 'Blender', photoshop: 'Photoshop',
  illustrator: 'Illustrator', indesign: 'InDesign', archicad: 'ArchiCAD', 'b.arch': 'B.Arch', 'm.arch': 'M.Arch',
};

// Split or joined spellings and short forms.
const PHRASES = [
  [/\bauto[\s-]?cad\b/gi, 'AutoCAD'],
  [/\bsketch[\s-]?up\b/gi, 'SketchUp'],
  [/\bv[\s-]?ray\b/gi, 'V-Ray'],
  [/\b3d[\s-]?s?[\s-]?max\b/gi, '3ds Max'],
  [/\barch[\s-]?viz\b/gi, 'architectural visualisation'],
  [/\bb[\s.]?arch\b/gi, 'B.Arch'],
  [/\bm[\s.]arch\b/gi, 'M.Arch'],
  [/\bnear me\b/gi, ''],
];
const SHORT_FORMS = { arch: 'architecture', archi: 'architecture', jr: 'junior', 'jr.': 'junior', sr: 'senior', 'sr.': 'senior', asst: 'assistant', acad: 'AutoCAD', viz: 'visualisation' };

// Words that add nothing to a job search.
const FILLER = new Set(['job', 'jobs', 'vacancy', 'vacancies', 'opening', 'openings', 'hiring', 'position', 'positions', 'opportunity', 'opportunities', 'role', 'roles', 'for', 'a', 'an', 'the']);

const has = (list) => {
  const set = new Set(list);
  return (words) => words.some((w) => set.has(w.toLowerCase()));
};
const hasDomain = has(DOMAIN);
const hasProfession = has(PROFESSIONS);
const hasRole = has(ROLES);
const hasSkill = has(SKILLS);

const VOCABULARY = [...new Set([...DOMAIN, ...PROFESSIONS, ...ROLES, ...SKILLS, ...OTHER_WORDS])];
const KNOWN = new Set(VOCABULARY);
// Only longer words are spelling targets: short ones sit one letter away from too many real words.
const TARGETS = VOCABULARY.filter((w) => w.length >= 5 && /^[a-z]+$/.test(w));

// Edits between two words, a swap of neighbouring letters counting as one ("revti" -> "revit").
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// A misspelt architecture word -> the word. One slip allowed (two in long words), same first
// letter, and only when one word is that close (a word and its plural count as one).
function fixSpelling(word) {
  const lower = word.toLowerCase();
  if (KNOWN.has(lower)) return CANONICAL[lower] || word;
  if (lower.length < 4 || !/^[a-z]+$/.test(lower)) return word;
  const allowed = lower.length >= 9 ? 2 : 1;
  let closest = [];
  let bestDistance = allowed;
  for (const target of TARGETS) {
    if (target[0] !== lower[0] || Math.abs(target.length - lower.length) > allowed) continue;
    const distance = editDistance(lower, target);
    if (distance > bestDistance) continue;
    if (distance < bestDistance || !closest.length) [closest, bestDistance] = [[target], distance];
    else if (distance === bestDistance) closest.push(target);
  }
  if (!closest.length || new Set(closest.map((w) => w.replace(/s$/, ''))).size > 1) return word;
  const best = closest.reduce((a, b) => (b.length < a.length ? b : a));
  return CANONICAL[best] || best;
}

/**
 * @param typed what she typed
 * @param where the search bar's place (may be empty)
 * @returns {{ query: string, place: string, adjusted: boolean }} query goes to Google as it is;
 *   place is a city named in the text (it wins over `where`, which the page fills in on its own),
 *   else `where` with its spelling tidied ("banglore" -> Bengaluru).
 */
export function understandSearch(typed, where = '') {
  const original = cleanText(typed, 120);
  let text = original;
  let place = cleanText(where, 80);
  place = (place && normalizeCity(place)) || place;

  const named = findCity(text);
  if (named) {
    place = named.city;
    text = text.replace(named.match, ' ');
  }
  for (const [pattern, replacement] of PHRASES) text = text.replace(pattern, replacement);

  let words = text
    .split(/\s+/)
    .filter((w) => w && !FILLER.has(w.toLowerCase()))
    .map((w) => SHORT_FORMS[w.toLowerCase()] || fixSpelling(w));
  // Drop "in"/"at" left dangling at either end ("jobs in" once the city is out).
  while (words.length && /^(in|at|near|around|from)$/i.test(words[words.length - 1])) words.pop();
  while (words.length && /^(in|at|near|around|from)$/i.test(words[0])) words.shift();

  if (!words.length) {
    words = ['architecture'];
  } else if (!hasDomain(words) && !hasProfession(words)) {
    if (hasRole(words)) words = ['architecture', ...words];
    else if (hasSkill(words)) words = [...words, 'architect'];
  }

  const query = words.join(' ').slice(0, 120);
  return { query, place, adjusted: query.toLowerCase() !== original.toLowerCase() };
}
