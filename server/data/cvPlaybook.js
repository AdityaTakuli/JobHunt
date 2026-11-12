// The CV playbook: short before/after examples of the writing an ATS and a hiring reader both
// reward, for each field. lib/atsPlaybook.js picks the few closest to a person and a posting and
// puts them in the CV prompt as a style guide, so any model (free ones too) copies the pattern:
// action verb + what + tool or method + deliverable/result, in the posting's own words.
// Every person, firm and number here is invented: the prompt says examples are style only, and the
// CV checks (lib/tailor.js) drop anything that isn't in the person's own files anyway.
// Seeded into the cv_examples table (server/db/migrate.js); rows added there join these.
//
// kind: bullet | project | summary. tags: ATS term labels the example is about (for picking).

const E = (key, kind, disciplines, tags, before, after, note = '') => ({ key, kind, disciplines, tags, before, after, note });

export const CV_EXAMPLES = [
  // ---- Architecture ----
  E('arch-wd', 'bullet', ['architecture'], ['Working drawings', 'Revit', 'Detailing'],
    'Made drawings in Revit for a house.',
    'Prepared working drawings, door and window schedules and wall-section details for a residential villa in Revit, issued for construction.',
    'Name the drawing types and what they were for, not just the tool.'),
  E('arch-render', 'bullet', ['architecture', 'interiors'], ['Rendering', 'Lumion', 'Enscape', 'SketchUp'],
    'Did renders for client presentation.',
    'Modelled the scheme in SketchUp and produced day and dusk renders in Lumion for the client design-review presentation.'),
  E('arch-site', 'bullet', ['architecture', 'interiors', 'civil'], ['Site visits', 'Coordination', 'MEP coordination'],
    'Went for site visits.',
    'Conducted weekly site visits to check work against the drawings and recorded issues for coordination with the structural and MEP consultants.'),
  E('arch-approval', 'bullet', ['architecture'], ['Approval drawings', 'Building bye-laws', 'AutoCAD'],
    'Worked on municipal drawings.',
    'Drafted municipal approval drawings in AutoCAD and checked setbacks, FAR and parking against the local building bye-laws.'),
  E('arch-bim', 'bullet', ['architecture'], ['Building Information Modelling', 'BIM modelling', 'Revit families', 'Clash detection'],
    'Responsible for BIM work.',
    'Built the BIM model to LOD 300 in Revit, created parametric door and furniture families, and ran clash checks in Navisworks before each issue.'),
  E('arch-energy', 'bullet', ['architecture'], ['Energy modelling', 'NatHERS', 'FirstRate5'],
    'Helped with energy ratings.',
    'Built thermal models in FirstRate5 from architectural drawings, covering glazing, shading, orientation and zoning, to support NatHERS energy ratings.'),
  E('arch-heritage', 'bullet', ['architecture'], ['Heritage documentation', 'Site analysis'],
    'Did documentation of an old building.',
    'Recorded the plans, elevations, construction details and materials of a heritage haveli through measured drawings and photographic survey.'),
  E('arch-thesis', 'project', ['architecture'], ['Site analysis', 'Concept design', 'Sustainable design'],
    'Thesis: research centre. Did site study and design.',
    'Agro research campus (thesis) | Conducted site analysis, case studies and space programming, then developed zoning, circulation and a passive-design strategy for a low-rise institutional campus.'),
  E('arch-housing', 'project', ['architecture'], ['Urban design', 'Master plan', 'Presentation drawings'],
    'Group housing project with towers.',
    'High-rise group housing (group project) | Developed the masterplan around a central green, prepared unit and cluster plans, massing and skyline studies, and the presentation sheets.'),
  E('arch-summary', 'summary', ['architecture'], ['Revit', 'Working drawings', 'Rendering'],
    'Hard-working and passionate architecture student looking for an opportunity to grow.',
    'Final-year B.Arch student with internship experience in Revit working drawings and site coordination on residential projects. Skilled in AutoCAD, SketchUp and Lumion, with a portfolio spanning housing, an institutional campus and heritage documentation. Seeking an architecture or BIM internship.'),

  // ---- Interiors ----
  E('int-joinery', 'bullet', ['interiors'], ['Joinery details', 'Furniture design', 'AutoCAD'],
    'Made furniture drawings.',
    'Detailed wardrobes, kitchen units and a reception desk in AutoCAD with joinery sections, hardware and finish schedules for the workshop.'),
  E('int-materials', 'bullet', ['interiors'], ['Material selection', 'Mood boards', 'Client presentations'],
    'Selected materials with the client.',
    'Prepared mood boards and material palettes for three apartment interiors and presented finish options in client meetings.'),
  E('int-boq', 'bullet', ['interiors', 'architecture'], ['Estimation and costing', 'BOQ / estimation', 'Excel'],
    'Did BOQ in Excel.',
    'Prepared bills of quantities and cost estimates in Excel for a café fit-out and tracked vendor quotations against the budget.'),
  E('int-summary', 'summary', ['interiors'], ['Interior design', 'SketchUp', 'Joinery details'],
    'Creative interior designer with good skills.',
    'Interior design graduate with studio experience in residential and café fit-outs, from mood boards and SketchUp visualisation to joinery details and BOQs. Seeking a junior interior designer role.'),

  // ---- Civil ----
  E('civ-staad', 'bullet', ['civil'], ['STAAD.Pro', 'Structural analysis', 'RCC design', 'IS 456'],
    'Did analysis of a building in STAAD.',
    'Modelled and analysed a G+4 RCC frame in STAAD.Pro for dead, live and seismic loads, and designed beams and columns to IS 456.'),
  E('civ-etabs', 'bullet', ['civil'], ['ETABS', 'IS 1893', 'Structural analysis'],
    'Used ETABS in internship.',
    'Ran response-spectrum analysis of a residential tower in ETABS to IS 1893 and checked storey drift and base shear.'),
  E('civ-site', 'bullet', ['civil'], ['Site execution', 'Quality control', 'Bar bending schedule'],
    'Site engineer work at a building site.',
    'Supervised slab and column casting, checked reinforcement against the bar bending schedule, and kept the daily quality-control records.'),
  E('civ-qs', 'bullet', ['civil'], ['Quantity surveying', 'Estimation and costing', 'Billing'],
    'Calculated quantities.',
    'Took off concrete, steel and masonry quantities from drawings and prepared rate analysis and RA bills for the contractor.'),
  E('civ-planning', 'bullet', ['civil', 'architecture'], ['Primavera P6', 'MS Project', 'Project planning'],
    'Made a schedule for the project.',
    'Built the construction schedule in Primavera P6 with activity links and resources, and updated progress against the baseline each week.'),
  E('civ-survey', 'bullet', ['civil'], ['Surveying', 'Total station', 'AutoCAD Civil 3D'],
    'Did survey work.',
    'Surveyed a road alignment with a total station and produced the contour plan and longitudinal section in AutoCAD Civil 3D.'),
  E('civ-project', 'project', ['civil'], ['Structural analysis', 'STAAD.Pro', 'Foundation design'],
    'Final year project on a building design.',
    'Design of a G+3 school building (final-year project) | Analysed the frame in STAAD.Pro, designed slabs, beams, columns and isolated footings, and prepared structural drawings.'),
  E('civ-summary', 'summary', ['civil'], ['STAAD.Pro', 'Site execution', 'AutoCAD'],
    'Dedicated civil engineer seeking a challenging role.',
    'B.Tech Civil graduate with site-execution experience on residential buildings and structural analysis in STAAD.Pro and ETABS. Skilled in AutoCAD, quantity take-off and bar bending schedules. Seeking a site engineer or structural design role.'),

  // ---- Mechanical ----
  E('mech-cad', 'bullet', ['mechanical'], ['SolidWorks', '3D CAD modelling', 'GD&T'],
    'Made parts in SolidWorks.',
    'Modelled a gearbox housing and its assembly in SolidWorks and released manufacturing drawings with GD&T callouts.'),
  E('mech-fea', 'bullet', ['mechanical'], ['FEA', 'ANSYS'],
    'Did analysis in ANSYS.',
    'Ran static FEA of a mounting bracket in ANSYS, identified the high-stress fillet and revised the geometry to meet the safety factor.'),
  E('mech-hvac', 'bullet', ['mechanical'], ['HVAC design', 'HAP', 'AutoCAD'],
    'Worked on HVAC design.',
    'Calculated heat loads for an office floor in HAP and drew the duct layout and equipment schedule in AutoCAD.'),
  E('mech-mfg', 'bullet', ['mechanical'], ['Manufacturing processes', 'Quality control', 'Lean manufacturing'],
    'Training in a manufacturing plant.',
    'Studied the machining line in a plant internship, mapped cycle times and proposed 5S changes that the shop floor adopted.'),
  E('mech-project', 'project', ['mechanical'], ['Product design', 'CATIA', 'CFD'],
    'Final year project on a vehicle part.',
    'Design of a formula-student intake manifold (team project) | Modelled the manifold in CATIA, compared runner lengths with CFD in ANSYS Fluent and prototyped the chosen design.'),
  E('mech-summary', 'summary', ['mechanical'], ['SolidWorks', 'ANSYS', 'Product design'],
    'Mechanical engineer with passion for machines.',
    'B.Tech Mechanical graduate with internship experience in product design, 3D CAD modelling in SolidWorks and FEA in ANSYS. Familiar with GD&T and manufacturing drawings. Seeking a design engineer or graduate engineer trainee role.'),

  // ---- Electrical ----
  E('elec-design', 'bullet', ['electrical'], ['Electrical design', 'AutoCAD Electrical', 'DIALux'],
    'Worked on electrical layouts.',
    'Prepared lighting and power layouts and the single line diagram for a commercial floor in AutoCAD Electrical, with lux levels checked in DIALux.'),

  // ---- Planning ----
  E('plan-gis', 'bullet', ['planning', 'civil'], ['GIS', 'QGIS', 'Land use planning'],
    'Made maps in GIS.',
    'Mapped existing land use and densities for a ward in QGIS and prepared the analysis sheets for the draft development plan.'),

  // ---- Any field ----
  E('any-research', 'bullet', ['all'], ['Research', 'Technical documentation'],
    'Did research for a project.',
    'Researched three comparable case studies and summarised the findings in a design brief used to set the project programme.'),
  E('any-coord', 'bullet', ['all'], ['Coordination', 'Client presentations'],
    'Communicated with the team.',
    'Coordinated drawing issues between the design team and three consultants, and kept the meeting minutes and action log.'),
  E('any-cert', 'bullet', ['all'], ['Autodesk Certified Professional'],
    'Revit course from Udemy.',
    'Autodesk Revit - Beginner to Advanced | Udemy | 2025',
    'Certifications: Name | Issuer | hours or date.'),
];
