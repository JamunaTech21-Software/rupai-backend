import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { hashOpaqueToken, newOpaqueToken, tokenSigner } from '../../src/core/auth/tokens.js';

const SECRET = 'unit-test-secret-0123456789abcdefghij';
const OLD = 'unit-test-old-secret-0123456789abcdefgh';

const decode = (part: string) =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;

describe('access tokens (P4 §2.2.1)', () => {
  it('carries the identity only: user, session, token id, issued-at and expiry', () => {
    const signer = tokenSigner({ secret: SECRET, ttlSeconds: 900 });
    const { token, expiresAt } = signer.sign(42n, 7n);
    const [header = '', payload = ''] = token.split('.');
    expect(decode(header)).toMatchObject({ alg: 'HS256', typ: 'JWT' });
    const claims = decode(payload);
    expect(Object.keys(claims).sort()).toEqual(['exp', 'iat', 'jti', 'sid', 'sub']);
    expect(claims).toMatchObject({ sub: '42', sid: '7' });
    expect((claims.exp as number) - (claims.iat as number)).toBe(900);
    expect(expiresAt.getTime()).toBe((claims.exp as number) * 1000);
    expect(signer.verify(token)).toEqual({
      ok: true,
      claims: expect.objectContaining({ sub: '42', sid: '7' }),
    });
  });

  it('expires after its lifetime', () => {
    let now = Date.UTC(2026, 0, 1);
    const signer = tokenSigner({ secret: SECRET, ttlSeconds: 900 }, () => now);
    const { token } = signer.sign(1n, 1n);
    now += 899_000;
    expect(signer.verify(token).ok).toBe(true);
    now += 1_000;
    expect(signer.verify(token)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a tampered payload, a foreign key and garbage', () => {
    const signer = tokenSigner({ secret: SECRET, ttlSeconds: 900 });
    const { token } = signer.sign(1n, 1n);
    const [h, , s] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: '2', sid: '1', jti: 'x', iat: 1, exp: 9e9 })).toString(
      'base64url',
    );
    expect(signer.verify(`${String(h)}.${forged}.${String(s)}`)).toEqual({ ok: false, reason: 'invalid' });
    expect(tokenSigner({ secret: OLD, ttlSeconds: 900 }).verify(token)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    for (const junk of ['', 'a.b', 'a.b.c', `${token}x`, 'x.y.z.w']) {
      expect(signer.verify(junk).ok).toBe(false);
    }
  });

  it('refuses alg "none" and any algorithm other than HS256', () => {
    const signer = tokenSigner({ secret: SECRET, ttlSeconds: 900 });
    const payload = Buffer.from(
      JSON.stringify({ sub: '1', sid: '1', jti: 'x', iat: 1, exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString('base64url');
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    expect(signer.verify(`${none}.${payload}.`).ok).toBe(false);
    const { token } = signer.sign(1n, 1n);
    const kid = decode(token.split('.')[0] ?? '').kid as string;
    const hs512 = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT', kid })).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`${hs512}.${payload}`).digest('base64url');
    expect(signer.verify(`${hs512}.${payload}.${sig}`).ok).toBe(false);
  });

  it('keeps tokens signed with the previous key valid during a rotation', () => {
    const before = tokenSigner({ secret: OLD, ttlSeconds: 900 });
    const after = tokenSigner({ secret: SECRET, previousSecret: OLD, ttlSeconds: 900 });
    const { token: old } = before.sign(5n, 9n);
    expect(after.verify(old).ok).toBe(true);
    // New tokens use the new key, which the old verifier does not know.
    expect(before.verify(after.sign(5n, 9n).token).ok).toBe(false);
    // Once the previous key is dropped, the old token is refused.
    expect(tokenSigner({ secret: SECRET, ttlSeconds: 900 }).verify(old).ok).toBe(false);
  });
});

describe('opaque tokens', () => {
  it('are 256-bit, URL-safe and unique; only their SHA-256 is stored', () => {
    const a = newOpaqueToken();
    const b = newOpaqueToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(hashOpaqueToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOpaqueToken(a)).toBe(hashOpaqueToken(a));
    expect(hashOpaqueToken(a)).not.toBe(hashOpaqueToken(b));
  });
});
