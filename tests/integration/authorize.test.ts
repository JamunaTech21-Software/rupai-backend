import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { requirePermission, staticPermissionResolver } from '../../src/core/auth/authorize.js';
import { sendOne } from '../../src/core/http/response.js';
import { as } from '../helpers/actors.js';
import { buildTestApp } from '../helpers/test-app.js';

describe('requirePermission (P4 §4.1)', () => {
  function appWith(permissions: string[]) {
    const router = Router();
    let resolved = 0;
    const resolver = {
      permissionsOf: async (id: bigint) => {
        resolved += 1;
        return await staticPermissionResolver(permissions).permissionsOf(id);
      },
    };
    router.get(
      '/thing',
      requirePermission(resolver, 'thing.view'),
      requirePermission(resolver, 'thing.view'),
      (_q, res) => {
        sendOne(res, { ok: true });
      },
    );
    return { app: buildTestApp({}, [{ name: 't', path: '/t', router }]).app, resolved: () => resolved };
  }

  it('401 when nobody is signed in', async () => {
    const res = await request(appWith(['thing.view']).app).get('/api/v1/t/thing');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('403 PERMISSION_DENIED naming the missing permission', async () => {
    const res = await as(request(appWith(['other.view']).app).get('/api/v1/t/thing'), '7');
    expect(res.status).toBe(403);
    expect(res.body.error.details[0].context.permission).toBe('thing.view');
  });

  it('passes with the permission, resolving the set once per request', async () => {
    const t = appWith(['thing.view']);
    const res = await as(request(t.app).get('/api/v1/t/thing'), '7');
    expect(res.status).toBe(200);
    expect(t.resolved()).toBe(1);
  });

  it('refuses a malformed actor id as unauthenticated', async () => {
    const res = await as(request(appWith(['thing.view']).app).get('/api/v1/t/thing'), 'abc');
    expect(res.status).toBe(401);
  });
});
