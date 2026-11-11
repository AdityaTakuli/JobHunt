// Her document library: the files ARCH in Chrome can drop into a site's upload box. The CV and the
// portfolio read on the Profile page are always in it; she can add more (another portfolio version,
// certificates, work samples, a reference letter). Stored outside the web root, only hers.

import fs from 'node:fs/promises';
import path from 'node:path';
import express, { Router } from 'express';
import { query } from '../db/pool.js';
import { getRow, profileDir, readFile } from '../lib/profileStore.js';

export const documentsRouter = Router();

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_DOCS = 20;
export const DOC_KINDS = ['portfolio', 'resume', 'cover_letter', 'certificate', 'work_sample', 'other'];

// What a file really is, from its first bytes (the name and the browser's type can lie).
export function sniff(buffer) {
  const b = buffer.subarray(0, 8);
  if (b.toString('latin1', 0, 5) === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { mime: 'image/png', ext: '.png' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  // .docx is a zip; anything else zipped is refused.
  if (b[0] === 0x50 && b[1] === 0x4b && buffer.includes(Buffer.from('word/'))) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' };
  return null;
}

const docsDir = (uid) => path.join(profileDir(uid), 'docs');
const docPath = (uid, id, ext) => path.join(docsDir(uid), `${Number(id)}${ext}`);
const EXT = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx' };

const cleanName = (raw, fallback) => {
  let name = String(raw || '');
  try {
    name = decodeURIComponent(name);
  } catch {
    // not encoded
  }
  return name.replace(/[^\p{L}\p{N} .()_-]+/gu, '_').trim().slice(0, 200) || fallback;
};

/**
 * Everything she can attach: the profile's CV and portfolio first, then her own uploads.
 * ids: 'resume' / 'portfolio' for the profile files, numbers for library files.
 */
export async function listDocuments(uid) {
  const out = [];
  const row = await getRow(uid);
  if (row?.resume_uploaded_at) out.push({ id: 'resume', kind: 'resume', name: row.resume_name || 'CV.pdf', size: row.resume_size, mime: 'application/pdf', main: true, uploaded_at: row.resume_uploaded_at });
  if (row?.portfolio_uploaded_at) out.push({ id: 'portfolio', kind: 'portfolio', name: row.portfolio_name || 'Portfolio.pdf', size: row.portfolio_size, mime: 'application/pdf', main: true, uploaded_at: row.portfolio_uploaded_at });
  for (const d of await query('SELECT id, kind, name, size, mime, uploaded_at FROM user_documents WHERE user_id = ? ORDER BY uploaded_at DESC', [uid])) out.push({ ...d, main: false });
  return out;
}

export async function readDocument(uid, id) {
  if (id === 'resume' || id === 'portfolio') {
    const row = await getRow(uid);
    const buffer = await readFile(uid, id);
    return buffer ? { buffer, name: row?.[`${id}_name`] || `${id}.pdf`, mime: 'application/pdf' } : null;
  }
  if (!/^\d{1,10}$/.test(String(id))) return null;
  const [d] = await query('SELECT id, name, mime FROM user_documents WHERE id = ? AND user_id = ?', [Number(id), uid]);
  if (!d) return null;
  try {
    return { buffer: await fs.readFile(docPath(uid, d.id, EXT[d.mime] || '')), name: d.name, mime: d.mime };
  } catch {
    return null;
  }
}

documentsRouter.get('/', async (req, res) => {
  res.json({ documents: await listDocuments(req.user.id), limits: { maxMb: MAX_BYTES / 1024 / 1024, maxDocs: MAX_DOCS }, kinds: DOC_KINDS });
});

// The file is the request body; its name in X-File-Name, what it is in X-Doc-Kind.
documentsRouter.put('/', express.raw({ type: () => true, limit: MAX_BYTES + 1024 }), async (req, res) => {
  const uid = req.user.id;
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer) || !buffer.length) return res.status(400).json({ error: 'Send the file as the request body.' });
  if (buffer.length > MAX_BYTES) return res.status(413).json({ error: 'Files must be under 25 MB.' });
  const type = sniff(buffer);
  if (!type) return res.status(415).json({ error: 'Only PDF, Word (.docx), JPG and PNG files can be kept here.' });
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM user_documents WHERE user_id = ?', [uid]);
  if (Number(n) >= MAX_DOCS) return res.status(400).json({ error: `You can keep ${MAX_DOCS} files. Remove one first.` });
  const kind = DOC_KINDS.includes(req.get('x-doc-kind')) ? req.get('x-doc-kind') : 'other';
  const name = cleanName(req.get('x-file-name'), `document${type.ext}`);
  const result = await query('INSERT INTO user_documents SET ?', [{ user_id: uid, kind, name, size: buffer.length, mime: type.mime, uploaded_at: new Date() }]);
  await fs.mkdir(docsDir(uid), { recursive: true });
  await fs.writeFile(docPath(uid, result.insertId, type.ext), buffer);
  res.status(201).json({ documents: await listDocuments(uid) });
});

documentsRouter.patch('/:id', async (req, res) => {
  if (!/^\d{1,10}$/.test(req.params.id)) return res.status(404).json({ error: 'Not found.' });
  const fields = {};
  if (DOC_KINDS.includes(req.body?.kind)) fields.kind = req.body.kind;
  if (typeof req.body?.name === 'string' && req.body.name.trim()) fields.name = cleanName(req.body.name, 'document');
  if (Object.keys(fields).length) await query('UPDATE user_documents SET ? WHERE id = ? AND user_id = ?', [fields, Number(req.params.id), req.user.id]);
  res.json({ documents: await listDocuments(req.user.id) });
});

documentsRouter.delete('/:id', async (req, res) => {
  if (!/^\d{1,10}$/.test(req.params.id)) return res.status(400).json({ error: 'The CV and portfolio are removed on the Profile page.' });
  const [d] = await query('SELECT id, mime FROM user_documents WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  if (d) {
    await fs.rm(docPath(req.user.id, d.id, EXT[d.mime] || ''), { force: true });
    await query('DELETE FROM user_documents WHERE id = ?', [d.id]);
  }
  res.json({ documents: await listDocuments(req.user.id) });
});

documentsRouter.get('/:id/file', async (req, res) => {
  const doc = await readDocument(req.user.id, req.params.id);
  if (!doc) return res.status(404).json({ error: 'Not found.' });
  res.setHeader('Content-Type', doc.mime);
  res.setHeader('Content-Disposition', `attachment; filename="${doc.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(doc.buffer);
});
