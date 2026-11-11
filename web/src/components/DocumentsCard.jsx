import { useCallback, useEffect, useRef, useState } from 'react';
import { api, uploadFile } from '../api.js';
import { formatDateTime } from '../format.js';
import { IconX } from '../icons.jsx';
import { useToast } from './Toast.jsx';

// Profile: every file ARCH in Chrome can put into a site's upload box. The CV and portfolio above
// are always there; she adds the rest (another portfolio, certificates, work samples) and says what
// each one is, so ARCH picks the right one for a "COA certificate" or "work samples" box.

const KINDS = [
  ['portfolio', 'Portfolio'],
  ['resume', 'CV'],
  ['cover_letter', 'Cover letter'],
  ['certificate', 'Certificate'],
  ['work_sample', 'Work sample'],
  ['other', 'Other'],
];
const kindLabel = (k) => KINDS.find(([v]) => v === k)?.[1] || 'Other';
const size = (bytes) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`);

// A first guess from the file name; she can change it.
function guessKind(name) {
  const n = name.toLowerCase();
  if (/portfolio/.test(n)) return 'portfolio';
  if (/\bcv\b|resume|résumé/.test(n)) return 'resume';
  if (/cover/.test(n)) return 'cover_letter';
  if (/certificate|marksheet|transcript|\bcoa\b|degree/.test(n)) return 'certificate';
  if (/sample|drawing|render|sheet/.test(n)) return 'work_sample';
  return 'other';
}

export default function DocumentsCard({ refreshKey }) {
  const { toast } = useToast();
  const inputRef = useRef(null);
  const [docs, setDocs] = useState(null);
  const [limits, setLimits] = useState({ maxMb: 25, maxDocs: 20 });
  const [uploading, setUploading] = useState(null);

  const load = useCallback(
    () =>
      api('/documents')
        .then((d) => {
          setDocs(d.documents);
          setLimits(d.limits);
        })
        .catch(() => setDocs([])),
    [],
  );
  useEffect(() => {
    load();
  }, [load, refreshKey]);

  async function add(e) {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    for (const file of files) {
      setUploading({ name: file.name, progress: 0 });
      try {
        const d = await uploadFile('/documents', file, { headers: { 'X-Doc-Kind': guessKind(file.name) }, onProgress: (p) => setUploading({ name: file.name, progress: p }) });
        setDocs(d.documents);
      } catch (err) {
        toast({ message: `${file.name}: ${err.message}`, error: true, duration: 7000 });
      }
    }
    setUploading(null);
  }

  async function update(id, body) {
    try {
      setDocs((await api(`/documents/${id}`, { method: 'PATCH', body })).documents);
    } catch (err) {
      toast({ message: err.message, error: true });
    }
  }

  async function remove(doc) {
    if (!window.confirm(`Remove "${doc.name}" from your files?`)) return;
    try {
      setDocs((await api(`/documents/${doc.id}`, { method: 'DELETE' })).documents);
    } catch (err) {
      toast({ message: err.message, error: true });
    }
  }

  const own = (docs || []).filter((d) => !d.main);
  return (
    <section className="card profile-section documents-card">
      <div className="profile-section-head">
        <h3>Your files for applications</h3>
        <span className="small muted">
          {own.length}/{limits.maxDocs} added
        </span>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        ARCH in Chrome puts these into a site's upload boxes: your CV and portfolio straight away, and any of them when you click <strong>Attach from ArchJobs</strong> next to an upload
        box. Say what each file is, so ARCH picks the right one for a "certificate" or "work samples" box.
      </p>
      {docs === null ? (
        <p className="small muted">Loading…</p>
      ) : (
        <ul className="doc-list">
          {docs.map((d) => (
            <li key={d.id} className="doc-row">
              <span className="doc-type" aria-hidden="true">
                {d.mime === 'application/pdf' ? 'PDF' : d.mime.startsWith('image/') ? 'IMG' : 'DOC'}
              </span>
              <span className="doc-main">
                <a href={`/api/documents/${d.id}/file`} className="doc-name" title={d.name}>
                  {d.name}
                </a>
                <span className="small muted">
                  {d.size ? size(d.size) : ''}
                  {d.uploaded_at ? ` · ${formatDateTime(d.uploaded_at)}` : ''}
                </span>
              </span>
              {d.main ? (
                <span className="chip-static">{kindLabel(d.kind)} · from your Profile</span>
              ) : (
                <>
                  <select className="select select-sm" aria-label={`What ${d.name} is`} value={d.kind} onChange={(e) => update(d.id, { kind: e.target.value })}>
                    {KINDS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="icon-btn" onClick={() => remove(d)} aria-label={`Remove ${d.name}`} title="Remove">
                    <IconX />
                  </button>
                </>
              )}
            </li>
          ))}
          {!docs.length && <li className="small muted">No files yet. Upload your CV and portfolio above, and add more here.</li>}
        </ul>
      )}
      {uploading && (
        <div className="meter" aria-label={`Uploading ${uploading.name}`}>
          <span style={{ width: `${Math.round(uploading.progress * 100)}%` }} />
        </div>
      )}
      <div className="upload-actions">
        <input ref={inputRef} type="file" multiple accept=".pdf,.docx,.jpg,.jpeg,.png,application/pdf,image/png,image/jpeg" hidden onChange={add} />
        <button type="button" className="btn btn-sm" onClick={() => inputRef.current?.click()} disabled={Boolean(uploading) || own.length >= limits.maxDocs}>
          {uploading ? 'Uploading…' : 'Add files'}
        </button>
        <span className="small muted">PDF, Word, JPG or PNG · up to {limits.maxMb} MB each</span>
      </div>
    </section>
  );
}
