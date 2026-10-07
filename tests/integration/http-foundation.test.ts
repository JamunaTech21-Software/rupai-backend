import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ApiModule } from '../../src/app.js';
import { assertVersion, requireIfMatch } from '../../src/core/http/concurrency.js';
import { idempotency, MemoryIdempotencyStore } from '../../src/core/http/idempotency.js';
import { getListQuery, listQuery } from '../../src/core/http/list-query.js';
import { createRateLimiter } from '../../src/core/http/rate-limit.js';
import { sendCreated, sendOne, sendPage } from '../../src/core/http/response.js';
import { getValidated, validate } from '../../src/core/http/validate.js';
import { buildTestApp } from '../helpers/test-app.js';

/**
 * Drives the real middleware stack through a throwaway "widgets" module, the same way every business
 * module will use it.
 */
function widgetsModule() {
  const store = new MemoryIdempotencyStore();
  let version = 1;
  let approvals = 0;
  // A slow request (X-Slow) announces it is inside the handler and waits to be released, so a race
  // test is deterministic rather than dependent on timing.
  let entered!: () => void;
  let release!: () => void;
  const slow = {
    entered: new Promise<void>((r) => (entered = r)),
    released: new Promise<void>((r) => (release = r)),
    release: () => {
      release();
    },
  };
  const router = Router();

  const createSchema = {
    body: z.strictObject({
      name: z.string().min(1, 'is required'),
      lines: z
        .array(z.strictObject({ quantity: z.string().regex(/^\d+\.\d{3}$/, 'must have 3 decimals') }))
        .min(1),
    }),
  };
  const updateSchema = { params: z.object({ id: z.string().regex(/^\d+$/, 'must be numeric') }) };

  router.get(
    '/',
    listQuery({
      filters: { state: { type: { enum: ['draft', 'approved'] } } },
      sorts: ['name'],
      pagination: 'page',
    }),
    (req, res) => {
      const q = getListQuery(res);
      const page = q.page ?? { page: 1, perPage: 25 };
      sendPage(req, res, [{ id: 1n, name: 'Widget', amount: '12345.6700' }], { pagination: page, total: 60 });
    },
  );
  router.post('/', validate(createSchema), (_req, res) => {
    const { body } = getValidated(res, createSchema);
    sendCreated(
      res,
      { id: 9007199254740993n, name: body.name, version: 1 },
      '/api/v1/widgets/9007199254740993',
      1,
    );
  });
  router.put('/:id', validate(updateSchema), (req, res) => {
    const expected = requireIfMatch(req);
    assertVersion(expected, version, { id: '1', version });
    version += 1;
    sendOne(res, { id: '1', version }, { version });
  });
  router.post('/:id/approve', idempotency({ store }), async (req, res) => {
    approvals += 1;
    if (req.get('X-Slow')) {
      entered();
      await Promise.race([slow.released, new Promise((r) => setTimeout(r, 5_000))]);
    }
    sendOne(res, { id: req.params.id, state: 'approved', approval_count: approvals });
  });
  router.get('/boom', () => {
    throw new Error('database password is hunter2');
  });
  router.get('/limited', createRateLimiter({ name: 'test', limit: 2, windowMs: 60_000 }), (_req, res) => {
    sendOne(res, { ok: true });
  });

  const module: ApiModule = { name: 'widgets', path: '/widgets', router };
  return { module, approvals: () => approvals, slow };
}

function setup(env: Record<string, string> = {}) {
  const w = widgetsModule();
  const t = buildTestApp(env, [w.module]);
  return { ...t, approvals: w.approvals, slow: w.slow };
}

describe('security headers', () => {
  it('sends API-appropriate security headers', async () => {
    const res = await request(setup().app).get('/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });

  it('sends HSTS only once a certificate is in place', async () => {
    const res = await request(setup({ HSTS_ENABLED: 'true' }).app).get('/health');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
  });
});

describe('CORS (Spec P4 §2.2.2)', () => {
  const env = { CORS_ORIGINS: 'https://erp.example.com' };

  it('answers a preflight from an allowed origin with the exact origin and enumerated headers', async () => {
    const res = await request(setup(env).app)
      .options('/api/v1/widgets')
      .set('Origin', 'https://erp.example.com')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,if-match');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://erp.example.com');
    expect(res.headers['access-control-allow-headers']).toBe(
      'Authorization,Content-Type,If-Match,Idempotency-Key',
    );
    expect(res.headers['access-control-max-age']).toBe('600');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('never reflects an unlisted origin and never uses a wildcard', async () => {
    const res = await request(setup(env).app).get('/api/v1/widgets').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('exposes ETag, X-Request-Id and Retry-After to the browser', async () => {
    const res = await request(setup(env).app).get('/api/v1/widgets').set('Origin', 'https://erp.example.com');
    expect(res.headers['access-control-expose-headers']).toContain('ETag');
    expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
    expect(res.headers['access-control-expose-headers']).toContain('Retry-After');
  });
});

describe('response envelope (Spec P4 §2.4)', () => {
  it('wraps a collection with pagination meta, links and the request id', async () => {
    const res = await request(setup().app).get('/api/v1/widgets?page=2&per_page=20');
    expect(res.status).toBe(200);
    expect(res.body.meta.request_id).toBe(res.headers['x-request-id']);
    expect(res.body.meta.pagination).toEqual({ page: 2, per_page: 20, total: 60, last_page: 3 });
    expect(res.body.links).toEqual({
      first: '/api/v1/widgets?page=1&per_page=20',
      prev: '/api/v1/widgets?page=1&per_page=20',
      next: '/api/v1/widgets?page=3&per_page=20',
      last: '/api/v1/widgets?page=3&per_page=20',
    });
  });

  it('serialises BigInt ids as strings and money as decimal strings', async () => {
    const res = await request(setup().app).get('/api/v1/widgets');
    expect(res.body.data[0]).toEqual({ id: '1', name: 'Widget', amount: '12345.6700' });
  });

  it('reports the clamped per_page, not what was asked', async () => {
    const res = await request(setup().app).get('/api/v1/widgets?per_page=1000');
    expect(res.body.meta.pagination.per_page).toBe(200);
  });

  it('returns 201 with Location, ETag and a single-resource envelope', async () => {
    const res = await request(setup().app)
      .post('/api/v1/widgets')
      .send({ name: 'W', lines: [{ quantity: '37.000' }] });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe('/api/v1/widgets/9007199254740993');
    expect(res.headers.etag).toBe('"1"');
    expect(res.body.data.id).toBe('9007199254740993'); // beyond Number.MAX_SAFE_INTEGER, intact
  });

  it('does not send Express body-hash ETags (ETag means version here)', async () => {
    const res = await request(setup().app).get('/api/v1/widgets');
    expect(res.headers.etag).toBeUndefined();
  });
});

describe('error envelope (Spec P4 §3)', () => {
  it('unknown routes: 404 NOT_FOUND in the envelope', async () => {
    const res = await request(setup().app).get('/api/v1/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'No such endpoint.',
        details: [],
        request_id: res.headers['x-request-id'],
      },
    });
  });

  it('validation: 422 with dot/index field paths and unknown body keys refused', async () => {
    const res = await request(setup().app)
      .post('/api/v1/widgets')
      .send({ name: '', lines: [{ quantity: '37' }], hack: true });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const fields = (res.body.error.details as { field?: string }[]).map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'lines.0.quantity']));
    expect(JSON.stringify(res.body)).toContain('hack');
  });

  it('path parameters are validated too', async () => {
    const res = await request(setup().app).put('/api/v1/widgets/abc').set('If-Match', '"1"').send({});
    expect(res.status).toBe(422);
    expect(res.body.error.details[0].field).toBe('params.id');
  });

  it('unknown list filter: 422 UNKNOWN_FILTER naming the permitted fields', async () => {
    const res = await request(setup().app).get('/api/v1/widgets?filter[cost]=1');
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('UNKNOWN_FILTER');
    expect(res.body.error.details[0].context.permitted).toEqual(['state']);
  });

  it('malformed JSON: 400 MALFORMED_REQUEST', async () => {
    const res = await request(setup().app)
      .post('/api/v1/widgets')
      .set('Content-Type', 'application/json')
      .send('{"name":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_REQUEST');
  });

  it('non-JSON body: 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await request(setup().app)
      .post('/api/v1/widgets')
      .set('Content-Type', 'text/plain')
      .send('hello');
    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('an empty POST re-encoded as chunked by a proxy (no Content-Type) is not refused', async () => {
    // The Cloudflare tunnel delivers a browser's bodiless POST (refresh, logout, approve) this way.
    const res = await request(setup().app)
      .post('/api/v1/widgets/5/approve')
      .set('Idempotency-Key', crypto.randomUUID())
      .set('Transfer-Encoding', 'chunked')
      .send();
    expect(res.status).toBe(200);
  });

  it('oversized body: 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(setup({ BODY_LIMIT: '1kb' }).app)
      .post('/api/v1/widgets')
      .send({ name: 'x'.repeat(2000), lines: [{ quantity: '1.000' }] });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('unexpected errors: 500 with no internal detail leaked, but logged in full', async () => {
    const { app, logs } = setup();
    const res = await request(app).get('/api/v1/widgets/boom');
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
    expect(res.body.error.request_id).toBe(res.headers['x-request-id']);
    const logged = logs.lines.find((l) => l.msg === 'unhandled error');
    expect(logged?.request_id).toBe(res.headers['x-request-id']);
  });
});

describe('optimistic concurrency over HTTP (Spec P4 §5.1)', () => {
  it('missing If-Match → 422 PRECONDITION_REQUIRED; stale → 409 with current version; current → 200 + new ETag', async () => {
    const { app } = setup();
    const missing = await request(app).put('/api/v1/widgets/1').send({});
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('PRECONDITION_REQUIRED');

    const ok = await request(app).put('/api/v1/widgets/1').set('If-Match', '"1"').send({});
    expect(ok.status).toBe(200);
    expect(ok.headers.etag).toBe('"2"');

    const stale = await request(app).put('/api/v1/widgets/1').set('If-Match', '"1"').send({});
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details[0].context.version).toBe(2);
  });
});

describe('Idempotency-Key (Spec P4 §5.2)', () => {
  const key = 'approve-0001-attempt';

  it('a retried approval with the same key is answered from storage, not executed twice', async () => {
    const { app, approvals } = setup();
    const first = await request(app).post('/api/v1/widgets/5/approve').set('Idempotency-Key', key).send({});
    const retry = await request(app).post('/api/v1/widgets/5/approve').set('Idempotency-Key', key).send({});
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect(approvals()).toBe(1);
  });

  it('the same key with a different request is refused: 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const { app } = setup();
    await request(app).post('/api/v1/widgets/5/approve').set('Idempotency-Key', key).send({ comment: 'a' });
    const res = await request(app)
      .post('/api/v1/widgets/5/approve')
      .set('Idempotency-Key', key)
      .send({ comment: 'b' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('a duplicate arriving while the first is still running: 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const { app, approvals, slow } = setup();
    const first = request(app)
      .post('/api/v1/widgets/6/approve')
      .set('Idempotency-Key', key)
      .set('X-Slow', '1')
      .send({})
      .then((r) => r);
    await slow.entered; // the first request now holds the key
    const b = await request(app).post('/api/v1/widgets/6/approve').set('Idempotency-Key', key).send({});
    slow.release();
    const a = await first;
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');
    expect(b.headers['retry-after']).toBe('1');
    expect(approvals()).toBe(1);
  });

  it('without a key the request simply runs', async () => {
    const { app, approvals } = setup();
    await request(app).post('/api/v1/widgets/7/approve').send({});
    await request(app).post('/api/v1/widgets/7/approve').send({});
    expect(approvals()).toBe(2);
  });

  it('rejects a malformed key', async () => {
    const res = await request(setup().app)
      .post('/api/v1/widgets/7/approve')
      .set('Idempotency-Key', 'bad key!')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('rate limiting (Spec P4 §2.9)', () => {
  it('answers 429 RATE_LIMITED with Retry-After once the class limit is exceeded', async () => {
    const { app } = setup();
    await request(app).get('/api/v1/widgets/limited').expect(200);
    await request(app).get('/api/v1/widgets/limited').expect(200);
    const res = await request(app).get('/api/v1/widgets/limited');
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('applies the default read limit to every /api/v1 route', async () => {
    const res = await request(setup().app).get('/api/v1/widgets');
    expect(res.headers['ratelimit-policy']).toContain('120');
  });

  it('can be disabled (tests only; refused in production by config)', async () => {
    const res = await request(setup({ RATE_LIMIT_ENABLED: 'false' }).app).get('/api/v1/widgets');
    expect(res.headers['ratelimit-policy']).toBeUndefined();
  });
});

describe('health endpoints', () => {
  it('/health reports liveness, version and commit without touching dependencies', async () => {
    const res = await request(setup({ APP_VERSION: '1.4.0', BUILD_COMMIT: 'abc1234' }).app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ok', version: '1.4.0', commit: 'abc1234' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('/health/ready is 503 when the database is unreachable, without revealing why', async () => {
    const res = await request(setup({ DATABASE_URL: 'mysql://nobody:nothing@127.0.0.1:1/none' }).app).get(
      '/health/ready',
    );
    expect(res.status).toBe(503);
    expect(res.body.data).toEqual({ status: 'not_ready', checks: { database: 'failing' } });
  });

  it('health probes are not logged (they would bury real traffic)', async () => {
    const { app, logs } = setup();
    await request(app).get('/health');
    expect(logs.lines.find((l) => l.msg === 'request completed')).toBeUndefined();
  });
});
