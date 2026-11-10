// Each person's stored profile (profiles table) and their uploaded PDFs on disk. The ready
// profile is cached per person for a short while, as the job feed asks for it on every page.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parseJson, query } from '../db/pool.js';

const CACHE_MS = 30_000;
const cache = new Map(); // user id -> { profile, at }

export const PROFILE_KINDS = ['resume', 'portfolio'];

export const profileDir = (userId) => path.join(config.profile.dataDir, 'profiles', String(Number(userId)));
export const profilePath = (userId, kind) => path.join(profileDir(userId), `${kind}.pdf`);

export async function saveFile(userId, kind, buffer) {
  await fs.mkdir(profileDir(userId), { recursive: true });
  await fs.writeFile(profilePath(userId, kind), buffer);
}

export async function readFile(userId, kind) {
  try {
    return await fs.readFile(profilePath(userId, kind));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function removeFile(userId, kind) {
  await fs.rm(profilePath(userId, kind), { force: true });
}

export async function getRow(userId) {
  const [row] = await query('SELECT * FROM profiles WHERE user_id = ?', [userId]);
  return row || null;
}

// The ready profile for fit scoring, or null.
export async function getProfile(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.profile;
  // The last good profile keeps scoring jobs while a new read runs or after one fails.
  const [row] = await query('SELECT profile FROM profiles WHERE user_id = ? AND profile IS NOT NULL', [userId]);
  const profile = row ? parseJson(row.profile, null) : null;
  cache.set(userId, { profile, at: Date.now() });
  return profile;
}

export function invalidate(userId) {
  cache.delete(userId);
}

export async function upsertRow(userId, values) {
  const row = { ...values, user_id: userId, updated_at: new Date() };
  await query('INSERT INTO profiles SET ? ON DUPLICATE KEY UPDATE ?', [row, row]);
  invalidate(userId);
}
