import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { burnTime, hashPassword, verifyPassword } from '../server/lib/password.js';

describe('passwords', () => {
  it('hashes with a fresh salt and checks the password', async () => {
    const a = await hashPassword('Correct-Horse@9');
    const b = await hashPassword('Correct-Horse@9');
    assert.match(a, /^scrypt\$16384\$8\$1\$/);
    assert.notEqual(a, b);
    assert.equal(a.includes('Correct-Horse'), false);
    assert.equal(await verifyPassword('Correct-Horse@9', a), true);
    assert.equal(await verifyPassword('correct-horse@9', a), false);
    assert.equal(await verifyPassword('', a), false);
  });

  it('turns down missing or broken hashes', async () => {
    assert.equal(await verifyPassword('x', null), false);
    assert.equal(await verifyPassword('x', 'plain-text'), false);
    assert.equal(await verifyPassword('x', 'scrypt$16384$8$1$c2FsdA==$'), false);
    assert.equal(await verifyPassword('x'.repeat(500), await hashPassword('x'.repeat(500))), false);
    await burnTime('anything');
  });
});
