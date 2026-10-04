import { describe, expect, it } from 'vitest';

import { hashPassword, needsRehash, verifyPassword, zPassword } from '../../src/core/auth/password.js';

describe('password hashing (P1 §12.4, T-7)', () => {
  it('hashes with argon2id into a self-describing PHC string, salted per hash', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and refuses a wrong one', async () => {
    const h = await hashPassword('correct horse battery');
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'Correct horse battery')).toBe(false);
  });

  it('treats a malformed stored hash as a failed verification, not an error', async () => {
    expect(await verifyPassword('not-a-hash', 'anything')).toBe(false);
  });

  it('flags hashes made with other parameters for upgrade', async () => {
    expect(needsRehash(await hashPassword('x'.repeat(12)))).toBe(false);
    expect(needsRehash('$argon2id$v=19$m=4096,t=3,p=1$c2FsdA$aGFzaA')).toBe(true);
    expect(needsRehash('$2b$10$abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('enforces length only: 12 to 128 characters', () => {
    expect(zPassword.safeParse('short').success).toBe(false);
    expect(zPassword.safeParse('twelve chars').success).toBe(true);
    expect(zPassword.safeParse('x'.repeat(129)).success).toBe(false);
  });
});
