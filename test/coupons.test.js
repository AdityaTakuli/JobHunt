import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyCoupon, cleanCoupon, CouponError, couponProblem, normalizeCode } from '../server/lib/coupons.js';
import { parsePlans } from '../server/lib/razorpay.js';

const [month, year] = parsePlans('pro_month:19900:30:Pro monthly,pro_year:149900:365:Pro yearly');
const now = new Date('2026-11-23T06:00:00Z');

describe('coupons', () => {
  it('normalises codes and rejects junk', () => {
    assert.equal(normalizeCode('  diwali-50 '), 'DIWALI-50');
    assert.equal(normalizeCode('ab'), '');
    assert.equal(normalizeCode('bad code'), '');
    assert.equal(normalizeCode("x' OR 1=1"), '');
  });

  it('takes percent or rupees off, never below ₹1 unless free', () => {
    assert.deepEqual(applyCoupon(month, { percent_off: 50 }), { discount: 9950, amount: 9950 });
    assert.deepEqual(applyCoupon(month, { amount_off: 5000 }), { discount: 5000, amount: 14900 });
    assert.deepEqual(applyCoupon(month, { percent_off: 100 }), { discount: 19900, amount: 0 });
    assert.deepEqual(applyCoupon(month, { amount_off: 19850 }), { discount: 19800, amount: 100 });
    assert.deepEqual(applyCoupon(month, { amount_off: 99999 }), { discount: 19900, amount: 0 });
  });

  it('says why a code cannot be used', () => {
    const ok = { active: 1, uses: 0, max_uses: null, plan: null, expires_at: null };
    assert.equal(couponProblem(ok, month, now), null);
    assert.match(couponProblem(undefined, month, now), /not valid/);
    assert.match(couponProblem({ ...ok, active: 0 }, month, now), /not valid/);
    assert.match(couponProblem({ ...ok, expires_at: '2026-11-22T00:00:00Z' }, month, now), /expired/);
    assert.match(couponProblem({ ...ok, max_uses: 5, uses: 5 }, month, now), /used up/);
    assert.match(couponProblem({ ...ok, plan: 'pro_year' }, month, now), /different plan/);
    assert.equal(couponProblem({ ...ok, plan: 'pro_year' }, year, now), null);
  });

  it('checks the admin form', () => {
    const plans = [month, year];
    assert.deepEqual(cleanCoupon({ code: 'launch', percentOff: '30', maxUses: '100', expiresOn: '2026-12-31' }, plans, now), {
      code: 'LAUNCH',
      percent_off: 30,
      amount_off: null,
      plan: null,
      max_uses: 100,
      expires_at: new Date('2026-12-31T18:29:59.000Z'),
    });
    assert.equal(cleanCoupon({ code: 'FIFTY', rupeesOff: '50', plan: 'pro_year' }, plans, now).amount_off, 5000);
    assert.throws(() => cleanCoupon({ code: 'X1', percentOff: 10 }, plans, now), CouponError);
    assert.throws(() => cleanCoupon({ code: 'BOTH', percentOff: 10, rupeesOff: 10 }, plans, now), /either/);
    assert.throws(() => cleanCoupon({ code: 'NONE' }, plans, now), /either/);
    assert.throws(() => cleanCoupon({ code: 'BIG', percentOff: 101 }, plans, now), /1 to 100/);
    assert.throws(() => cleanCoupon({ code: 'OLD', percentOff: 10, expiresOn: '2026-11-01' }, plans, now), /future/);
    assert.throws(() => cleanCoupon({ code: 'WHO', percentOff: 10, plan: 'gold' }, plans, now), /Unknown plan/);
  });
});
