import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { getLogger } from '../../src/core/logging/logger.js';
import { buildTestApp } from '../helpers/test-app.js';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe('request id', () => {
  it('generates a ULID request id and returns it in X-Request-Id', async () => {
    const res = await request(buildTestApp().app).get('/x');
    expect(res.headers['x-request-id']).toMatch(ULID);
  });

  it('generates a different id per request', async () => {
    const { app } = buildTestApp();
    const a = await request(app).get('/x');
    const b = await request(app).get('/x');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('adopts a safe caller-supplied id', async () => {
    const res = await request(buildTestApp().app).get('/x').set('X-Request-Id', 'client-trace-12345');
    expect(res.headers['x-request-id']).toBe('client-trace-12345');
  });

  it.each([
    ['too short', 'abc'],
    ['unsafe characters', 'abc def <script>'],
    ['too long', 'a'.repeat(65)],
  ])('replaces an unsafe caller-supplied id (%s)', async (_label, value) => {
    const res = await request(buildTestApp().app).get('/x').set('X-Request-Id', value);
    expect(res.headers['x-request-id']).toMatch(ULID);
  });
});

describe('structured request logging', () => {
  it('writes one completion line per request carrying request_id, method, url and status', async () => {
    const { app, logs } = buildTestApp();
    const res = await request(app).get('/missing');
    const line = logs.lines.find((l) => l.msg === 'request completed');

    expect(line).toBeDefined();
    expect(line?.request_id).toBe(res.headers['x-request-id']);
    expect(line?.req).toMatchObject({ method: 'GET', url: '/missing' });
    expect(line?.res).toMatchObject({ status_code: 404 });
    expect(line?.level).toBe('warn');
    expect(line?.service).toBe('rupai-backend');
    expect(line?.env).toBe('test');
  });

  it('gives code inside the request a logger bound to the same request_id', async () => {
    const { app, logger, logs } = buildTestApp();
    app.get('/work', (_req, res) => {
      getLogger(logger).info('doing work');
      res.status(204).end();
    });

    const res = await request(app).get('/work');
    const line = logs.lines.find((l) => l.msg === 'doing work');
    expect(line?.request_id).toBe(res.headers['x-request-id']);
  });

  it('never logs request headers such as Authorization', async () => {
    const { app, logs } = buildTestApp();
    await request(app).get('/x').set('Authorization', 'Bearer super-secret-token');
    expect(logs.text).not.toContain('super-secret-token');
  });
});

describe('log redaction', () => {
  it('redacts credentials, tokens, NIDs and bank details at top level and one level deep', () => {
    const { logger, logs } = buildTestApp();
    logger.info(
      {
        password: 'p@ss',
        refresh_token: 'rt-123',
        user: { national_id: '1990123456789', bank_account_number: '0011223344', name: 'Rahim' },
      },
      'sensitive',
    );
    const line = logs.lines.find((l) => l.msg === 'sensitive');

    expect(line?.password).toBe('[REDACTED]');
    expect(line?.refresh_token).toBe('[REDACTED]');
    expect(line?.user).toEqual({
      national_id: '[REDACTED]',
      bank_account_number: '[REDACTED]',
      name: 'Rahim',
    });
    expect(logs.text).not.toMatch(/p@ss|rt-123|1990123456789|0011223344/);
  });
});

describe('environment header', () => {
  it('names the environment on non-production', async () => {
    const res = await request(buildTestApp({ APP_ENV: 'staging' }).app).get('/x');
    expect(res.headers['x-environment']).toBe('staging');
  });

  it('is absent in production', async () => {
    const res = await request(buildTestApp({ APP_ENV: 'production', NODE_ENV: 'production' }).app).get('/x');
    expect(res.headers['x-environment']).toBeUndefined();
  });
});
