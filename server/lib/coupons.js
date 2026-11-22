// Coupon codes for ArchJobs Pro. An admin makes a code (percent or rupees off, optionally for one
// plan, a number of uses and an end date); a buyer types it in Settings > Plan. Each person can use
// a code once. A code that brings the price to zero turns Pro on without Razorpay; any other price
// stays at least ₹1, Razorpay's minimum.

import { query } from '../db/pool.js';

export const MIN_AMOUNT = 100; // paise

export class CouponError extends Error {}

// "  diwali-50 " -> "DIWALI-50"; '' when it can't be a code.
export function normalizeCode(code) {
  const c = String(code ?? '').trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9_-]{2,23}$/.test(c) ? c : '';
}

// What a coupon takes off a plan, and the price left: { discount, amount }.
export function applyCoupon(plan, coupon) {
  const off = coupon.percent_off ? Math.round((plan.amount * Number(coupon.percent_off)) / 100) : Number(coupon.amount_off || 0);
  let amount = Math.max(plan.amount - off, 0);
  if (amount > 0 && amount < MIN_AMOUNT) amount = MIN_AMOUNT;
  return { discount: plan.amount - amount, amount };
}

// Why a coupon can't be used on this plan right now, or null when it can.
export function couponProblem(coupon, plan, now = new Date()) {
  if (!coupon || !coupon.active) return 'That coupon code is not valid.';
  if (coupon.expires_at && new Date(coupon.expires_at) <= now) return 'That coupon code has expired.';
  if (coupon.max_uses != null && Number(coupon.uses) >= Number(coupon.max_uses)) return 'That coupon code has been used up.';
  if (coupon.plan && coupon.plan !== plan.id) return 'That coupon code is for a different plan.';
  return null;
}

/**
 * Checks a typed code for one person and plan. Returns { code, discount, amount } or throws a
 * CouponError with a message for the buyer.
 */
export async function priceWithCoupon(rawCode, plan, userId, now = new Date()) {
  const code = normalizeCode(rawCode);
  if (!code) throw new CouponError('That coupon code is not valid.');
  const [coupon] = await query('SELECT * FROM coupons WHERE code = ?', [code]);
  const problem = couponProblem(coupon, plan, now);
  if (problem) throw new CouponError(problem);
  const [{ n }] = await query("SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND coupon = ? AND status = 'paid'", [userId, code]);
  if (Number(n) > 0) throw new CouponError('You have already used this coupon code.');
  return { code, ...applyCoupon(plan, coupon) };
}

/**
 * Claims one use of a code for a person, safely when many people (or one person in many tabs) try
 * at the same moment: the unique key on coupon_redemptions lets a person claim a code once, and the
 * guarded UPDATE only counts a use while one is left. Throws a CouponError when the claim fails.
 */
export async function claimCoupon(code, userId, now = new Date()) {
  try {
    await query('INSERT INTO coupon_redemptions (coupon, user_id, created_at) VALUES (?, ?, ?)', [code, userId, now]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw new CouponError('You have already used this coupon code.');
    throw err;
  }
  const claimed = await query(
    'UPDATE coupons SET uses = uses + 1 WHERE code = ? AND active = 1 AND (max_uses IS NULL OR uses < max_uses) AND (expires_at IS NULL OR expires_at > ?)',
    [code, now],
  );
  if (!claimed.affectedRows) {
    await query('DELETE FROM coupon_redemptions WHERE coupon = ? AND user_id = ?', [code, userId]);
    throw new CouponError('That coupon code has been used up.');
  }
}

// A new coupon from the admin form, checked. Throws CouponError on bad input.
export function cleanCoupon(body, plans, now = new Date()) {
  const code = normalizeCode(body?.code);
  if (!code) throw new CouponError('Use 3 to 24 letters, numbers, - or _ for the code.');
  const percent = body?.percentOff === '' || body?.percentOff == null ? null : Number(body.percentOff);
  const rupees = body?.rupeesOff === '' || body?.rupeesOff == null ? null : Number(body.rupeesOff);
  if ((percent == null) === (rupees == null)) throw new CouponError('Give either a percent off or rupees off.');
  if (percent != null && !(Number.isInteger(percent) && percent >= 1 && percent <= 100)) throw new CouponError('Percent off must be a whole number from 1 to 100.');
  if (rupees != null && !(Number.isFinite(rupees) && rupees >= 1 && rupees <= 100_000)) throw new CouponError('Rupees off must be from 1 to 1,00,000.');
  const plan = body?.plan ? String(body.plan) : null;
  if (plan && !plans.some((p) => p.id === plan)) throw new CouponError('Unknown plan.');
  const maxUses = body?.maxUses === '' || body?.maxUses == null ? null : Number(body.maxUses);
  if (maxUses != null && !(Number.isInteger(maxUses) && maxUses >= 1 && maxUses <= 1_000_000)) throw new CouponError('Uses must be a whole number of at least 1.');
  let expiresAt = null;
  if (body?.expiresOn) {
    // The end of that day in India.
    const day = String(body.expiresOn);
    expiresAt = new Date(`${day}T23:59:59+05:30`);
    // "2026-02-31" parses as 3 March: it has to read back as the same day.
    const sameDay = !Number.isNaN(expiresAt.getTime()) && new Date(expiresAt.getTime() + 330 * 60_000).toISOString().slice(0, 10) === day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !sameDay) throw new CouponError('Pick a valid end date.');
    if (expiresAt <= now) throw new CouponError('The end date must be in the future.');
  }
  return {
    code,
    percent_off: percent,
    amount_off: rupees != null ? Math.round(rupees * 100) : null,
    plan,
    max_uses: maxUses,
    expires_at: expiresAt,
  };
}

export function couponView(row) {
  return {
    code: row.code,
    percentOff: row.percent_off == null ? null : Number(row.percent_off),
    amountOff: row.amount_off == null ? null : Number(row.amount_off),
    plan: row.plan || null,
    maxUses: row.max_uses == null ? null : Number(row.max_uses),
    uses: Number(row.uses),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    active: Boolean(row.active),
  };
}
