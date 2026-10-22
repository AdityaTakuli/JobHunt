// Encrypts secrets kept in the database (Gmail refresh tokens) with AES-256-GCM, so a database
// dump alone cannot read anyone's mail. The key comes from TOKEN_SECRET (else SESSION_SECRET).
import crypto from 'node:crypto';
import { config } from '../config.js';

function key() {
  const secret = config.auth.tokenSecret || config.auth.sessionSecret || config.auth.password;
  if (!secret) throw new Error('Set TOKEN_SECRET (or SESSION_SECRET) to store Gmail access.');
  return crypto.createHash('sha256').update(`archjobs-tokens:${secret}`).digest();
}

export function seal(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

// Null when the value was sealed with another key (the secret changed) or was tampered with.
export function open(sealed) {
  try {
    const [version, iv, tag, data] = String(sealed || '').split('.');
    if (version !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
