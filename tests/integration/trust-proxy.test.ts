import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { sendOne } from '../../src/core/http/response.js';
import { buildTestApp } from '../helpers/test-app.js';

/**
 * Client IP behind proxies (P0.08). On staging a request passes Vercel (which sets X-Forwarded-For to
 * the user's IP), then Cloudflare (which appends Vercel's IP), then cloudflared (the TCP peer). With
 * TRUST_PROXY=2 the API must see the USER's address, because sign-in lockout and rate limits key on it.
 */
function ipApp(trustProxy: string) {
  const router = Router();
  router.get('/ip', (req, res) => {
    sendOne(res, { ip: req.ip });
  });
  return buildTestApp({ TRUST_PROXY: trustProxy }, [{ name: 'ip', path: '/t', router }]).app;
}

describe('TRUST_PROXY', () => {
  it('2 hops: the user’s IP, not Vercel’s or Cloudflare’s', async () => {
    const res = await request(ipApp('2'))
      .get('/api/v1/t/ip')
      .set('X-Forwarded-For', '203.0.113.7, 198.51.100.20');
    expect(res.body.data.ip).toBe('203.0.113.7');
  });

  it('a spoofed extra entry to the left is ignored', async () => {
    const res = await request(ipApp('2'))
      .get('/api/v1/t/ip')
      .set('X-Forwarded-For', '6.6.6.6, 203.0.113.7, 198.51.100.20');
    expect(res.body.data.ip).toBe('203.0.113.7');
  });

  it('loopback (the default) trusts only a local proxy; false trusts none', async () => {
    const res = await request(ipApp('loopback')).get('/api/v1/t/ip').set('X-Forwarded-For', '203.0.113.7');
    // Supertest connects over loopback, so the loopback proxy is trusted and one hop is read.
    expect(res.body.data.ip).toBe('203.0.113.7');
    const none = await request(ipApp('false')).get('/api/v1/t/ip').set('X-Forwarded-For', '203.0.113.7');
    expect(none.body.data.ip).not.toBe('203.0.113.7');
  });
});
