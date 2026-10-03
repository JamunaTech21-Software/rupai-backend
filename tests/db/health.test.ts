import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from '../helpers/test-app.js';
import { url } from './helpers.js';

/** P0.04: readiness reports ready when the real database answers. */
describe('/health/ready against MySQL', () => {
  it('is 200 ready when the database is reachable', async () => {
    const { app } = buildTestApp({
      DATABASE_URL: url('app', 'rupai'),
      DB_ALLOW_PUBLIC_KEY_RETRIEVAL: 'true',
    });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ status: 'ready', checks: { database: 'ok' } });
  });
});
