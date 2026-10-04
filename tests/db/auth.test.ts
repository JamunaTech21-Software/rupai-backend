import type { Express } from 'express';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config/env.js';
import { authenticate } from '../../src/core/auth/authenticate.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { tokenSigner } from '../../src/core/auth/tokens.js';
import { memoryPlatform, redisPlatform } from '../../src/core/platform.js';
import { createRedis, type RedisClient } from '../../src/core/redis/redis.js';
import { buildModules } from '../../src/modules/index.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import {
  createMigratedDatabase,
  silentLogger,
  TEST_BOOTSTRAP_PASSWORD,
  url,
  type MigratedDatabase,
} from './helpers.js';

/**
 * P1.02 — authentication and sessions, end to end: real migrations and seed, real argon2id, Redis for
 * the session cache. Every request here authenticates with a real access token.
 */

let mdb: MigratedDatabase;
let redis: RedisClient;
let config: Config;
let app: Express;
let deps: ReturnType<typeof testModuleDeps>;

let adminPassword = TEST_BOOTSTRAP_PASSWORD;

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  redis = createRedis(inject('testRedisUrl'));
  await redis.connect();
  config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  deps = testModuleDeps({
    config,
    db: mdb.db,
    logger: silentLogger(),
    platform: redisPlatform(redis),
    authz: dbPermissionResolver(mdb.db),
  });
  app = createApp({
    config,
    logger: deps.logger,
    db: mdb.db,
    platform: deps.platform,
    modules: buildModules(deps),
    authenticate: authenticate(deps),
  });
});
afterAll(async () => {
  await redis.quit();
  await mdb.drop();
});

// ---- helpers -----------------------------------------------------------------------------------

interface Session {
  access: string;
  cookie: string;
  sessionId: string;
  body: { must_change_password: boolean; user: { id: string; username: string } };
}

function refreshCookieOf(res: Response): string | null {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const c = raw?.find((v) => v.startsWith('rupai_refresh='));
  return c ? (c.split(';')[0] ?? null) : null;
}

async function login(username: string, password: string): Promise<Session> {
  const res = await request(app).post('/api/v1/auth/login').send({ username, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const cookie = refreshCookieOf(res);
  expect(cookie).toBeTruthy();
  return {
    access: res.body.data.access_token as string,
    cookie: cookie ?? '',
    sessionId: res.body.data.session_id as string,
    body: res.body.data as Session['body'],
  };
}

const bearer = (s: { access: string }) => ({ Authorization: `Bearer ${s.access}` });
const get = (path: string, s?: { access: string }) =>
  request(app)
    .get(`/api/v1${path}`)
    .set(s ? bearer(s) : {});
const post = (path: string, body: object | undefined, s?: { access: string }, version?: number) => {
  const r = request(app)
    .post(`/api/v1${path}`)
    .set(s ? bearer(s) : {});
  if (version !== undefined) r.set('If-Match', `"${String(version)}"`);
  return body === undefined ? r : r.send(body);
};
const refresh = (cookie: string) => request(app).post('/api/v1/auth/refresh').set('Cookie', cookie);

let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;

async function admin(): Promise<Session> {
  return login('admin', adminPassword);
}

/** A user created by the administrator, already past its first-login password change. */
async function newUser(opts: { email?: string; changePassword?: boolean } = {}) {
  const a = await admin();
  const username = unique('u');
  const res = await post(
    '/users',
    { username, initial_password: 'Initial-Password-1', ...(opts.email ? { email: opts.email } : {}) },
    a,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  let password = 'Initial-Password-1';
  if (opts.changePassword !== false) {
    const s = await login(username, password);
    password = 'Settled-Password-1';
    expect(
      (
        await post(
          '/auth/password/change',
          { current_password: 'Initial-Password-1', new_password: password },
          s,
        )
      ).status,
    ).toBe(204);
    await post('/auth/logout', undefined, s);
  }
  return { id: res.body.data.id as string, username, password };
}

// ---- sign-in -----------------------------------------------------------------------------------

describe('POST /auth/login', () => {
  it('signs the bootstrap administrator in with a temporary password (P3 §32.2)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('User-Agent', 'vitest-agent')
      .send({ username: 'admin', password: TEST_BOOTSTRAP_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      must_change_password: true,
      user: { id: '1', username: 'admin' },
    });
    expect(res.body.data).not.toHaveProperty('refresh_token');
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('rupai_refresh='),
    );
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    const row = await mdb.db.authSession.findUniqueOrThrow({
      where: { id: BigInt(res.body.data.session_id as string) },
    });
    expect(row.userAgent).toBe('vitest-agent');
  });

  it('gives the same answer for an unknown username and a wrong password', async () => {
    const unknown = await request(app).post('/api/v1/auth/login').send({ username: 'nobody', password: 'x' });
    const wrong = await request(app).post('/api/v1/auth/login').send({ username: 'admin', password: 'x' });
    for (const res of [unknown, wrong]) {
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(res.body.error.message).toBe('The username or password is incorrect.');
      expect(refreshCookieOf(res)).toBeNull();
    }
    await mdb.migrator.user.update({ where: { id: 1n }, data: { failedAttempts: 0 } });
  });

  it('only lets a temporary password reach the user’s own account until it is changed', async () => {
    const s = await login('admin', adminPassword);
    expect(s.body.must_change_password).toBe(true);
    const me = await get('/auth/me', s);
    expect(me.status).toBe(200);
    expect(me.body.data.must_change_password).toBe(true);
    const users = await get('/users', s);
    expect(users.status).toBe(403);
    expect(users.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const other = await login('admin', adminPassword);
    const change = (body: object) => post('/auth/password/change', body, s);
    expect(
      (await change({ current_password: 'wrong', new_password: 'Admin-Password-New-1' })).body.error,
    ).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [expect.objectContaining({ field: 'current_password' })],
    });
    expect(
      (await change({ current_password: adminPassword, new_password: adminPassword })).body.error.details[0]
        .field,
    ).toBe('new_password');
    expect((await change({ current_password: adminPassword, new_password: 'short' })).status).toBe(422);

    expect(
      (await change({ current_password: adminPassword, new_password: 'Admin-Password-New-1' })).status,
    ).toBe(204);
    adminPassword = 'Admin-Password-New-1';

    // This session continues, now unrestricted; every other session ended.
    expect((await get('/users', s)).status).toBe(200);
    expect((await get('/auth/me', s)).body.data.must_change_password).toBe(false);
    const ended = await get('/auth/me', other);
    expect(ended.status).toBe(401);
    expect(ended.body.error.code).toBe('SESSION_EXPIRED');
    expect((await refresh(other.cookie)).status).toBe(401);
    const user = await mdb.db.user.findUniqueOrThrow({ where: { id: 1n } });
    expect(user.mustChangePassword).toBe(false);
    expect(user.lastLoginAt).not.toBeNull();
  });
});

describe('access tokens on every request (P4 §2.2.1)', () => {
  it('401 UNAUTHENTICATED without a token or with a malformed or forged one', async () => {
    for (const auth of [undefined, 'Basic abc', 'Bearer not-a-token', 'Bearer a.b.c']) {
      const r = request(app).get('/api/v1/auth/me');
      const res = await (auth ? r.set('Authorization', auth) : r);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    }
    const foreign = tokenSigner({ secret: 'someone-elses-secret-0123456789abcdef', ttlSeconds: 900 });
    const res = await get('/auth/me', { access: foreign.sign(1n, 1n).token });
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('401 SESSION_EXPIRED for an expired token, so the client refreshes', async () => {
    const s = await admin();
    const past = tokenSigner(
      { secret: config.auth.tokenSecret, ttlSeconds: 900 },
      () => Date.now() - 3_600_000,
    );
    const res = await get('/auth/me', { access: past.sign(1n, BigInt(s.sessionId)).token });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('a token naming a session of another user is refused', async () => {
    const u = await newUser();
    const s = await login(u.username, u.password);
    const res = await get('/auth/me', { access: deps.signer.sign(1n, BigInt(s.sessionId)).token });
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('public endpoints still work with a stale Authorization header', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('Authorization', 'Bearer stale.stale.stale')
      .send({ username: 'admin', password: adminPassword });
    expect(res.status).toBe(200);
  });

  it('caches session state in Redis and tombstones it on revocation', async () => {
    const s = await admin();
    expect((await get('/auth/me', s)).status).toBe(200);
    expect(JSON.parse((await redis.get(`sess:${mdb.name}:${s.sessionId}`)) ?? 'null')).toMatchObject({
      u: '1',
      l: true,
    });
    expect((await post('/auth/logout', undefined, s)).status).toBe(204);
    expect(await redis.get(`sess:${mdb.name}:${s.sessionId}`)).toBe('revoked');
  });

  it('a role change applies to the very next request, without a new token (P1 §12.4)', async () => {
    const u = await newUser();
    const s = await login(u.username, u.password);
    expect((await get('/roles', s)).status).toBe(403);
    const a = await admin();
    const role = await post(
      '/roles',
      { code: unique('VIEWER_'), name: 'Viewer', permissions: ['role.view'] },
      a,
    );
    const current = await get(`/users/${u.id}`, a);
    expect(
      (
        await post(
          `/users/${u.id}/roles`,
          { roles: [{ role_id: role.body.data.id }] },
          a,
          current.body.data.version as number,
        )
      ).status,
    ).toBe(200);
    expect((await get('/roles', s)).status).toBe(200);
    expect((await get('/auth/me', s)).body.data.permissions).toEqual(['role.view']);
  });
});

// ---- refresh -----------------------------------------------------------------------------------

describe('POST /auth/refresh (rotation and reuse detection)', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const s = await admin();
    const res = await refresh(s.cookie);
    expect(res.status).toBe(200);
    const next = refreshCookieOf(res);
    expect(next).toBeTruthy();
    expect(next).not.toBe(s.cookie);
    expect(res.body.data.session_id).toBe(s.sessionId);
    expect((await get('/auth/me', { access: res.body.data.access_token as string })).status).toBe(200);
    expect((await refresh(next ?? '')).status).toBe(200);
  });

  it('replaying a used refresh token ends the whole family (theft)', async () => {
    const s = await admin();
    const first = await refresh(s.cookie);
    const stolen = s.cookie;
    const latest = refreshCookieOf(first) ?? '';
    const access = first.body.data.access_token as string;

    const replay = await refresh(stolen);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('SESSION_EXPIRED');

    // Everyone holding this family is out: the legitimate user's newest refresh token and access token too.
    expect((await refresh(latest)).status).toBe(401);
    expect((await get('/auth/me', { access })).body.error.code).toBe('SESSION_EXPIRED');
    const session = await mdb.db.authSession.findUniqueOrThrow({ where: { id: BigInt(s.sessionId) } });
    expect(session.revokedReason).toBe('refresh_reuse');
  });

  it('401 SESSION_EXPIRED and a cleared cookie without a valid refresh token', async () => {
    for (const cookie of [
      undefined,
      'rupai_refresh=garbage',
      'rupai_refresh=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ]) {
      const r = request(app).post('/api/v1/auth/refresh');
      const res = await (cookie ? r.set('Cookie', cookie) : r);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('SESSION_EXPIRED');
      expect(refreshCookieOf(res)).toBe('rupai_refresh=');
    }
  });

  it('an expired refresh token cannot be used', async () => {
    const s = await admin();
    await mdb.migrator.$executeRaw`
      UPDATE auth_refresh_token SET issued_at = UTC_TIMESTAMP() - INTERVAL 2 DAY, expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND
       WHERE session_id = ${BigInt(s.sessionId)}`;
    expect((await refresh(s.cookie)).status).toBe(401);
  });
});

// ---- logout and sessions -----------------------------------------------------------------------

describe('logout and session management', () => {
  it('logout ends the session at once: access token and refresh token', async () => {
    const s = await admin();
    const res = await post('/auth/logout', undefined, s);
    expect(res.status).toBe(204);
    expect(refreshCookieOf(res)).toBe('rupai_refresh=');
    expect((await get('/auth/me', s)).body.error.code).toBe('SESSION_EXPIRED');
    expect((await refresh(s.cookie)).status).toBe(401);
  });

  it('logout works with only the refresh cookie (expired access token), and always answers 204', async () => {
    const s = await admin();
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', s.cookie)).status).toBe(204);
    expect((await refresh(s.cookie)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(204);
  });

  it('lists my live sessions, marks the current one, and ends another one', async () => {
    const u = await newUser();
    const here = await login(u.username, u.password);
    const there = await login(u.username, u.password);
    const list = await get('/auth/sessions', here);
    expect(list.status).toBe(200);
    expect(list.body.meta.pagination.total).toBe(2);
    const mine = list.body.data as { id: string; current: boolean }[];
    expect(mine.find((x) => x.current)?.id).toBe(here.sessionId);

    const end = await request(app).delete(`/api/v1/auth/sessions/${there.sessionId}`).set(bearer(here));
    expect(end.status).toBe(204);
    expect((await get('/auth/me', there)).body.error.code).toBe('SESSION_EXPIRED');
    expect((await get('/auth/me', here)).status).toBe(200);
    expect((await get('/auth/sessions', here)).body.meta.pagination.total).toBe(1);
  });

  it('another user’s session is 404, not revocable', async () => {
    const u = await newUser();
    const s = await login(u.username, u.password);
    const a = await admin();
    const res = await request(app).delete(`/api/v1/auth/sessions/${a.sessionId}`).set(bearer(s));
    expect(res.status).toBe(404);
    expect((await get('/auth/me', a)).status).toBe(200);
  });

  it('logout-all ends every session of the user', async () => {
    const u = await newUser();
    const one = await login(u.username, u.password);
    const two = await login(u.username, u.password);
    expect((await post('/auth/logout-all', undefined, one)).status).toBe(204);
    for (const s of [one, two]) expect((await get('/auth/me', s)).status).toBe(401);
  });
});

// ---- lockout and disabled accounts ---------------------------------------------------------------

describe('lockout (P1 §12.4) and disabled users', () => {
  it('locks the account after five failures; only the right password learns it is locked', async () => {
    const u = await newUser();
    const attempt = (password: string) =>
      request(app).post('/api/v1/auth/login').send({ username: u.username, password });
    for (let i = 0; i < 5; i += 1)
      expect((await attempt('wrong-password')).body.error.code).toBe('INVALID_CREDENTIALS');

    const locked = await attempt(u.password);
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');
    expect(locked.body.error.details[0].context.retry_after_seconds).toBeGreaterThan(800);
    expect((await attempt('wrong-password')).body.error.code).toBe('INVALID_CREDENTIALS');

    // Once the lock has passed, the right password works and the counter is clean.
    await mdb.migrator.user.update({
      where: { id: BigInt(u.id) },
      data: { lockedUntil: new Date(Date.now() - 1000) },
    });
    expect((await attempt(u.password)).status).toBe(200);
    const row = await mdb.db.user.findUniqueOrThrow({ where: { id: BigInt(u.id) } });
    expect(row.failedAttempts).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });

  it('counts failures across attempts and resets the count on success', async () => {
    const u = await newUser();
    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/api/v1/auth/login').send({ username: u.username, password: 'nope' });
    }
    expect((await mdb.db.user.findUniqueOrThrow({ where: { id: BigInt(u.id) } })).failedAttempts).toBe(3);
    await login(u.username, u.password);
    expect((await mdb.db.user.findUniqueOrThrow({ where: { id: BigInt(u.id) } })).failedAttempts).toBe(0);
  });

  it('a disabled user loses access immediately, not at token expiry (P1.02 verify)', async () => {
    const u = await newUser();
    const s = await login(u.username, u.password);
    expect((await get('/auth/me', s)).status).toBe(200); // now cached in Redis as live

    const a = await admin();
    const current = await get(`/users/${u.id}`, a);
    const off = await post(`/users/${u.id}/deactivate`, undefined, a, current.body.data.version as number);
    expect(off.status).toBe(200);

    const after = await get('/auth/me', s);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_EXPIRED');
    expect((await refresh(s.cookie)).status).toBe(401);
    const session = await mdb.db.authSession.findUniqueOrThrow({ where: { id: BigInt(s.sessionId) } });
    expect(session.revokedReason).toBe('user_disabled');

    const again = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: u.username, password: u.password });
    expect(again.body.error).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      details: [{ code: 'ACCOUNT_DISABLED' }],
    });
  });
});

// ---- password reset ----------------------------------------------------------------------------

describe('forgot and reset password', () => {
  const tokenFrom = (text: string) => /#token=([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? '';

  it('always answers 202, and sends nothing for an unknown address', async () => {
    const before = deps.mailer.sent.length;
    const res = await post('/auth/password/forgot', { email: 'nobody@example.com' });
    expect(res.status).toBe(202);
    expect(res.body.data.message).toMatch(/If an account uses this address/);
    expect(deps.mailer.sent.length).toBe(before);
  });

  it('emails a single-use link; the reset sets the password and ends every session', async () => {
    const email = `${unique('reset')}@example.com`;
    const u = await newUser({ email });
    const s = await login(u.username, u.password);

    expect((await post('/auth/password/forgot', { email })).status).toBe(202);
    const mail = deps.mailer.sent.at(-1);
    expect(mail?.to).toBe(email);
    expect(mail?.text).toContain('http://localhost:5173/reset-password#token=');
    const token = tokenFrom(mail?.text ?? '');
    const stored = await mdb.db.passwordResetToken.findFirstOrThrow({ where: { userId: BigInt(u.id) } });
    expect(stored.tokenHash).not.toContain(token); // only the hash is stored

    expect((await post('/auth/password/reset', { token, new_password: 'Brand-New-Password-1' })).status).toBe(
      204,
    );
    expect((await get('/auth/me', s)).status).toBe(401);
    const old = await request(app)
      .post('/api/v1/auth/login')
      .send({ username: u.username, password: u.password });
    expect(old.body.error.code).toBe('INVALID_CREDENTIALS');
    await login(u.username, 'Brand-New-Password-1');

    const reuse = await post('/auth/password/reset', { token, new_password: 'Another-Password-1' });
    expect(reuse.status).toBe(422);
    expect(reuse.body.error.details[0].field).toBe('token');
  });

  it('a newer link replaces an older one, and a reset clears a lockout', async () => {
    const email = `${unique('relink')}@example.com`;
    const u = await newUser({ email });
    await post('/auth/password/forgot', { email });
    const first = tokenFrom(deps.mailer.sent.at(-1)?.text ?? '');
    await post('/auth/password/forgot', { email });
    const second = tokenFrom(deps.mailer.sent.at(-1)?.text ?? '');
    expect(
      (await post('/auth/password/reset', { token: first, new_password: 'Never-Applied-1' })).status,
    ).toBe(422);

    await mdb.migrator.user.update({
      where: { id: BigInt(u.id) },
      data: { lockedUntil: new Date(Date.now() + 600_000) },
    });
    expect(
      (await post('/auth/password/reset', { token: second, new_password: 'After-Reset-Pass-1' })).status,
    ).toBe(204);
    await login(u.username, 'After-Reset-Pass-1');
  });

  it('an expired link is refused', async () => {
    const email = `${unique('late')}@example.com`;
    const u = await newUser({ email });
    await post('/auth/password/forgot', { email });
    const token = tokenFrom(deps.mailer.sent.at(-1)?.text ?? '');
    await mdb.migrator.$executeRaw`
      UPDATE password_reset_token SET created_at = UTC_TIMESTAMP() - INTERVAL 2 HOUR,
             expires_at = UTC_TIMESTAMP() - INTERVAL 1 HOUR WHERE user_id = ${BigInt(u.id)}`;
    expect((await post('/auth/password/reset', { token, new_password: 'Too-Late-Password-1' })).status).toBe(
      422,
    );
  });
});

// ---- /auth/me, database rights, rate limits ------------------------------------------------------

describe('GET /auth/me', () => {
  it('returns the user, roles and flattened permissions, never the password', async () => {
    const s = await admin();
    const res = await get('/auth/me', s);
    expect(res.body.data.user).toMatchObject({ id: '1', username: 'admin' });
    expect((res.body.data.user.roles as { code: string }[]).map((r) => r.code)).toEqual(['ADMINISTRATOR']);
    expect(res.body.data.permissions).toContain('user.create');
    expect(res.body.data.session_id).toBe(s.sessionId);
    expect(res.body.data.scope).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/password_hash|argon2/);
  });
});

describe('database rights', () => {
  it('sessions and tokens are revoked or marked used, never deleted, by the application', async () => {
    await expect(mdb.db.$executeRaw`DELETE FROM auth_session`).rejects.toThrow(/denied/i);
    await expect(mdb.db.$executeRaw`DELETE FROM auth_refresh_token`).rejects.toThrow(/denied/i);
    await expect(mdb.db.$executeRaw`DELETE FROM password_reset_token`).rejects.toThrow(/denied/i);
  });

  it('a revoked session always records why', async () => {
    await expect(
      mdb.migrator.$executeRaw`UPDATE auth_session SET revoked_at = UTC_TIMESTAMP(), revoked_reason = NULL`,
    ).rejects.toThrow(/ck_auth_session_revoked_pair/);
  });
});

describe('auth rate limits (P4 §2.9)', () => {
  it('limits sign-in attempts per username', async () => {
    const limited = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name) });
    const d = testModuleDeps({
      config: limited,
      db: mdb.db,
      logger: silentLogger(),
      platform: memoryPlatform(),
    });
    const limitedApp = createApp({
      config: limited,
      logger: d.logger,
      db: mdb.db,
      platform: d.platform,
      modules: buildModules(d),
      authenticate: authenticate(d),
    });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(limitedApp)
        .post('/api/v1/auth/login')
        .send({ username: 'ghost', password: 'x' });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });
});
