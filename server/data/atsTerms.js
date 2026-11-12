// The ATS keyword list: tools, skills, qualifications and standards that job postings in
// architecture, interiors, civil, mechanical, electrical and planning ask for, each with the other
// ways people write it. Seeded into the ats_terms table (server/db/migrate.js); rows added there by
// hand join these. The architecture terms already in shared/skills.js are added by lib/atsKeywords.js,
// so they are not repeated here.
//
// label: the canonical name (what a CV should say). aliases: other spellings, acronyms, long forms.
// kind: tool | skill | qualification | standard | soft. disciplines: where it matters ('all' = any).

const T = (label, kind, disciplines, aliases = []) => ({ label, kind, disciplines, aliases });
const ARCH = ['architecture', 'interiors'];
const CIVIL = ['civil'];
const MECH = ['mechanical'];
const ELEC = ['electrical'];
const PLAN = ['planning'];
const BUILT = ['architecture', 'interiors', 'civil', 'planning'];
const ENG = ['civil', 'mechanical', 'electrical'];
const ALL = ['all'];

export const ATS_TERMS = [
  // ---- Architecture and interiors (beyond shared/skills.js) ----
  T('Building Information Modelling', 'skill', [...BUILT, 'mechanical', 'electrical'], ['BIM', 'Building Information Modeling']),
  T('AutoCAD Architecture', 'tool', ARCH, ['ACA']),
  T('Revit Architecture', 'tool', ARCH, []),
  T('Vectorworks', 'tool', ARCH, []),
  T('Corona Renderer', 'tool', ARCH, ['Corona']),
  T('D5 Render', 'tool', ARCH, ['D5']),
  T('Unreal Engine', 'tool', ARCH, ['Unreal']),
  T('Adobe Premiere Pro', 'tool', ARCH, ['Premiere Pro']),
  T('Canva', 'tool', ALL, []),
  T('Figma', 'tool', ARCH, []),
  T('Climate Studio', 'tool', ARCH, ['ClimateStudio']),
  T('Ladybug', 'tool', ARCH, ['Ladybug Tools']),
  T('DesignBuilder', 'tool', [...ARCH, 'mechanical'], ['Design Builder']),
  T('eQUEST', 'tool', [...ARCH, 'mechanical'], []),
  T('EnergyPlus', 'tool', [...ARCH, 'mechanical'], ['Energy Plus']),
  T('IES VE', 'tool', [...ARCH, 'mechanical'], ['IES Virtual Environment', 'IESVE']),
  T('FirstRate5', 'tool', ARCH, ['FirstRate 5']),
  T('NatHERS', 'standard', ARCH, ['Nationwide House Energy Rating Scheme']),
  T('Energy modelling', 'skill', [...ARCH, 'mechanical'], ['energy modeling', 'energy simulation', 'thermal modelling', 'thermal modeling', 'energy rating']),
  T('Daylight analysis', 'skill', ARCH, ['daylighting', 'daylight simulation']),
  T('Passive design', 'skill', ARCH, ['passive strategies', 'climate responsive design']),
  T('Parametric design', 'skill', ARCH, ['computational design', 'parametric modelling', 'parametric modeling']),
  T('Furniture design', 'skill', ['interiors'], ['furniture detailing']),
  T('Joinery details', 'skill', ['interiors'], ['joinery', 'carpentry details']),
  T('Material selection', 'skill', ['interiors', 'architecture'], ['materials and finishes', 'material palette', 'FF&E']),
  T('Lighting design', 'skill', ['interiors', 'architecture', 'electrical'], ['lighting layout']),
  T('Mood boards', 'skill', ['interiors'], ['moodboards', 'mood board']),
  T('Heritage documentation', 'skill', ARCH, ['measured drawings', 'heritage survey', 'architectural documentation']),
  T('Site analysis', 'skill', [...BUILT], ['site study', 'site survey']),
  T('Massing studies', 'skill', ARCH, ['massing']),
  T('Building bye-laws', 'standard', BUILT, ['byelaws', 'bye laws', 'building bylaws', 'development control regulations', 'DCR']),
  T('National Building Code', 'standard', [...BUILT, 'mechanical', 'electrical'], ['NBC', 'NBC 2016']),
  T('Universal design', 'skill', ARCH, ['accessibility', 'barrier-free design']),
  T('Facade design', 'skill', ARCH, ['façade design', 'facade engineering', 'façade']),
  T('Construction administration', 'skill', BUILT, ['contract administration']),
  T('Shop drawings', 'skill', [...BUILT, 'mechanical'], ['shop drawing']),
  T('As-built drawings', 'skill', [...BUILT, 'mechanical', 'electrical'], ['as built drawings', 'as-builts']),
  T('Good for Construction drawings', 'skill', BUILT, ['GFC']),

  // ---- Civil and structural ----
  T('STAAD.Pro', 'tool', CIVIL, ['STAAD Pro', 'STAAD']),
  T('ETABS', 'tool', CIVIL, []),
  T('SAP2000', 'tool', CIVIL, ['SAP 2000']),
  T('CSI SAFE', 'tool', CIVIL, ['SAFE software']),
  T('Revit Structure', 'tool', CIVIL, []),
  T('AutoCAD Civil 3D', 'tool', CIVIL, ['Civil 3D', 'Civil3D']),
  T('Tekla Structures', 'tool', CIVIL, ['Tekla']),
  T('MIDAS', 'tool', CIVIL, ['MIDAS Civil', 'MIDAS Gen']),
  T('ANSYS', 'tool', [...CIVIL, ...MECH], []),
  T('Primavera P6', 'tool', [...CIVIL, 'architecture', 'mechanical'], ['Primavera', 'P6']),
  T('MS Project', 'tool', ALL, ['Microsoft Project', 'MSP']),
  T('QGIS', 'tool', [...CIVIL, ...PLAN], []),
  T('ArcGIS', 'tool', [...CIVIL, ...PLAN], ['Arc GIS']),
  T('GIS', 'skill', [...CIVIL, ...PLAN], ['geographic information system']),
  T('Total station', 'tool', CIVIL, []),
  T('HEC-RAS', 'tool', CIVIL, ['HEC RAS']),
  T('WaterGEMS', 'tool', CIVIL, ['Water GEMS']),
  T('Structural analysis', 'skill', CIVIL, ['structural design', 'structural engineering']),
  T('RCC design', 'skill', CIVIL, ['reinforced concrete design', 'RCC', 'reinforced cement concrete']),
  T('Steel design', 'skill', CIVIL, ['steel structures']),
  T('Foundation design', 'skill', CIVIL, ['geotechnical', 'soil mechanics']),
  T('Surveying', 'skill', CIVIL, ['land survey', 'levelling', 'leveling']),
  T('Quantity surveying', 'skill', [...CIVIL, 'architecture'], ['quantity takeoff', 'quantity take-off', 'QS', 'rate analysis']),
  T('Estimation and costing', 'skill', [...CIVIL, 'architecture', 'interiors'], ['estimation', 'costing', 'cost estimation']),
  T('Bar bending schedule', 'skill', CIVIL, ['BBS']),
  T('Site execution', 'skill', [...CIVIL, 'architecture', 'interiors'], ['site engineer', 'site supervision']),
  T('Quality control', 'skill', [...CIVIL, ...MECH], ['QA/QC', 'QC', 'quality assurance', 'QA']),
  T('Project planning', 'skill', ALL, ['project scheduling', 'planning and scheduling']),
  T('Billing', 'skill', [...CIVIL, 'interiors'], ['RA bills', 'running account bills', 'contractor billing']),
  T('Highway design', 'skill', CIVIL, ['road design', 'pavement design']),
  T('Transportation engineering', 'skill', CIVIL, ['traffic engineering']),
  T('Water supply and sanitation', 'skill', CIVIL, ['plumbing design', 'public health engineering', 'PHE']),
  T('Environmental engineering', 'skill', CIVIL, ['wastewater treatment', 'environmental impact assessment', 'EIA']),
  T('IS 456', 'standard', CIVIL, ['IS:456', 'IS456']),
  T('IS 800', 'standard', CIVIL, ['IS:800', 'IS800']),
  T('IS 1893', 'standard', CIVIL, ['IS:1893', 'seismic code']),
  T('IRC codes', 'standard', CIVIL, ['IRC']),
  T('B.Tech Civil', 'qualification', CIVIL, ['B.E. Civil', 'BE Civil', 'Bachelor of Technology in Civil Engineering', 'B.Tech in Civil Engineering', 'civil engineering degree']),
  T('M.Tech Structures', 'qualification', CIVIL, ['M.Tech Structural', 'M.E. Structures', 'M.Tech in Structural Engineering']),
  T('Diploma in Civil Engineering', 'qualification', CIVIL, ['civil diploma']),

  // ---- Mechanical ----
  T('SolidWorks', 'tool', MECH, ['Solid Works']),
  T('CATIA', 'tool', MECH, ['CATIA V5']),
  T('Creo', 'tool', MECH, ['PTC Creo', 'Pro/E', 'Pro Engineer']),
  T('Siemens NX', 'tool', MECH, ['Unigraphics', 'NX CAD']),
  T('Autodesk Inventor', 'tool', MECH, ['Inventor']),
  T('Fusion 360', 'tool', MECH, ['Autodesk Fusion']),
  T('AutoCAD Mechanical', 'tool', MECH, []),
  T('HyperMesh', 'tool', MECH, ['Hyper Mesh']),
  T('Abaqus', 'tool', MECH, []),
  T('MATLAB', 'tool', [...MECH, ...ELEC], ['Matlab']),
  T('Simulink', 'tool', [...MECH, ...ELEC], []),
  T('Revit MEP', 'tool', [...MECH, ...ELEC], []),
  T('HAP', 'tool', MECH, ['Hourly Analysis Program', 'Carrier HAP']),
  T('CFD', 'skill', MECH, ['computational fluid dynamics', 'ANSYS Fluent', 'Fluent']),
  T('FEA', 'skill', [...MECH, ...CIVIL], ['finite element analysis', 'finite element method', 'FEM']),
  T('GD&T', 'skill', MECH, ['geometric dimensioning and tolerancing', 'GDT']),
  T('3D CAD modelling', 'skill', MECH, ['CAD modelling', 'CAD modeling', 'part modelling', 'assembly modelling']),
  T('Product design', 'skill', MECH, ['product development', 'design for manufacturing', 'DFM']),
  T('Manufacturing processes', 'skill', MECH, ['machining', 'casting', 'welding', 'sheet metal']),
  T('CNC programming', 'skill', MECH, ['CNC', 'G-code', 'CAM']),
  T('HVAC design', 'skill', MECH, ['HVAC', 'heating ventilation and air conditioning', 'heat load calculation']),
  T('Plumbing and fire fighting', 'skill', MECH, ['fire fighting', 'fire protection', 'plumbing']),
  T('Thermodynamics', 'skill', MECH, ['heat transfer', 'thermal engineering']),
  T('Lean manufacturing', 'skill', MECH, ['lean', 'kaizen', '5S', 'six sigma']),
  T('Root cause analysis', 'skill', [...MECH, ...ELEC], ['RCA', '8D', 'fishbone']),
  T('Preventive maintenance', 'skill', [...MECH, ...ELEC], ['maintenance planning', 'TPM']),
  T('B.Tech Mechanical', 'qualification', MECH, ['B.E. Mechanical', 'BE Mechanical', 'Bachelor of Technology in Mechanical Engineering', 'B.Tech in Mechanical Engineering', 'mechanical engineering degree']),
  T('Diploma in Mechanical Engineering', 'qualification', MECH, ['mechanical diploma']),

  // ---- Electrical ----
  T('ETAP', 'tool', ELEC, []),
  T('DIALux', 'tool', [...ELEC, 'interiors'], ['DIALux evo']),
  T('AutoCAD Electrical', 'tool', ELEC, []),
  T('PLC programming', 'skill', ELEC, ['PLC', 'SCADA']),
  T('Power systems', 'skill', ELEC, ['power distribution', 'load flow']),
  T('Electrical design', 'skill', ELEC, ['electrical layout', 'single line diagram', 'SLD', 'cable sizing']),
  T('B.Tech Electrical', 'qualification', ELEC, ['B.E. Electrical', 'BE Electrical', 'B.Tech in Electrical Engineering', 'EEE']),

  // ---- Planning ----
  T('Urban planning', 'skill', PLAN, ['town planning', 'city planning', 'regional planning']),
  T('Land use planning', 'skill', PLAN, ['land use', 'zoning']),
  T('Master plan', 'skill', [...PLAN, 'architecture'], ['masterplan', 'master planning']),
  T('Transport planning', 'skill', PLAN, ['mobility planning']),
  T('M.Plan', 'qualification', PLAN, ['Master of Planning', 'M Plan']),
  T('B.Plan', 'qualification', PLAN, ['Bachelor of Planning', 'B Plan']),

  // ---- Qualifications and registrations for any built-environment role ----
  T('B.Des', 'qualification', ['interiors'], ['Bachelor of Design', 'B Des']),
  T('Interior design diploma', 'qualification', ['interiors'], ['diploma in interior design']),
  T('LEED AP', 'qualification', [...BUILT, 'mechanical'], ['LEED Green Associate', 'LEED GA']),
  T('GRIHA', 'standard', [...BUILT, 'mechanical'], ['GRIHA certified']),
  T('IGBC AP', 'qualification', [...BUILT, 'mechanical'], ['IGBC Accredited Professional']),
  T('PMP', 'qualification', ALL, ['Project Management Professional']),
  T('Autodesk Certified Professional', 'qualification', ALL, ['Autodesk certification', 'Autodesk Certified User']),

  // ---- Office tools and general skills every posting can ask for ----
  T('Microsoft Word', 'tool', ALL, ['MS Word']),
  T('PowerPoint', 'tool', ALL, ['MS PowerPoint', 'Power Point']),
  T('Google Workspace', 'tool', ALL, ['G Suite', 'Google Sheets', 'Google Docs']),
  T('Python', 'tool', ALL, []),
  T('Technical documentation', 'skill', ALL, ['documentation', 'technical reports', 'report writing']),
  T('Coordination', 'skill', ALL, ['interdisciplinary coordination', 'consultant coordination', 'stakeholder coordination']),
  T('Client presentations', 'skill', ALL, ['client meetings', 'client handling', 'presentation skills']),
  T('Research', 'skill', ALL, ['case studies', 'case study', 'literature review']),
  T('Problem solving', 'soft', ALL, ['problem-solving', 'analytical skills', 'analytical thinking']),
  T('Leadership', 'soft', ALL, ['team lead', 'led a team']),
  T('Time management', 'soft', ALL, ['meeting deadlines', 'prioritisation', 'prioritization']),
  T('Written communication', 'soft', ALL, ['written and verbal communication', 'verbal communication', 'English communication']),
];

// Words that start a strong CV bullet (past tense, or -ing for ongoing work). lib/atsQuality.js also
// accepts any past-tense verb it does not know; these are for the "weak start" check.
export const ACTION_VERBS = [
  'achieved', 'analysed', 'analyzed', 'assessed', 'assisted', 'audited', 'built', 'calculated', 'checked', 'collaborated', 'compiled', 'completed',
  'conducted', 'configured', 'contributed', 'coordinated', 'created', 'delivered', 'designed', 'detailed', 'developed', 'documented', 'drafted',
  'drew', 'estimated', 'evaluated', 'executed', 'fabricated', 'generated', 'identified', 'implemented', 'improved', 'inspected', 'installed',
  'led', 'managed', 'mapped', 'measured', 'modelled', 'modeled', 'monitored', 'optimised', 'optimized', 'organised', 'organized', 'planned',
  'prepared', 'presented', 'produced', 'programmed', 'proposed', 'prototyped', 'rendered', 'reported', 'researched', 'resolved', 'reviewed',
  'revised', 'scheduled', 'simulated', 'sketched', 'streamlined', 'studied', 'supervised', 'supported', 'surveyed', 'tested', 'trained',
  'translated', 'updated', 'verified', 'visualised', 'visualized', 'won', 'wrote',
];

// Openings an ATS reader and a hiring architect both skip.
export const WEAK_STARTS = /^(responsible for|worked on|working on|helped|helping|involved in|was involved|duties included|tasks included|in charge of|handled|did|got|assisted in various)\b/i;
