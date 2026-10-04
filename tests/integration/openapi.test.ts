import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sendCreated, sendOne, sendPage } from '../../src/core/http/response.js';
import { getListQuery } from '../../src/core/http/list-query.js';
import { buildOpenApi } from '../../src/core/http/openapi.js';
import { staticPermissionResolver } from '../../src/core/auth/authorize.js';
import { createDatabase } from '../../src/core/db/prisma.js';
import { defineModule, type RouteSpec } from '../../src/core/http/route.js';
import { zId } from '../../src/core/ids/ids.js';
import { zDecimal } from '../../src/core/money/decimal.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { loadConfig } from '../../src/config/env.js';
import { as } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { buildTestApp, TEST_ENV } from '../helpers/test-app.js';

const authz = staticPermissionResolver('all');

/** A representative module declared the way every business module will be. */
function salesModule() {
  const m = defineModule({ name: 'sales', path: '/sales', tag: 'Sales', platform: memoryPlatform(), authz });
  const Sale = z.object({
    id: z.string(),
    sale_number: z.string(),
    net_amount: z.string(),
    version: z.number(),
  });
  m.route({
    method: 'get',
    path: '/',
    summary: 'List sales',
    auth: { permission: 'sale.view' },
    list: {
      filters: { state: { type: { enum: ['draft', 'approved'] } }, sale_date: { type: 'date' } },
      sorts: ['sale_date'],
      includes: ['lines'],
      pagination: 'page',
    },
    success: { status: 200, description: 'A page of sales', schema: Sale },
    errors: [],
    handler: (req, res) => {
      const page = getListQuery(res).page ?? { page: 1, perPage: 25 };
      sendPage(req, res, [], { pagination: page, total: 0 });
    },
  })
    .route({
      method: 'post',
      path: '/',
      summary: 'Create a draft sale',
      auth: { permission: 'sale.create' },
      body: z.strictObject({
        buyer_id: zId,
        lines: z.array(z.strictObject({ quantity: zDecimal('qty') })).min(1),
      }),
      success: { status: 201, description: 'Created in draft', schema: Sale },
      errors: ['INSUFFICIENT_STOCK'],
      handler: (_req, res) => {
        sendCreated(
          res,
          { id: '1', sale_number: 'SL-1', net_amount: '0.0000', version: 1 },
          '/api/v1/sales/1',
          1,
        );
      },
    })
    .route({
      method: 'post',
      path: '/:id/approve',
      summary: 'Approve a sale',
      auth: { permission: 'sale.approve' },
      params: z.object({ id: zId }),
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: 'Approved', schema: Sale },
      errors: ['LOT_ALREADY_SOLD', 'INSUFFICIENT_STOCK', 'PERIOD_CLOSED'],
      handler: (_req, res) => {
        sendOne(res, { id: '1', sale_number: 'SL-1', net_amount: '0.0000', version: 2 });
      },
    });
  return m.build();
}

describe('route declarations are checked at start-up (the P0.07 "every endpoint declares" gate)', () => {
  const base: RouteSpec = {
    method: 'get',
    path: '/',
    summary: 'x',
    auth: { permission: 'thing.view' },
    success: { status: 200, description: 'ok' },
    errors: [],
    handler: (_req, res) => res.end(),
  };
  const declare = (spec: Partial<RouteSpec>) => () =>
    defineModule({ name: 't', path: '/t', tag: 'T', platform: memoryPlatform(), authz }).route({
      ...base,
      ...spec,
    });

  it('accepts a complete declaration', () => {
    expect(declare({})).not.toThrow();
  });

  it('refuses a malformed permission', () => {
    expect(declare({ auth: { permission: 'approve' } })).toThrow(/module\.action/);
  });

  it('refuses a public endpoint without a reason', () => {
    expect(declare({ auth: { public: true, reason: ' ' } })).toThrow(
      /public or signed-in endpoint must give a reason/,
    );
  });

  it('refuses a route without declared error codes', () => {
    expect(declare({ errors: undefined as unknown as [] })).toThrow(/errors must be declared/);
  });

  it('refuses a list without declared filters or sorts', () => {
    expect(declare({ list: { pagination: 'page' } })).toThrow(/declare its filters[\s\S]*declare its sorts/);
  });

  it('every module the application mounts is well declared', () => {
    const db = createDatabase({
      database: { url: TEST_ENV.DATABASE_URL, poolSize: 1, allowPublicKeyRetrieval: false },
    });
    const config = loadConfig({ ...TEST_ENV });
    expect(() => buildModules(testModuleDeps({ config, db, authz }))).not.toThrow();
  });
});

describe('generated OpenAPI 3.1 document', () => {
  const doc = buildOpenApi([salesModule()], { version: '1.2.3' }) as {
    openapi: string;
    info: { version: string };
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const list = doc.paths['/api/v1/sales']?.get ?? {};
  const create = doc.paths['/api/v1/sales']?.post ?? {};
  const approve = doc.paths['/api/v1/sales/{id}/approve']?.post ?? {};

  it('is OpenAPI 3.1 and includes the health endpoints', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.version).toBe('1.2.3');
    expect(doc.paths['/health']?.get).toBeDefined();
    expect(doc.paths['/health/ready']?.get).toBeDefined();
  });

  it('records the permission and requires a bearer token', () => {
    expect(approve['x-permission']).toBe('sale.approve');
    expect(approve.security).toEqual([{ bearerAuth: [] }]);
  });

  it('documents the declared filters, sorts, includes and pagination of a list', () => {
    const names = (list.parameters as { name: string }[]).map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'filter[state]',
        'filter[state][in]',
        'filter[sale_date][from]',
        'filter[sale_date][to]',
        'sort',
        'include',
        'page',
        'per_page',
      ]),
    );
  });

  it('documents money and quantity as decimal strings, never numbers, and ids as strings', () => {
    const body = JSON.stringify(create.requestBody);
    expect(body).toContain('"quantity":{"type":"string"');
    expect(body).toContain('Never a JSON number');
    expect(body).toContain('"buyer_id":{"type":"string"');
  });

  it('documents If-Match, Idempotency-Key and the path parameter on a transition', () => {
    const params = JSON.stringify(approve.parameters);
    expect(params).toContain('"name":"id","in":"path"');
    expect(params).toContain('#/components/parameters/IfMatch');
    expect(params).toContain('#/components/parameters/IdempotencyKey');
  });

  it('lists every error code, business and generic, grouped by status', () => {
    expect(approve['x-error-codes']).toEqual(
      expect.arrayContaining([
        'LOT_ALREADY_SOLD',
        'INSUFFICIENT_STOCK',
        'PERIOD_CLOSED',
        'VERSION_CONFLICT',
        'PRECONDITION_REQUIRED',
        'IDEMPOTENCY_KEY_REUSED',
        'PERMISSION_DENIED',
        'RATE_LIMITED',
      ]),
    );
    const responses = approve.responses as Record<string, { description: string }>;
    expect(responses['423']?.description).toContain('PERIOD_CLOSED');
    expect(responses['409']?.description).toContain('VERSION_CONFLICT');
    expect(responses['422']?.description).toContain('LOT_ALREADY_SOLD');
  });

  it('generates routes that actually enforce what the docs say', async () => {
    const { app } = buildTestApp({}, [salesModule()]);
    const anonymous = await request(app).post('/api/v1/sales').send({});
    expect(anonymous.status).toBe(401);
    const bad = await as(request(app).post('/api/v1/sales'), '1').send({
      buyer_id: 7,
      lines: [{ quantity: 37 }],
    });
    expect(bad.status).toBe(422);
    const ok = await as(request(app).post('/api/v1/sales'), '1').send({
      buyer_id: '7',
      lines: [{ quantity: '37.000' }],
    });
    expect(ok.status).toBe(201);
    const unknownFilter = await as(request(app).get('/api/v1/sales?filter[buyer]=1'), '1');
    expect(unknownFilter.body.error.code).toBe('UNKNOWN_FILTER');
  });
});

describe('/docs', () => {
  it('serves the OpenAPI document and Swagger UI outside production', async () => {
    const { app } = buildTestApp({}, [salesModule()]);
    const json = await request(app).get('/docs/openapi.json');
    expect(json.status).toBe(200);
    expect(json.body.paths['/api/v1/sales']).toBeDefined();
    const ui = await request(app).get('/docs/');
    expect(ui.status).toBe(200);
    expect(ui.text).toContain('swagger-ui');
    expect(ui.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('is off in production unless explicitly enabled', async () => {
    const prod = {
      APP_ENV: 'production',
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://erp.example.com',
      REDIS_URL: 'redis://127.0.0.1:6379',
      SMTP_HOST: 'smtp.example.com',
      APP_PUBLIC_URL: 'https://erp.example.com',
    };
    expect((await request(buildTestApp(prod).app).get('/docs/openapi.json')).status).toBe(404);
    expect(
      (await request(buildTestApp({ ...prod, DOCS_ENABLED: 'true' }).app).get('/docs/openapi.json')).status,
    ).toBe(200);
  });
});
