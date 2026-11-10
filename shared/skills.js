// The architecture skills taxonomy shared by the server (profile extraction, fit scoring) and the
// web app (keyword highlighting). Each item is [canonical label, pattern that matches how postings,
// CVs and portfolios write it]. `kind`: tool = software, skill = what you can do, ask = other things
// postings ask for.

export const SKILL_GROUPS = [
  {
    name: 'Tools',
    kind: 'tool',
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
    kind: 'skill',
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
    kind: 'ask',
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

// What kind of work a role or a project is about. Matched on job titles/descriptions and on
// portfolio project descriptions, so a role's focus can be compared with what a portfolio shows.
export const TYPOLOGIES = [
  ['Residential', /\bresidential\b|\bhousing\b|\bvilla|\bapartment|\bbungalow|\bhouse\b|\bhomes?\b/i],
  ['Commercial', /\bcommercial\b|\boffice (building|space|tower)|\bretail\b|\bmall\b|\bworkplace/i],
  ['Hospitality', /\bhospitality\b|\bhotel|\bresort|\brestaurant|\bcaf[eé]\b/i],
  ['Institutional', /\binstitutional\b|\bschool\b|\bcollege\b|\bcampus\b|\buniversity\b|\blibrary\b|\bmuseum\b/i],
  ['Healthcare', /\bhealthcare\b|\bhospital\b|\bclinic\b/i],
  ['Interiors', /\binterior/i],
  ['Landscape', /\blandscape\b|\bpark\b|\bgarden/i],
  ['Urban design', /\burban\b|\bmaster ?plan|\bcity\b|\btownship|\bpublic (space|realm)/i],
  ['Industrial', /\bindustrial\b|\bfactory\b|\bwarehouse\b|\bplant\b/i],
  ['Transport', /\bairport\b|\bmetro\b|\bstation\b|\btransit\b|\bmobility\b/i],
  ['Conservation', /\bconservation\b|\bheritage\b|\brestoration\b|\badaptive re-?use\b/i],
  ['Sustainability', /\bsustainab|\bnet[- ]zero\b|\bpassive\b|\bgreen building/i],
  ['BIM', /\bbim\b|\brevit\b|\bnavisworks\b/i],
];

// Drawing types a portfolio page can show. The vision model names them with these exact words.
export const DRAWING_TYPES = ['plan', 'section', 'elevation', 'detail', 'working drawing', 'site plan', 'site analysis', 'diagram', '3d view', 'render', 'physical model', 'sketch', 'photo', 'text'];

const ALL_ITEMS = SKILL_GROUPS.flatMap((g) => g.items.map(([label, re]) => ({ label, re, kind: g.kind })));

// Every taxonomy item found in a text.
export function findSkills(text) {
  const t = String(text || '');
  return ALL_ITEMS.filter(({ re }) => re.test(t)).map(({ label, kind }) => ({ label, kind }));
}

// The canonical label for one name written any way ("autocad", "Auto CAD", "AutoCAD 2024"), or
// the trimmed name itself when the taxonomy does not know it.
export function canonicalSkill(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const hit = ALL_ITEMS.find(({ re }) => re.test(s));
  return hit ? hit.label : s.replace(/\s+/g, ' ').slice(0, 40);
}

export const skillKind = (label) => ALL_ITEMS.find((i) => i.label === label)?.kind || null;

export function findTypologies(text) {
  const t = String(text || '');
  return TYPOLOGIES.filter(([, re]) => re.test(t)).map(([label]) => label);
}

export function canonicalTypology(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const hit = TYPOLOGIES.find(([, re]) => re.test(s));
  return hit ? hit[0] : s.slice(0, 30);
}
