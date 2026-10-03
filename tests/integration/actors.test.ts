import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { idempotency, MemoryIdempotencyStore } from '../../src/core/http/idempotency.js';
import { sendOne } from '../../src/core/http/response.js';
import { as, testActor } from '../helpers/actors.js';
import { buildTestApp } from '../helpers/test-app.js';

/** P0.06: tests can act as a given user, so per-user behaviour is testable before real login exists. */
describe('test actors', () => {
  function setup() {
    let runs = 0;
    const router = Router();
    router.use(testActor());
    router.post('/', idempotency({ store: new MemoryIdempotencyStore() }), (_req, res) => {
      runs += 1;
      sendOne(res, { run: runs });
    });
    const { app } = buildTestApp({}, [{ name: 'approve', path: '/approve', router }]);
    return { app, runs: () => runs };
  }

  it('idempotency keys are per user: the same key from two users runs twice', async () => {
    const { app, runs } = setup();
    const key = 'same-key-0001';
    await as(request(app).post('/api/v1/approve').set('Idempotency-Key', key), 'user-a').send({});
    await as(request(app).post('/api/v1/approve').set('Idempotency-Key', key), 'user-b').send({});
    expect(runs()).toBe(2);
  });

  it('and the same user retrying is replayed, not re-run', async () => {
    const { app, runs } = setup();
    const key = 'same-key-0002';
    await as(request(app).post('/api/v1/approve').set('Idempotency-Key', key), 'user-a').send({});
    const retry = await as(request(app).post('/api/v1/approve').set('Idempotency-Key', key), 'user-a').send(
      {},
    );
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(runs()).toBe(1);
  });
});
