import crypto from 'node:crypto';

// Razorpay (https://razorpay.com/docs/api/orders/): one-time orders that extend a person's plan by
// a number of days. Off until RAZORPAY_ENABLED=true, both keys and at least one plan are set.
// Plain fetch with Basic auth, so no SDK dependency.

const API = 'https://api.razorpay.com/v1';

// RAZORPAY_PLANS="pro_month:14900:30:Pro monthly, season:39900:90:Season pass"
// = id : amount in paise : days added : label. Bad entries are skipped.
export function parsePlans(value) {
  const plans = [];
  for (const part of String(value || '').split(',')) {
    const [id, amount, days, ...label] = part.split(':').map((s) => s.trim());
    if (!/^[a-z0-9_]{1,32}$/.test(id || '')) continue;
    const paise = Number(amount);
    const d = Number(days);
    // Razorpay's minimum order is ₹1 (100 paise).
    if (!Number.isInteger(paise) || paise < 100 || !Number.isInteger(d) || d < 1 || d > 3660) continue;
    if (plans.some((p) => p.id === id)) continue;
    plans.push({ id, amount: paise, days: d, label: label.join(':') || id, currency: 'INR' });
  }
  return plans;
}

export function keyMode(keyId) {
  if (String(keyId).startsWith('rzp_live_')) return 'live';
  if (String(keyId).startsWith('rzp_test_')) return 'test';
  return '';
}

export function isEnabled(rz) {
  return Boolean(rz.enabled && rz.keyId && rz.keySecret && keyMode(rz.keyId) && rz.plans.length);
}

function safeEqualHex(expected, given) {
  const a = Buffer.from(String(expected), 'utf8');
  const b = Buffer.from(String(given || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const hmac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

// Checkout's handler gets order id, payment id and a signature = HMAC(order_id|payment_id, key secret).
export function verifyPaymentSignature({ orderId, paymentId, signature }, keySecret) {
  if (!keySecret || !orderId || !paymentId || !signature) return false;
  return safeEqualHex(hmac(keySecret, `${orderId}|${paymentId}`), signature);
}

// Webhooks carry X-Razorpay-Signature = HMAC(raw body, webhook secret).
export function verifyWebhookSignature(rawBody, signature, webhookSecret) {
  if (!webhookSecret || !rawBody || !signature) return false;
  return safeEqualHex(hmac(webhookSecret, rawBody), signature);
}

export class RazorpayError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function createOrder(rz, { amount, currency = 'INR', receipt, notes }, fetchImpl = fetch) {
  const res = await fetchImpl(`${API}/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${rz.keyId}:${rz.keySecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ amount, currency, receipt: String(receipt).slice(0, 40), notes }),
    signal: AbortSignal.timeout(rz.timeoutMs || 15_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new RazorpayError(data?.error?.description || `Razorpay answered ${res.status}.`, res.status);
  }
  return data;
}

// A person's plan from the users row: active while plan_expires_at is in the future.
export function planStatus(user, now = new Date()) {
  const expires = user?.plan_expires_at ? new Date(user.plan_expires_at) : null;
  const active = Boolean(user?.plan && expires && expires > now);
  return { plan: active ? user.plan : 'free', active, expiresAt: active ? expires.toISOString() : null };
}

// Paid days start from today, or from the end of a plan still running.
export function extendUntil(currentExpiry, days, now = new Date()) {
  const base = currentExpiry && new Date(currentExpiry) > now ? new Date(currentExpiry) : now;
  return new Date(base.getTime() + days * 86_400_000);
}
