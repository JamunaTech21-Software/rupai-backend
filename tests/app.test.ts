import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildTestApp } from './helpers/test-app.js';

describe('createApp', () => {
  it('builds an app without binding a port', () => {
    const { app } = buildTestApp();
    expect(typeof app.listen).toBe('function');
  });

  it('does not advertise the framework', async () => {
    const res = await request(buildTestApp().app).get('/');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns 404 for an unknown route', async () => {
    const res = await request(buildTestApp().app).get('/does-not-exist');
    expect(res.status).toBe(404);
  });
});
