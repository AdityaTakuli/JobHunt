import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { freeLimitsOn, limitMessage, nextWeek } from '../server/lib/quota.js';
import { parsePlans } from '../server/lib/razorpay.js';
import { startOfIstWeek } from '../server/lib/time.js';

const plans = parsePlans('pro_month:19900:30:Pro monthly,pro_year:149900:365:Pro yearly');
const cfg = (mode, enabled) => ({ freeLimits: { mode, weekly: {} }, razorpay: { enabled, keyId: 'rzp_test_x', keySecret: 's', plans } });

describe('weekly free limits', () => {
  it('turn on with payments, unless forced', () => {
    assert.equal(freeLimitsOn(cfg('auto', false)), false);
    assert.equal(freeLimitsOn(cfg('auto', true)), true);
    assert.equal(freeLimitsOn(cfg('on', false)), true);
    assert.equal(freeLimitsOn(cfg('off', true)), false);
  });

  it('weeks start Monday midnight IST', () => {
    // Sunday 23:00 IST is still the week that began the Monday before.
    assert.equal(startOfIstWeek(new Date('2026-11-22T17:30:00Z')).toISOString(), '2026-11-15T18:30:00.000Z');
    // Monday 00:10 IST starts a new week.
    assert.equal(startOfIstWeek(new Date('2026-11-22T18:40:00Z')).toISOString(), '2026-11-22T18:30:00.000Z');
    assert.equal(nextWeek(new Date('2026-11-20T06:00:00Z')).toISOString(), '2026-11-22T18:30:00.000Z');
  });

  it('names the cheapest Pro price in the limit message', () => {
    const msg = limitMessage('tailor', 2, cfg('on', true));
    assert.match(msg, /this week's 2 free tailored CVs and cover letters/);
    assert.match(msg, /from ₹199 a month/);
    assert.doesNotMatch(limitMessage('fill', 10, { ...cfg('on', true), razorpay: { plans: [] } }), /₹/);
  });
});
