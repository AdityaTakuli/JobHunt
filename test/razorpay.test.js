import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import {
  createOrder,
  extendUntil,
  isEnabled,
  keyMode,
  parsePlans,
  planStatus,
  RazorpayError,
  verifyPaymentSignature,
  verifyWebhookSignature,
} from '../server/lib/razorpay.js';

const sign = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');

describe('razorpay plans and switch', () => {
  it('reads plans and skips bad ones', () => {
    const plans = parsePlans('pro_month:14900:30:Pro monthly, season:39900:90, Bad:100:1, cheap:50:1, pro_month:1:1, nodays:1000:0');
    assert.deepEqual(plans, [
      { id: 'pro_month', amount: 14900, days: 30, label: 'Pro monthly', currency: 'INR' },
      { id: 'season', amount: 39900, days: 90, label: 'season', currency: 'INR' },
    ]);
    assert.deepEqual(parsePlans(''), []);
  });

  it('stays off without the flag, keys, a known key type or plans', () => {
    const plans = parsePlans('p:14900:30');
    const on = { enabled: true, keyId: 'rzp_test_abc', keySecret: 's', plans };
    assert.equal(isEnabled(on), true);
    assert.equal(isEnabled({ ...on, enabled: false }), false);
    assert.equal(isEnabled({ ...on, keySecret: '' }), false);
    assert.equal(isEnabled({ ...on, keyId: 'abc' }), false);
    assert.equal(isEnabled({ ...on, plans: [] }), false);
    assert.equal(keyMode('rzp_live_x'), 'live');
    assert.equal(keyMode('rzp_test_x'), 'test');
  });
});

describe('razorpay signatures', () => {
  it('accepts only the Checkout signature made with the key secret', () => {
    const signature = sign('secret', 'order_1|pay_1');
    assert.equal(verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_1', signature }, 'secret'), true);
    assert.equal(verifyPaymentSignature({ orderId: 'order_2', paymentId: 'pay_1', signature }, 'secret'), false);
    assert.equal(verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_1', signature }, 'other'), false);
    assert.equal(verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_1', signature: 'short' }, 'secret'), false);
    assert.equal(verifyPaymentSignature({ orderId: 'order_1', paymentId: 'pay_1', signature }, ''), false);
  });

  it('checks webhooks against the raw body', () => {
    const body = '{"event":"payment.captured"}';
    assert.equal(verifyWebhookSignature(body, sign('wh', body), 'wh'), true);
    assert.equal(verifyWebhookSignature(`${body} `, sign('wh', body), 'wh'), false);
    assert.equal(verifyWebhookSignature(body, sign('wh', body), ''), false);
  });
});

describe('razorpay orders', () => {
  const rz = { keyId: 'rzp_test_abc', keySecret: 'sec', timeoutMs: 1000 };

  it('posts the order with Basic auth', async () => {
    let seen;
    const fetchImpl = async (url, opts) => {
      seen = { url, opts };
      return { ok: true, status: 200, json: async () => ({ id: 'order_9', amount: 14900 }) };
    };
    const order = await createOrder(rz, { amount: 14900, receipt: 'x'.repeat(60), notes: { plan: 'p' } }, fetchImpl);
    assert.equal(order.id, 'order_9');
    assert.equal(seen.url, 'https://api.razorpay.com/v1/orders');
    assert.equal(seen.opts.headers.Authorization, `Basic ${Buffer.from('rzp_test_abc:sec').toString('base64')}`);
    const body = JSON.parse(seen.opts.body);
    assert.equal(body.amount, 14900);
    assert.equal(body.currency, 'INR');
    assert.equal(body.receipt.length, 40);
  });

  it('turns a Razorpay error into RazorpayError', async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ error: { description: 'Authentication failed' } }) });
    await assert.rejects(createOrder(rz, { amount: 100, receipt: 'r' }, fetchImpl), (err) => err instanceof RazorpayError && err.status === 401);
  });
});

describe('plan dates', () => {
  const now = new Date('2026-11-22T00:00:00Z');

  it('is free without a plan or after it ends', () => {
    assert.deepEqual(planStatus(null, now), { plan: 'free', active: false, expiresAt: null });
    assert.equal(planStatus({ plan: 'p', plan_expires_at: '2026-11-21T00:00:00Z' }, now).active, false);
    assert.deepEqual(planStatus({ plan: 'p', plan_expires_at: '2026-12-01T00:00:00Z' }, now), {
      plan: 'p',
      active: true,
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it('adds days from today, or from the end of a running plan', () => {
    assert.equal(extendUntil(null, 30, now).toISOString(), '2026-12-22T00:00:00.000Z');
    assert.equal(extendUntil('2026-11-01T00:00:00Z', 30, now).toISOString(), '2026-12-22T00:00:00.000Z');
    assert.equal(extendUntil('2026-12-01T00:00:00Z', 30, now).toISOString(), '2026-12-31T00:00:00.000Z');
  });
});
