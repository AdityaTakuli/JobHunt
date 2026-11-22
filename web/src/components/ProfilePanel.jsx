import { useCallback, useEffect, useRef, useState } from 'react';
import { api, uploadPdf } from '../api.js';
import { useMeta } from '../App.jsx';
import { formatDateTime } from '../format.js';
import { IconAlert, IconCheck, IconExternal, IconFileUser, IconRefresh, IconSparkle, IconX } from '../icons.jsx';
import ChipInput from './ChipInput.jsx';
import DocumentsCard from './DocumentsCard.jsx';
import { ApplicationDetailsCard, ApplicationDetailsDialog } from './ApplicationDetails.jsx';
import { ExtensionCard } from './ExtensionCards.jsx';
import MyCvCard from './MyCvCard.jsx';
import { RowsSkeleton } from './Skeleton.jsx';
import { useToast } from './Toast.jsx';

// The Profile page: a list of sections on the left (three set-up steps, then the tools) and one
// section at a time on the right. Set up: upload a CV and/or portfolio, fill in application
// details, check what the AI read. Then: feedback (portfolio review, gaps against the feed), the
// CV ArchJobs writes and the files for forms, and ARCH in Chrome.

const POLL_MS = 3000;
const RUBRIC = [
  ['range', 'Design range', 'Different kinds and sizes of project'],
  ['process', 'Process shown', 'Sketches, iterations, diagrams, not only final images'],
  ['technical', 'Technical depth', 'Plans, sections, details, working drawings'],
  ['presentation', 'Presentation', 'Layout, hierarchy, legibility'],
  ['concision', 'Concision', 'Page count reviewers like (up to ~35)'],
  ['bim', 'BIM evidence', 'Revit / ArchiCAD work and documentation'],
];
const STAGES = [
  ['student', 'Still studying'],
  ['graduate', 'Graduated, under 2 years of work'],
  ['experienced', '2+ years of work'],
];

const SECTION_IDS = ['files', 'details', 'profile', 'feedback', 'documents', 'arch'];
function sectionFromHash() {
  const asked = window.location.hash.match(/[?&]section=([a-z]+)/)?.[1];
  if (SECTION_IDS.includes(asked)) return asked;
  return /[?&]details=1/.test(window.location.hash) ? 'details' : null;
}

const mb = (bytes) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

function UploadCard({ kind, title, hint, file, limitMb, busy, onUpload, onRemove }) {
  const inputRef = useRef(null);
  const [progress, setProgress] = useState(null);

  async function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setProgress(0);
    try {
      await onUpload(kind, f, setProgress);
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="card upload-card">
      <div className="upload-head">
        <div>
          <h2>{title}</h2>
          <p className="small muted">{hint}</p>
        </div>
        {file && !busy && (
          <button type="button" className="icon-btn" onClick={() => onRemove(kind)} aria-label={`Remove ${title}`} title="Remove">
            <IconX />
          </button>
        )}
      </div>
      {file ? (
        <p className="small upload-file">
          <strong>{file.name}</strong> · {mb(file.size)} · {file.pages} page{file.pages === 1 ? '' : 's'} · uploaded {formatDateTime(file.uploaded_at)}
        </p>
      ) : (
        <p className="small muted">No file yet.</p>
      )}
      {progress != null && (
        <div className="meter" aria-label="Upload progress">
          <span style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      <div className="upload-actions">
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" hidden aria-label={`Upload ${title}`} onChange={pick} />
        <button type="button" className="btn btn-sm" disabled={busy || progress != null} onClick={() => inputRef.current?.click()}>
          {progress != null ? 'Uploading…' : file ? 'Replace PDF' : 'Upload PDF'}
        </button>
        <span className="small muted">Up to {limitMb} MB</span>
      </div>
    </div>
  );
}

function Rubric({ rubric }) {
  return (
    <ul className="rubric">
      {RUBRIC.map(([key, label, hint]) => (
        <li key={key} title={hint}>
          <span className="rubric-label">{label}</span>
          <span className="meter">
            <span style={{ width: `${rubric[key]}%` }} className={rubric[key] >= 70 ? 'is-good' : rubric[key] >= 40 ? 'is-mid' : 'is-low'} />
          </span>
          <span className="rubric-value small">{rubric[key]}</span>
        </li>
      ))}
    </ul>
  );
}

export default function ProfilePanel() {
  const { toast } = useToast();
  const { refreshMeta } = useMeta();
  const [state, setState] = useState(null);
  const [gaps, setGaps] = useState(null);
  const [edits, setEdits] = useState(null); // software, skills, cities, stage, coa while editing
  const [saving, setSaving] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const wasBuilding = useRef(false);
  const askedDetails = useRef(false);
  const [section, setSection] = useState(sectionFromHash);
  const paneHeads = useRef({});
  const railRef = useRef(null);

  // #/profile?section=details opens that section; links from elsewhere in the app use it too.
  useEffect(() => {
    const onHash = () => {
      const asked = sectionFromHash();
      if (asked) setSection(asked);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((id, focus = false) => {
    setSection(id);
    try {
      window.history.replaceState(null, '', `#/profile?section=${id}`);
    } catch {
      // the address just doesn't follow along
    }
    // Moving focus to the section's heading tells a screen reader where it landed, and on phones
    // brings the section into view below the section list.
    if (focus) requestAnimationFrame(() => paneHeads.current[id]?.focus());
  }, []);


  const load = useCallback(() => api('/profile').then(setState).catch((err) => toast({ message: err.message, error: true })), [toast]);
  const loadGaps = useCallback(() => api('/profile/gaps').then(setGaps).catch(() => setGaps(null)), []);

  useEffect(() => {
    load();
  }, [load]);

  // The details form opens by itself when ARCH in Chrome sends her here (#/profile?details=1), and
  // once per visit while the basics most forms need are still missing.
  useEffect(() => {
    if (!state || askedDetails.current) return;
    askedDetails.current = true;
    const fromLink = /[?&]details=1/.test(window.location.hash);
    let seen = false;
    try {
      seen = sessionStorage.getItem('aj-details-asked') === '1';
      sessionStorage.setItem('aj-details-asked', '1');
    } catch {
      // storage blocked: ask anyway
    }
    if (fromLink || (!seen && !state.details_saved && state.details_missing?.length > 0)) setDetailsOpen(true);
  }, [state]);

  // While the AI reads the files, ask every few seconds; when it finishes, say so and refresh.
  const building = state?.status === 'building';
  useEffect(() => {
    if (!building) return undefined;
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [building, load]);
  useEffect(() => {
    if (building) wasBuilding.current = true;
    else if (wasBuilding.current && state) {
      wasBuilding.current = false;
      if (state.status === 'ready') toast({ message: 'Your profile is ready. Jobs now show how well they fit you.', duration: 6000 });
      else if (state.status === 'error') toast({ message: state.error || 'The profile could not be built.', error: true, duration: 8000 });
      refreshMeta();
    }
  }, [building, state, toast, refreshMeta]);
  useEffect(() => {
    if (state?.status === 'ready') loadGaps();
    else setGaps(null);
  }, [state?.status, state?.built_at, loadGaps]);

  const profile = state?.profile;
  useEffect(() => {
    if (profile) {
      setEdits({ software: profile.software.map((s) => s.name), skills: profile.skills, cities: profile.cities, stage: profile.stage, coa: profile.coa, experience_months: profile.experience_months });
    } else setEdits(null);
  }, [profile]);

  async function upload(kind, file, onProgress) {
    try {
      const d = await uploadPdf(`/profile/${kind}`, file, { onProgress });
      setState(d);
      toast({ message: `${kind === 'resume' ? 'CV' : 'Portfolio'} uploaded. Reading it now, this takes a few minutes for a portfolio.`, duration: 6000 });
    } catch (err) {
      toast({ message: err.message, error: true, duration: 8000 });
    }
  }

  async function remove(kind) {
    if (!window.confirm(`Remove your ${kind === 'resume' ? 'CV' : 'portfolio'} from ArchJobs?`)) return;
    try {
      setState(await api(`/profile/${kind}`, { method: 'DELETE' }));
      refreshMeta();
    } catch (err) {
      toast({ message: err.message, error: true });
    }
  }

  async function rebuild() {
    try {
      setState(await api('/profile/build', { method: 'POST' }));
    } catch (err) {
      toast({ message: err.message, error: true, duration: 8000 });
    }
  }

  async function save() {
    setSaving(true);
    try {
      setState(await api('/profile', { method: 'PATCH', body: edits }));
      toast({ message: 'Profile saved.' });
    } catch (err) {
      toast({ message: err.message, error: true });
    } finally {
      setSaving(false);
    }
  }

  // On phones the sections are one sideways row: keep the open one in view.
  const openId = section || null;
  useEffect(() => {
    const rail = railRef.current;
    const item = rail?.querySelector('[aria-current="true"]');
    if (!rail || !item || rail.scrollWidth <= rail.clientWidth) return;
    rail.scrollTo({ left: Math.max(item.offsetLeft - rail.offsetLeft - 16, 0), behavior: 'smooth' });
  }, [openId, state?.status]);

  if (!state) return <RowsSkeleton rows={4} label="Loading your profile" />;
  const set = (k) => (v) => setEdits((e) => ({ ...e, [k]: v }));
  const shown = new Set(profile?.software.filter((s) => s.level === 'shown').map((s) => s.name));
  const dirty =
    edits &&
    profile &&
    (JSON.stringify(edits.software) !== JSON.stringify(profile.software.map((s) => s.name)) ||
      JSON.stringify(edits.skills) !== JSON.stringify(profile.skills) ||
      JSON.stringify(edits.cities) !== JSON.stringify(profile.cities) ||
      edits.stage !== profile.stage ||
      edits.coa !== profile.coa ||
      Number(edits.experience_months) !== profile.experience_months);

  const hasFiles = Boolean(state.resume || state.portfolio);
  const missing = state.details_missing || [];
  const detailsDone = Boolean(state.details_saved) && missing.length === 0;
  const steps = [
    {
      id: 'files',
      label: 'CV & portfolio',
      done: hasFiles && state.status !== 'error',
      note: building
        ? 'Reading…'
        : state.status === 'error'
          ? 'Needs attention'
          : hasFiles
            ? [state.resume && 'CV', state.portfolio && 'Portfolio'].filter(Boolean).join(' + ')
            : 'Start here',
    },
    {
      id: 'details',
      label: 'Application details',
      done: detailsDone,
      note: detailsDone ? 'Done' : missing.length ? `${missing.length} to fill` : 'Not filled',
    },
    {
      id: 'profile',
      label: 'Check your profile',
      done: Boolean(profile),
      note: profile ? 'Ready' : building ? 'Reading…' : 'After upload',
    },
  ];
  const tools = [
    {
      id: 'feedback',
      label: 'Feedback',
      Icon: IconSparkle,
      note: gaps?.jobs ? `${gaps.verdicts.strong} strong fits` : profile ? '' : 'After upload',
    },
    { id: 'documents', label: 'CV & documents', Icon: IconFileUser, note: '' },
    { id: 'arch', label: 'ARCH in Chrome', Icon: IconExternal, note: '' },
  ];
  const doneCount = steps.filter((st) => st.done).length;
  const current = section || steps.find((st) => !st.done)?.id || 'profile';
  const toFiles = (
    <button type="button" className="btn btn-primary btn-sm" onClick={() => go('files')}>
      Upload a CV or portfolio
    </button>
  );

  const navItem = (item, marker) => (
    <li key={item.id}>
      <button type="button" className="pnav-item" aria-current={current === item.id ? 'true' : undefined} onClick={() => go(item.id, true)}>
        {marker}
        <span className="pnav-text">
          <span className="pnav-label">{item.label}</span>
          {item.note && <span className="pnav-note">{item.note}</span>}
        </span>
      </button>
    </li>
  );

  const pane = (id, title, description, children) => (
    <section key={id} className="ppane" aria-labelledby={`ppane-${id}`} hidden={current !== id}>
      <header className="ppane-head">
        <h2 id={`ppane-${id}`} tabIndex={-1} ref={(el) => (paneHeads.current[id] = el)}>
          {title}
        </h2>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );

  return (
    <div className="profile-panel">
      {!state.available && (
        <p className="form-error" role="alert" aria-live="assertive">
          Profile reading is not set up on this server: the AI gateway is not configured.
        </p>
      )}
      {building && (
        <p className="profile-status" role="status" aria-live="polite">
          <span className="ai-pulse" aria-hidden="true" /> {state.step || 'Reading'}… You can keep working: the page updates when it's done.
        </p>
      )}
      {state.status === 'error' && (
        <p className="form-error profile-error" role="alert" aria-live="assertive">
          <IconAlert size={16} /> {state.error}{' '}
          <button type="button" className="btn btn-sm" onClick={rebuild} disabled={!state.available}>
            Read again
          </button>
        </p>
      )}

      <div className="profile-shell">
        <nav className="pnav" aria-label="Profile sections">
          <div className="pnav-progress">
            <span className="pnav-group">Set up</span>
            <span className="pnav-count">
              {doneCount} of {steps.length} done
            </span>
            <span className="scale-bar" aria-hidden="true">
              {steps.map((st) => (
                <span key={st.id} className={st.done ? 'is-on' : ''} />
              ))}
            </span>
          </div>
          <div className="pnav-rail" ref={railRef}>
          <ol className="pnav-list">
            {steps.map((st, i) =>
              navItem(
                st,
                <span className={`pnav-mark${st.done ? ' is-done' : ''}`} aria-hidden="true">
                  {st.done ? <IconCheck size={14} /> : i + 1}
                </span>,
              ),
            )}
          </ol>
          <span className="pnav-group pnav-group-2">Use it</span>
          <ul className="pnav-list">
            {tools.map((t) =>
              navItem(
                t,
                <span className="pnav-mark is-tool" aria-hidden="true">
                  <t.Icon size={15} />
                </span>,
              ),
            )}
          </ul>
          </div>
        </nav>

        <div className="ppanes">
          {pane(
            'files',
            'CV & portfolio',
            'Upload your CV, your portfolio, or both, as PDFs. The AI reads them once into a profile, and every job gets a fit score against it. A portfolio alone is fine: ArchJobs writes a CV from it. Your files stay private to you.',
            <>
              <div className="upload-grid">
                <UploadCard
                  kind="resume"
                  title="CV / resume"
                  hint="A text PDF, not a scan: education, internships, software, projects."
                  file={state.resume}
                  limitMb={state.limits.resumeMb}
                  busy={building}
                  onUpload={upload}
                  onRemove={remove}
                />
                <UploadCard
                  kind="portfolio"
                  title="Portfolio"
                  hint={`Portfolio, project report or work samples as one PDF. The first ${state.limits.portfolioPages} pages are read; export at screen quality to keep it small.`}
                  file={state.portfolio}
                  limitMb={state.limits.portfolioMb}
                  busy={building}
                  onUpload={upload}
                  onRemove={remove}
                />
              </div>
              {state.warnings?.length > 0 && !building && (
                <div className="card profile-warnings">
                  <ul className="small muted">
                    {state.warnings.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  {state.warnings.some((w) => /could not be read/.test(w)) && state.status !== 'error' && (
                    <p className="small">
                      The AI was busy. Pages already read are kept, so reading again only sends the missing ones.{' '}
                      <button type="button" className="btn btn-sm" onClick={rebuild} disabled={!state.available}>
                        Read the missing pages
                      </button>
                    </p>
                  )}
                </div>
              )}
              <p className="ppane-foot">
                {state.builds_today} of {state.limits.buildsPerDay} reads used {state.reads_period === 'week' ? 'this week' : 'today'}.
                {hasFiles && !detailsDone && (
                  <>
                    {' '}
                    Next:{' '}
                    <button type="button" className="link-btn" onClick={() => go('details', true)}>
                      fill in your application details
                    </button>
                  </>
                )}
              </p>
            </>,
          )}

          {pane(
            'details',
            'Application details',
            'Name, contact, address, college, marks, pay and notice period: what application forms ask for. ARCH in Chrome fills forms from these.',
            <ApplicationDetailsCard state={state} onOpen={() => setDetailsOpen(true)} hideTitle />,
          )}

          {pane(
            'profile',
            'Check your profile',
            'What the AI read from your files. Correct anything it got wrong: the fit score on every job uses this.',
            profile && edits ? (
              <section className="card profile-section">
                <div className="profile-section-head">
                  <span className="small muted">
                    Read {formatDateTime(state.built_at)} · {state.model}
                  </span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={rebuild} disabled={building || !state.available} title="Read the files again">
                    <IconRefresh size={14} /> Read again
                  </button>
                </div>
                {profile.summary && <p>{profile.summary}</p>}
                <div className="profile-grid">
                  <label className="field">
                    <span>Where you are</span>
                    <select className="select" value={edits.stage} onChange={(e) => set('stage')(e.target.value)}>
                      {STAGES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Months of work or internship</span>
                    <input className="input" type="number" min="0" max="600" value={edits.experience_months} onChange={(e) => set('experience_months')(e.target.value)} />
                  </label>
                  <label className="field field-check">
                    <input type="checkbox" checked={edits.coa} onChange={(e) => set('coa')(e.target.checked)} />
                    <span>Registered with the Council of Architecture</span>
                  </label>
                </div>
                <div className="field">
                  <span className="field-label">
                    Software <small className="muted">· tools seen in the portfolio are marked</small>
                  </span>
                  <ChipInput
                    id="profile-software"
                    label="Software"
                    value={edits.software}
                    onChange={set('software')}
                    placeholder="Revit, AutoCAD, SketchUp…"
                    addLabel="Add a tool"
                    max={30}
                    maxLength={40}
                  />
                  {shown.size > 0 && (
                    <p className="small muted" style={{ margin: '4px 0 0' }}>
                      Shown in portfolio: {[...shown].join(', ')}
                    </p>
                  )}
                </div>
                <div className="field">
                  <span className="field-label">Skills</span>
                  <ChipInput
                    id="profile-skills"
                    label="Skills"
                    value={edits.skills}
                    onChange={set('skills')}
                    placeholder="Working drawings, detailing…"
                    addLabel="Add a skill"
                    max={25}
                    maxLength={80}
                  />
                </div>
                <div className="field">
                  <span className="field-label">Cities you can work in</span>
                  <ChipInput
                    id="profile-cities"
                    label="Cities you can work in"
                    value={edits.cities}
                    onChange={set('cities')}
                    placeholder="Bengaluru, Remote…"
                    addLabel="Add a city"
                    max={8}
                    maxLength={60}
                  />
                </div>
                {(profile.typologies.length > 0 || profile.education.length > 0 || profile.experience.length > 0 || profile.projects.length > 0) && (
                  <dl className="profile-facts small">
                    {profile.typologies.length > 0 && (
                      <div>
                        <dt>Kinds of project</dt>
                        <dd>{profile.typologies.join(', ')}</dd>
                      </div>
                    )}
                    {profile.education.length > 0 && (
                      <div>
                        <dt>Education</dt>
                        <dd>{profile.education.map((e) => `${e.degree}${e.institution ? `, ${e.institution}` : ''}${e.year ? ` (${e.year})` : ''}`).join(' · ')}</dd>
                      </div>
                    )}
                    {profile.experience.length > 0 && (
                      <div>
                        <dt>Experience</dt>
                        <dd>{profile.experience.map((e) => `${e.role}${e.firm ? ` at ${e.firm}` : ''}${e.months ? `, ${e.months} mo` : ''}`).join(' · ')}</dd>
                      </div>
                    )}
                    {profile.projects.length > 0 && (
                      <div>
                        <dt>Projects on the CV</dt>
                        <dd>{profile.projects.map((p) => `${p.title}${p.typology ? ` (${p.typology})` : ''}`).join(' · ')}</dd>
                      </div>
                    )}
                  </dl>
                )}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || saving}>
                    {saving ? 'Saving…' : dirty ? 'Save corrections' : 'Saved'}
                  </button>
                </div>
              </section>
            ) : (
              <div className="card ppane-empty">
                <p>
                  {building
                    ? 'The AI is reading your files. Your profile shows here when it is done.'
                    : 'Upload a CV or portfolio first. The AI reads it into a profile you can check and correct here.'}
                </p>
                {!building && toFiles}
              </div>
            ),
          )}

          {pane(
            'feedback',
            'Feedback',
            'How your portfolio reads to a reviewer, and what the open roles ask for that your profile lacks.',
            profile ? (
              <>
                {profile.portfolio ? (
                  <section className="card profile-section">
                    <h3 className="ppane-sub">Portfolio review</h3>
                    <p className="small muted" style={{ marginTop: 0 }}>
                      {profile.portfolio.read_pages} of {profile.portfolio.pages} pages read · projects seen: {profile.portfolio.projects.join(', ') || '—'} · drawings:{' '}
                      {profile.portfolio.drawing_types.join(', ') || '—'}
                    </p>
                    {profile.portfolio.rubric && <Rubric rubric={profile.portfolio.rubric} />}
                    {profile.portfolio.summary && <p>{profile.portfolio.summary}</p>}
                    <div className="review-grid">
                      {profile.portfolio.strengths.length > 0 && (
                        <div>
                          <h4>Strengths</h4>
                          <ul className="small">
                            {profile.portfolio.strengths.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {profile.portfolio.weaknesses.length > 0 && (
                        <div>
                          <h4>What a reviewer would miss</h4>
                          <ul className="small">
                            {profile.portfolio.weaknesses.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {profile.portfolio.improvements.length > 0 && (
                        <div>
                          <h4>Do first</h4>
                          <ol className="small">
                            {profile.portfolio.improvements.map((x) => (
                              <li key={x}>{x}</li>
                            ))}
                          </ol>
                        </div>
                      )}
                    </div>
                    {profile.portfolio.best_for.length > 0 && (
                      <p className="small">
                        <strong>Best suited to:</strong> {profile.portfolio.best_for.join(', ')}
                      </p>
                    )}
                  </section>
                ) : (
                  <div className="card ppane-empty">
                    <p>Upload a portfolio to get a review: range, process, technical depth, presentation and BIM evidence, scored.</p>
                    <button type="button" className="btn btn-sm" onClick={() => go('files', true)}>
                      Upload a portfolio
                    </button>
                  </div>
                )}

                {gaps && gaps.jobs > 0 && (
                  <section className="card profile-section">
                    <h3 className="ppane-sub">Against the current feed</h3>
                    <p className="small muted" style={{ marginTop: 0 }}>
                      Of {gaps.jobs} open roles: <strong>{gaps.verdicts.strong}</strong> strong fit, <strong>{gaps.verdicts.possible}</strong> possible,{' '}
                      <strong>{gaps.verdicts.stretch}</strong> a stretch. <a href="#/jobs">Sort the feed by best fit →</a>
                    </p>
                    {gaps.gaps.length > 0 ? (
                      <>
                        <p className="small" style={{ fontWeight: 600 }}>
                          What roles ask for that your profile lacks, most common first
                        </p>
                        <ul className="gap-list">
                          {gaps.gaps.map((g) => (
                            <li key={g.label}>
                              <div className="gap-head">
                                <strong>{g.label}</strong>
                                <span className="small muted">
                                  {g.jobs} role{g.jobs === 1 ? '' : 's'}
                                  {g.required ? ` · required by ${g.required}` : ''}
                                </span>
                              </div>
                              {g.tip && <p className="small">{g.tip}</p>}
                              <p className="small muted">e.g. {g.examples.map((e) => `${e.title}${e.company ? ` (${e.company})` : ''}`).join(', ')}</p>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="small">Nothing the open roles ask for is missing from your profile.</p>
                    )}
                  </section>
                )}
              </>
            ) : (
              <div className="card ppane-empty">
                <p>Feedback appears once the AI has read your CV or portfolio.</p>
                {!building && toFiles}
              </div>
            ),
          )}

          {pane(
            'documents',
            'CV & documents',
            'The CV ArchJobs writes for you, and the files ARCH in Chrome attaches to application forms.',
            <>
              <MyCvCard hasResume={Boolean(state.resume)} ready={state.status === 'ready' || Boolean(profile)} />
              <DocumentsCard refreshKey={`${state.resume?.uploaded_at || ''}${state.portfolio?.uploaded_at || ''}`} />
            </>,
          )}

          {pane(
            'arch',
            'ARCH in Chrome',
            'Fills a job application when you ask it to: press Fill with ARCH on the form, or Alt+Shift+A. It never fills other sites by itself and never presses submit.',
            <ExtensionCard fillsToday={state.fills_today} fillsPerDay={state.fills_per_day} weekly={state.fills_period === 'week'} hideHead />,
          )}
        </div>
      </div>

      <ApplicationDetailsDialog open={detailsOpen} onClose={() => setDetailsOpen(false)} state={state} onSaved={setState} />
    </div>
  );
}
