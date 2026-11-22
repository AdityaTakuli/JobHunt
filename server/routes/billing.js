import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import {
  createOrder,
  extendUntil,
  isEnabled,
  keyMode,
  planStatus,
  RazorpayError,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../lib/razorpay.js';
import { startOfIstDay } from '../lib/time.js';

// Payments with Razorpay Checkout: POST /order makes an order, the page opens Checkout with it,
// POST /verify checks the signature Checkout hands back and extends the plan. The webhook does the
// same from Razorpay's side, so a closed tab still gets the plan. Marking paid happens once.
export const billingRouter = Router();

const rz = () => config.razorpay;
const off = (res) => res.status(503).json({ error: 'Payments are not switched on yet.' });

async function userPlan(userId) {
  const [row] = await query('SELECT plan, plan_expires_at FROM users WHERE id = ?', [userId]);
  return planStatus(row);
}

billingRouter.get('/', async (req, res, next) => {
  try {
    const enabled = isEnabled(rz());
    res.json({
      enabled,
      mode: enabled ? keyMode(rz().keyId) : null,
      keyId: enabled ? rz().keyId : null,
      plans: enabled ? rz().plans.map(({ id, label, amount, currency, days }) => ({ id, label, amount, currency, days })) : [],
      ...(await userPlan(req.user.id)),
    });
  } catch (err) {
    next(err);
  }
});

billingRouter.post('/order', async (req, res, next) => {
  try {
    if (!isEnabled(rz())) return off(res);
    const plan = rz().plans.find((p) => p.id === req.body?.plan);
    if (!plan) return res.status(400).json({ error: 'Unknown plan.' });
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM payments WHERE user_id = ? AND created_at >= ?', [
      req.user.id,
      startOfIstDay(),
    ]);
    if (Number(n) >= rz().dailyOrders) return res.status(429).json({ error: 'Too many payment attempts today. Try again tomorrow.' });

    const receipt = `u${req.user.id}-${crypto.randomBytes(6).toString('hex')}`;
    const order = await createOrder(rz(), {
      amount: plan.amount,
      currency: plan.currency,
      receipt,
      notes: { user_id: String(req.user.id), plan: plan.id },
    });
    await query('INSERT INTO payments SET ?', [
      {
        user_id: req.user.id,
        plan: plan.id,
        days: plan.days,
        amount: plan.amount,
        currency: plan.currency,
        order_id: order.id,
        status: 'created',
        mode: keyMode(rz().keyId),
        created_at: new Date(),
      },
    ]);
    res.json({
      keyId: rz().keyId,
      orderId: order.id,
      amount: plan.amount,
      currency: plan.currency,
      name: 'ArchJobs',
      description: plan.label,
      prefill: { name: req.user.name || '', email: req.user.email || '' },
    });
  } catch (err) {
    if (err instanceof RazorpayError) {
      console.error('Razorpay order failed:', err.message);
      return res.status(502).json({ error: 'Could not start the payment. Try again in a minute.' });
    }
    next(err);
  }
});

// Marks an order paid and extends the plan, once. Returns false for an unknown or mismatched order.
export async function markPaid({ orderId, paymentId, amount }, now = new Date()) {
  const [pay] = await query('SELECT * FROM payments WHERE order_id = ?', [orderId]);
  if (!pay) return false;
  if (amount != null && Number(amount) !== Number(pay.amount)) {
    console.error(`Razorpay amount mismatch on ${orderId}: ${amount} vs ${pay.amount}`);
    return false;
  }
  if (pay.status === 'paid') return true;
  const result = await query("UPDATE payments SET status = 'paid', payment_id = ?, paid_at = ? WHERE id = ? AND status <> 'paid'", [
    paymentId,
    now,
    pay.id,
  ]);
  // Another request (Checkout vs webhook) got there first.
  if (!result.affectedRows) return true;
  const [user] = await query('SELECT plan, plan_expires_at FROM users WHERE id = ?', [pay.user_id]);
  const until = extendUntil(user?.plan === pay.plan ? user.plan_expires_at : null, pay.days, now);
  await query('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?', [pay.plan, until, pay.user_id]);
  return true;
}

billingRouter.post('/verify', async (req, res, next) => {
  try {
    if (!isEnabled(rz())) return off(res);
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = req.body || {};
    if (!verifyPaymentSignature({ orderId, paymentId, signature }, rz().keySecret)) {
      return res.status(400).json({ error: 'Payment could not be verified.' });
    }
    const [pay] = await query('SELECT user_id FROM payments WHERE order_id = ?', [orderId]);
    if (!pay || pay.user_id !== req.user.id) return res.status(404).json({ error: 'Payment not found.' });
    await markPaid({ orderId, paymentId });
    res.json({ ok: true, ...(await userPlan(req.user.id)) });
  } catch (err) {
    next(err);
  }
});

// Mounted before express.json and before sign-in (app.js): needs the raw body for the signature.
export async function razorpayWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!verifyWebhookSignature(raw, req.get('X-Razorpay-Signature'), rz().webhookSecret)) {
    return res.status(400).json({ error: 'Bad signature.' });
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return res.status(400).json({ error: 'Bad body.' });
  }
  try {
    const payment = event?.payload?.payment?.entity;
    if ((event.event === 'payment.captured' || event.event === 'order.paid') && payment?.order_id) {
      await markPaid({ orderId: payment.order_id, paymentId: payment.id, amount: payment.amount });
    } else if (event.event === 'payment.failed' && payment?.order_id) {
      await query("UPDATE payments SET status = 'failed', payment_id = ? WHERE order_id = ? AND status = 'created'", [
        payment.id,
        payment.order_id,
      ]);
    }
    // Razorpay retries anything that isn't 2xx, so unknown events are acknowledged too.
    res.json({ ok: true });
  } catch (err) {
    console.error('Razorpay webhook failed:', err);
    res.status(500).json({ error: 'Try again.' });
  }
}
