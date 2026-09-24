// What a posting asks for, grouped, so she knows what to put first on her CV and portfolio.
// Matched against the description text; also used to highlight those words in it.
const GROUPS = [
  {
    name: 'Tools',
    items: [
      ['Revit', /\brevit\b/i],
      ['AutoCAD', /\bauto\s?cad\b/i],
      ['SketchUp', /\bsketch\s?up\b/i],
      ['Rhino', /\brhino(ceros)?\b/i],
      ['Grasshopper', /\bgrasshopper\b/i],
      ['Navisworks', /\bnavisworks\b/i],
      ['ArchiCAD', /\barchicad\b/i],
      ['Dynamo', /\bdynamo\b/i],
      ['BIM 360 / ACC', /\bbim ?360\b|\bautodesk construction cloud\b/i],
      ['Lumion', /\blumion\b/i],
      ['Enscape', /\benscape\b/i],
      ['V-Ray', /\bv-?ray\b/i],
      ['Twinmotion', /\btwinmotion\b/i],
      ['3ds Max', /\b3ds\s?max\b/i],
      ['Blender', /\bblender\b/i],
      ['Photoshop', /\bphotoshop\b/i],
      ['Illustrator', /\billustrator\b/i],
      ['InDesign', /\bindesign\b/i],
      ['Adobe Suite', /\badobe (creative )?(suite|cloud)\b/i],
      ['Tekla', /\btekla\b/i],
      ['MS Office', /\b(ms|microsoft) office\b/i],
      ['Excel', /\bexcel\b/i],
    ],
  },
  {
    name: 'Skills',
    items: [
      ['Working drawings', /\bworking drawings?\b/i],
      ['Construction drawings', /\bconstruction (documents?|drawings?|documentation)\b|\bgfc drawings?\b/i],
      ['Detailing', /\bdetailing\b|\bdetail drawings?\b|\bconstruction details\b/i],
      ['3D modelling', /\b3d model(l)?ing\b|\b3d models?\b/i],
      ['BIM modelling', /\bbim model(l)?ing\b/i],
      ['BIM coordination', /\bbim coordination\b|\bmodel coordination\b/i],
      ['Clash detection', /\bclash (detection|checks?|resolution)\b/i],
      ['Revit families', /\brevit famil(y|ies)\b|\bfamily creation\b/i],
      ['LOD', /\blod ?\d{3}\b|\blevel of development\b/i],
      ['Rendering', /\brender(ing|ings|s)\b|\bvisuali[sz]ations?\b/i],
      ['Concept design', /\bconcept(ual)? design\b/i],
      ['Design development', /\bdesign development\b/i],
      ['Space planning', /\bspace planning\b/i],
      ['Interior design', /\binterior design\b/i],
      ['Landscape', /\blandscape (design|architecture)\b/i],
      ['Urban design', /\burban design\b|\bmaster ?planning\b/i],
      ['Presentation drawings', /\bpresentation (drawings?|boards?|sheets?)\b/i],
      ['Site visits', /\bsite (visits?|supervision|coordination|execution)\b/i],
      ['Approval drawings', /\b(municipal|statutory|bbmp|authority|sanction) (approvals?|drawings?)\b|\bapproval drawings?\b/i],
      ['BOQ / estimation', /\bboq\b|\bbill of quantities\b|\b(quantity|cost) estimat/i],
      ['Tender drawings', /\btender (drawings?|documents?|documentation)\b/i],
      ['MEP coordination', /\bmep\b/i],
      ['Hand sketching', /\bhand[- ]sketch|\bfree ?hand\b/i],
      ['Model making', /\bmodel making\b|\b(physical|scale) models?\b/i],
      ['Sustainable design', /\bsustainab\w*|\bleed\b|\bgriha\b|\bigbc\b|\bgreen building/i],
    ],
  },
  {
    name: 'Asked for',
    items: [
      ['Portfolio', /\bportfolio\b/i],
      ['B.Arch', /\bb\.?\s?arch\b|\bbachelor'?s? (degree )?(of|in) architecture\b/i],
      ['M.Arch', /\bm\.?\s?arch\b/i],
      ['COA registration', /\bcoa\b|\bcouncil of architecture\b/i],
      ['Diploma', /\bdiploma\b/i],
      ['Communication', /\bcommunication\b/i],
      ['Teamwork', /\bteam ?(work|player)\b|\bcollaborat\w*/i],
      ['Deadlines', /\btime management\b|\bdeadlines?\b/i],
      ['Attention to detail', /\battention to detail\b|\bdetail[- ]oriented\b/i],
    ],
  },
];

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
