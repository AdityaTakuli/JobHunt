// Google sign-in (OpenID Connect, code flow) and the Gmail API calls used to read job alerts.
// Plain fetch, no SDK. `deps.fetch` can be swapped in tests.

import { config } from '../config.js';

export const deps = { fetch: (...args) => fetch(...args) };

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GMAIL_URL = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export const googleConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);
export const redirectUri = () => `${config.publicUrl}/api/auth/google/callback`;

export class GoogleError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * @param state random value echoed back to the callback
 * @param gmail also ask to read Gmail (offline access, so it keeps working without her)
 * @param loginHint email to preselect
 */
export function authUrl({ state, gmail = false, loginHint }) {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: ['openid', 'email', 'profile', ...(gmail ? [GMAIL_SCOPE] : [])].join(' '),
    state,
    include_granted_scopes: 'true',
    ...(gmail && { access_type: 'offline', prompt: 'consent' }),
    ...(!gmail && { prompt: 'select_account' }),
    ...(loginHint && { login_hint: loginHint }),
  });
  return `${AUTH_URL}?${params}`;
}

async function postForm(url, form) {
  const res = await deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(data.error_description || data.error || `Google answered ${res.status}`, { status: res.status, code: data.error });
  return data;
}

// The ID token comes straight from Google's token endpoint over HTTPS, so its claims can be
// trusted after checking who it is for and that it is current (OpenID Connect Core 3.1.3.7).
export function readIdToken(idToken, now = Date.now()) {
  let claims;
  try {
    claims = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw new GoogleError('Google sent an unreadable sign-in token.');
  }
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss)) throw new GoogleError('Sign-in token is not from Google.');
  if (claims.aud !== config.google.clientId) throw new GoogleError('Sign-in token is for another app.');
  if (!claims.exp || claims.exp * 1000 < now - 60_000) throw new GoogleError('Sign-in token has expired.');
  if (!claims.email || claims.email_verified === false) throw new GoogleError('This Google account has no verified email.');
  return { sub: String(claims.sub), email: String(claims.email).toLowerCase(), name: claims.name || null, picture: claims.picture || null };
}

// Code from the callback -> { profile, refreshToken, scopes }.
export async function exchangeCode(code) {
  const data = await postForm(TOKEN_URL, {
    code,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: 'authorization_code',
  });
  return {
    profile: readIdToken(data.id_token),
    refreshToken: data.refresh_token || null,
    scopes: String(data.scope || '').split(' '),
  };
}

export async function accessToken(refreshToken) {
  const data = await postForm(TOKEN_URL, {
    refresh_token: refreshToken,
    client_id: config.google.clientId,
    client_secret: config.google.clientSecret,
    grant_type: 'refresh_token',
  });
  return data.access_token;
}

export async function revoke(token) {
  await postForm(REVOKE_URL, { token }).catch(() => {});
}

async function gmailGet(token, path) {
  const res = await deps.fetch(`${GMAIL_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(data.error?.message || `Gmail answered ${res.status}`, { status: res.status, code: data.error?.status });
  return data;
}

// Raw RFC 822 messages matching a Gmail search, newest first: [{ id, raw: Buffer }].
async function searchMessages(token, q, max) {
  const list = await gmailGet(token, `/messages?${new URLSearchParams({ q, maxResults: String(max) })}`);
  const out = [];
  for (const { id } of list.messages || []) {
    const msg = await gmailGet(token, `/messages/${encodeURIComponent(id)}?format=raw`);
    if (msg.raw) out.push({ id, raw: Buffer.from(msg.raw, 'base64url') });
  }
  return out;
}

const afterSeconds = (date) => Math.floor(date.getTime() / 1000);

// LinkedIn job alert emails since `after` (newest first): [{ id, raw }]. "Your application was
// sent" emails come from the same address; they are application emails, not alerts.
export async function fetchAlertEmails(token, { after, max = config.google.gmailMaxMessages }) {
  const q = `from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com OR jobs-listings@linkedin.com) -subject:application after:${afterSeconds(after)}`;
  return searchMessages(token, q, max);
}

// Emails about her own applications since `after`: confirmations, interviews, tests, offers,
// rejections. Wide on purpose; lib/mailTriage.js sorts out what each one means. Job alerts,
// promotions and social mail are left out.
export const APPLICATION_QUERY =
  '-from:jobalerts-noreply@linkedin.com -category:promotions -category:social ' +
  '(subject:(application OR applied OR applying OR interview OR offer OR shortlisted OR assessment OR assignment OR candidature OR "next steps" OR "design task") ' +
  'OR "your application was sent to" OR "thank you for applying")';

export async function fetchApplicationEmails(token, { after, max = config.google.gmailApplicationMessages }) {
  return searchMessages(token, `${APPLICATION_QUERY} after:${afterSeconds(after)}`, max);
}
