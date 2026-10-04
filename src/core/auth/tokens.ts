import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { newUlid } from '../ids/ids.js';

/**
 * Access tokens (Spec P4 §2.2.1): a compact JWS (HS256) carrying the user identity ONLY:
 *
 *   { sub: user id, sid: session id, jti, iat, exp }
 *
 * No permissions and no scope: those are resolved server-side on every request, so a role change or a
 * suspension takes effect at once. The session id is what makes the token revocable: `authenticate`
 * checks the session on every request (sessions.ts).
 *
 * Key rotation without signing anybody out: the header names its key (`kid`), and the verifier accepts
 * the previous key too, so tokens signed before a rotation stay valid until they expire (≤ 15 min).
 *
 * Refresh tokens and reset tokens are opaque random strings. Only their SHA-256 is stored.
 */

export interface AccessClaims {
  readonly sub: string;
  readonly sid: string;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: AccessClaims }
  | { readonly ok: false; readonly reason: 'invalid' | 'expired' };

export interface TokenSigner {
  sign(userId: bigint, sessionId: bigint): { token: string; expiresAt: Date };
  verify(token: string): VerifyResult;
  readonly ttlSeconds: number;
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const keyId = (secret: string) => createHash('sha256').update(secret).digest('base64url').slice(0, 8);

const NUMERIC_ID = /^[1-9]\d{0,19}$/;

function parseClaims(json: unknown): AccessClaims | null {
  if (!json || typeof json !== 'object') return null;
  const c = json as Record<string, unknown>;
  if (typeof c.sub !== 'string' || !NUMERIC_ID.test(c.sub)) return null;
  if (typeof c.sid !== 'string' || !NUMERIC_ID.test(c.sid)) return null;
  if (typeof c.jti !== 'string') return null;
  if (!Number.isInteger(c.iat) || !Number.isInteger(c.exp)) return null;
  return { sub: c.sub, sid: c.sid, jti: c.jti, iat: c.iat as number, exp: c.exp as number };
}

export function tokenSigner(
  opts: { secret: string; previousSecret?: string | null; ttlSeconds: number },
  now: () => number = Date.now,
): TokenSigner {
  const current = { kid: keyId(opts.secret), secret: opts.secret };
  const keys = new Map([[current.kid, current.secret]]);
  if (opts.previousSecret) keys.set(keyId(opts.previousSecret), opts.previousSecret);

  const mac = (secret: string, input: string) => createHmac('sha256', secret).update(input).digest();

  return {
    ttlSeconds: opts.ttlSeconds,

    sign(userId, sessionId) {
      const iat = Math.floor(now() / 1000);
      const exp = iat + opts.ttlSeconds;
      const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: current.kid }));
      const payload = b64url(
        JSON.stringify({ sub: userId.toString(), sid: sessionId.toString(), jti: newUlid(), iat, exp }),
      );
      const signature = mac(current.secret, `${header}.${payload}`).toString('base64url');
      return { token: `${header}.${payload}.${signature}`, expiresAt: new Date(exp * 1000) };
    },

    verify(token) {
      const parts = token.split('.');
      if (parts.length !== 3) return { ok: false, reason: 'invalid' };
      const [h = '', p = '', s = ''] = parts;
      let header: unknown;
      let payload: unknown;
      try {
        header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
        payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
      } catch {
        return { ok: false, reason: 'invalid' };
      }
      const { alg, kid } = (header ?? {}) as { alg?: unknown; kid?: unknown };
      // The algorithm is fixed, never taken from the token ("alg: none" and key-confusion attacks).
      if (alg !== 'HS256' || typeof kid !== 'string') return { ok: false, reason: 'invalid' };
      const secret = keys.get(kid);
      if (!secret) return { ok: false, reason: 'invalid' };
      const expected = mac(secret, `${h}.${p}`);
      const given = Buffer.from(s, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { ok: false, reason: 'invalid' };
      }
      const claims = parseClaims(payload);
      if (!claims) return { ok: false, reason: 'invalid' };
      if (claims.exp <= Math.floor(now() / 1000)) return { ok: false, reason: 'expired' };
      return { ok: true, claims };
    },
  };
}

/** A new opaque token: 256 random bits, URL-safe. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What the database stores for an opaque token: hex SHA-256 (64 characters). */
export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
