import { z } from 'zod';

import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { Errors } from '../../core/errors/app-error.js';
import { getListQuery } from '../../core/http/list-query.js';
import { masterItemRoutes } from '../../core/http/master.js';
import { sendCreated, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { LOOKUP_BY_KEY, LOOKUP_TYPES, type LookupType } from './lookup-types.js';
import { lookupSchemas, lookupService, type LookupRow } from './lookup.engine.js';

/**
 * HTTP surface of the reference masters (Spec P4 §7.3). Each type has the full master pattern at its own
 * path, declared in a loop from its descriptor, so the contract shows every type's exact fields:
 *
 *   /lookups/{type}   the 16 common-shape lookups, activity_type, uom_category, tea_variety, currency, country
 *   /uoms, /tea-types, /tea-grades, /shifts   as P4 §7.3 names them
 *   GET /lookups      every ACTIVE row of every type in one response, for the SPA's selection lists
 */

export interface LookupDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
}

function typeModule(type: LookupType, { db, platform, authz, accessLog }: LookupDeps): ApiModule {
  const svc = lookupService(db, type, accessLog);
  const schemas = lookupSchemas(type);
  const m = defineModule({
    name: `lookup-${type.key}`,
    path: type.path,
    tag: 'Reference data',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: `List ${type.label} records`,
    description:
      'Active and inactive. For selection lists use GET /lookups, which returns the active rows of every type.',
    auth: { permission: `${type.permission}.view` },
    list: schemas.list,
    success: { status: 200, description: 'A page of records', schema: schemas.out },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: `Create a ${type.label}`,
    auth: { permission: `${type.permission}.create` },
    body: schemas.create,
    success: { status: 201, description: 'Created', schema: schemas.out },
    errors: ['DUPLICATE_KEY', ...(type.estateColumn ? (['SCOPE_DENIED'] as const) : [])],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: schemas.create });
      const row = await svc.create(body, currentActorId());
      sendCreated(res, row, `/api/v1${type.path}/${row.id}`, row.version);
    },
  });

  masterItemRoutes<LookupRow>(m, {
    module: type.permission,
    label: type.label,
    out: schemas.out,
    replace: schemas.replace,
    patch: schemas.patch,
    svc,
    updateErrors: ['SYSTEM_RECORD', 'INVARIANT_VIOLATED'],
    deleteHelp:
      'Only a record nothing refers to. A system record (is_system) is never deleted or deactivated: 422 SYSTEM_RECORD.',
  });
  return m.build();
}

const BulkQuery = z.object({
  /** Comma-separated type names, e.g. types=department,tea_grade. Omitted: every type. */
  types: z.string().max(1000).optional(),
});

function bulkModule(deps: LookupDeps): ApiModule {
  const { db, platform, authz, accessLog } = deps;
  const services = new Map(LOOKUP_TYPES.map((t) => [t.key, lookupService(db, t, accessLog)]));
  const m = defineModule({
    name: 'lookups',
    path: '/lookups',
    tag: 'Reference data',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'All active lookups in one response',
    description:
      'For SPA bootstrap and caching (P4 §7.3): { type: [rows] } for every reference master, active rows only, in ' +
      'display order. Narrow with ?types=a,b. Shifts follow your estate scope.',
    auth: { permission: 'lookup.view' },
    query: BulkQuery,
    success: {
      status: 200,
      description: 'Rows by type',
      schema: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
    },
    errors: [],
    handler: async (_req, res) => {
      const { query } = getValidated(res, { query: BulkQuery });
      const wanted = query.types
        ? query.types
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : LOOKUP_TYPES.map((t) => t.key);
      const unknown = wanted.filter((t) => !LOOKUP_BY_KEY.has(t));
      if (unknown.length > 0) {
        throw Errors.validation([
          { field: 'types', code: 'VALIDATION_FAILED', message: `unknown type: ${unknown.join(', ')}` },
        ]);
      }
      const out: Record<string, LookupRow[]> = {};
      for (const key of wanted) out[key] = (await services.get(key)?.active()) ?? [];
      sendOne(res, out);
    },
  });
  return m.build();
}

export function lookupModules(deps: LookupDeps): ApiModule[] {
  return [bulkModule(deps), ...LOOKUP_TYPES.map((t) => typeModule(t, deps))];
}
