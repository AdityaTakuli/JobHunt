import crypto from 'node:crypto';
import { promisify } from 'node:util';

// Passwords for email + password sign-in, stored as scrypt hashes: "scrypt$N$r$p$salt$hash".
const scrypt = promisify(crypto.scrypt);
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  if (!expected.length || String(password).length > MAX_PASSWORD) return false;
  try {
    const key = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// Spent on an unknown email, so a wrong email takes as long as a wrong password.
let dummy;
export async function burnTime(password) {
  dummy ||= await hashPassword('archjobs-not-a-password');
  await verifyPassword(password, dummy);
}
