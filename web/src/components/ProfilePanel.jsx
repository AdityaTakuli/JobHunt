import { useCallback, useEffect, useRef, useState } from 'react';
import { api, uploadPdf } from '../api.js';
import { useMeta } from '../App.jsx';
import { formatDateTime } from '../format.js';
import { IconAlert, IconRefresh, IconX } from '../icons.jsx';
import ChipInput from './ChipInput.jsx';
import DocumentsCard from './DocumentsCard.jsx';
import { ApplicationDetailsCard, ApplicationDetailsDialog } from './ApplicationDetails.jsx';
import { ExtensionCard } from './ExtensionCards.jsx';
import MyCvCard from './MyCvCard.jsx';
import { RowsSkeleton } from './Skeleton.jsx';
import { useToast } from './Toast.jsx';

// Settings → Profile: upload a CV and/or a portfolio PDF, watch the AI read them, correct what it
// found, and see the portfolio review and the gaps against the current job feed.

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

  return (
    <div className="profile-panel">
      {!state.available && (
        <p className="form-error" role="alert">
          Profile reading is not set up on this server: the AI gateway is not configured.
        </p>
      )}
      <p className="small muted" style={{ marginTop: 0 }}>
        Any field of study (architecture, interiors, civil, mechanical…): upload your CV, your portfolio, or both. Only a portfolio is fine too: ArchJobs writes a CV from it. The AI reads them once into a profile (software, skills, projects, what your portfolio shows), and every job then gets a fit score against it:
        the ranking a hiring system does, shown openly. Your files stay private to you. {state.builds_today}/{state.limits.buildsPerDay} reads used today.
      </p>

      {building && (
        <p className="profile-status" role="status" aria-live="polite">
          <span className="ai-pulse" aria-hidden="true" /> {state.step || 'Reading'}…
        </p>
      )}
      {state.status === 'error' && (
        <p className="form-error" role="alert">
          <IconAlert size={16} /> {state.error}{' '}
          <button type="button" className="btn btn-sm" onClick={rebuild} disabled={!state.available}>
            Read again
          </button>
        </p>
      )}
      {state.warnings?.length > 0 && !building && (
        <div className="profile-warnings">
          <ul className="small muted">
            {state.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          {state.warnings.some((w) => /could not be read/.test(w)) && state.status !== 'error' && (
            <p className="small">
              The AI gateway was busy. Pages already read are kept, so reading again only sends the missing ones.{' '}
              <button type="button" className="btn btn-sm" onClick={rebuild} disabled={!state.available}>
                Read the missing pages
              </button>
            </p>
          )}
        </div>
      )}

      <div className={`profile-layout${profile && edits ? ' has-side' : ''}`}>
        <div className="profile-col">
          <div className="upload-grid">
            <UploadCard kind="resume" title="CV / resume" hint="A text PDF (not a scan): education, internships, software, projects. Optional if you upload a portfolio." file={state.resume} limitMb={state.limits.resumeMb} busy={building} onUpload={upload} onRemove={remove} />
            <UploadCard
              kind="portfolio"
              title="Portfolio"
              hint={`Your portfolio, project report or work samples as one PDF. The first ${state.limits.portfolioPages} pages are read as images; export at screen quality to keep it small.`}
              file={state.portfolio}
              limitMb={state.limits.portfolioMb}
              busy={building}
              onUpload={upload}
              onRemove={remove}
            />
          </div>

          <ApplicationDetailsCard state={state} onOpen={() => setDetailsOpen(true)} />
          <ApplicationDetailsDialog open={detailsOpen} onClose={() => setDetailsOpen(false)} state={state} onSaved={setState} />
          <MyCvCard hasResume={Boolean(state.resume)} ready={state.status === 'ready' || Boolean(profile)} />

          <DocumentsCard refreshKey={`${state.resume?.uploaded_at || ''}${state.portfolio?.uploaded_at || ''}`} />
          <ExtensionCard fillsToday={state.fills_today} fillsPerDay={state.fills_per_day} />
        </div>

        <div className="profile-col">
          {profile && edits && (
            <>
              <section className="card profile-section">
                <div className="profile-section-head">
                  <h2>What the AI read</h2>
                  <span className="small muted">
                    Built {formatDateTime(state.built_at)} · {state.model}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={rebuild} disabled={building || !state.available} title="Read the files again">
                      <IconRefresh size={14} /> Read again
                    </button>
                  </span>
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
                  <ChipInput id="profile-software" label="Software" value={edits.software} onChange={set('software')} placeholder="Revit, AutoCAD, SketchUp…" addLabel="Add a tool" max={30} maxLength={40} />
                  {shown.size > 0 && (
                    <p className="small muted" style={{ margin: '4px 0 0' }}>
                      Shown in portfolio: {[...shown].join(', ')}
                    </p>
                  )}
                </div>
                <div className="field">
                  <span className="field-label">Skills</span>
                  <ChipInput id="profile-skills" label="Skills" value={edits.skills} onChange={set('skills')} placeholder="Working drawings, detailing…" addLabel="Add a skill" max={25} maxLength={80} />
                </div>
                <div className="field">
                  <span className="field-label">Cities you can work in</span>
                  <ChipInput id="profile-cities" label="Cities you can work in" value={edits.cities} onChange={set('cities')} placeholder="Bengaluru, Remote…" addLabel="Add a city" max={8} maxLength={60} />
                </div>
                {profile.typologies.length > 0 && (
                  <p className="small">
                    <strong>Kinds of project:</strong> {profile.typologies.join(', ')}
                  </p>
                )}
                {profile.education.length > 0 && (
                  <p className="small">
                    <strong>Education:</strong> {profile.education.map((e) => `${e.degree}${e.institution ? `, ${e.institution}` : ''}${e.year ? ` (${e.year})` : ''}`).join(' · ')}
                  </p>
                )}
                {profile.experience.length > 0 && (
                  <p className="small">
                    <strong>Experience:</strong> {profile.experience.map((e) => `${e.role}${e.firm ? ` at ${e.firm}` : ''}${e.months ? `, ${e.months} mo` : ''}`).join(' · ')}
                  </p>
                )}
                {profile.projects.length > 0 && (
                  <p className="small">
                    <strong>Projects on the CV:</strong> {profile.projects.map((p) => `${p.title}${p.typology ? ` (${p.typology})` : ''}`).join(' · ')}
                  </p>
                )}
                <div className="dialog-actions">
                  <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={!dirty || saving}>
                    {saving ? 'Saving…' : 'Save corrections'}
                  </button>
                </div>
              </section>

              {profile.portfolio && (
                <section className="card profile-section">
                  <h2>Portfolio review</h2>
                  <p className="small muted" style={{ marginTop: 0 }}>
                    {profile.portfolio.read_pages} of {profile.portfolio.pages} pages read · projects seen: {profile.portfolio.projects.join(', ') || '—'} · drawings: {profile.portfolio.drawing_types.join(', ') || '—'}
                  </p>
                  {profile.portfolio.rubric && <Rubric rubric={profile.portfolio.rubric} />}
                  {profile.portfolio.summary && <p>{profile.portfolio.summary}</p>}
                  <div className="review-grid">
                    {profile.portfolio.strengths.length > 0 && (
                      <div>
                        <h3>Strengths</h3>
                        <ul className="small">
                          {profile.portfolio.strengths.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {profile.portfolio.weaknesses.length > 0 && (
                      <div>
                        <h3>What a reviewer would miss</h3>
                        <ul className="small">
                          {profile.portfolio.weaknesses.map((s) => (
                            <li key={s}>{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {profile.portfolio.improvements.length > 0 && (
                      <div>
                        <h3>Do first</h3>
                        <ol className="small">
                          {profile.portfolio.improvements.map((s) => (
                            <li key={s}>{s}</li>
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
              )}

              {gaps && gaps.jobs > 0 && (
                <section className="card profile-section">
                  <h2>Against the current feed</h2>
                  <p className="small muted" style={{ marginTop: 0 }}>
                    Of {gaps.jobs} open roles: <strong>{gaps.verdicts.strong}</strong> strong fit, <strong>{gaps.verdicts.possible}</strong> possible, <strong>{gaps.verdicts.stretch}</strong> a stretch.{' '}
                    <a href="#/jobs">Sort the feed by best fit →</a>
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
                            <p className="small muted">
                              e.g. {g.examples.map((e) => `${e.title}${e.company ? ` (${e.company})` : ''}`).join(', ')}
                            </p>
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
          )}
        </div>
      </div>
    </div>
  );
}
