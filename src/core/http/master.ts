import { z } from 'zod';

import { currentActorId } from '../auth/authorize.js';
import { zId } from '../ids/ids.js';
import type { ErrorCode } from '../errors/codes.js';
import { requireIfMatch } from './concurrency.js';
import { sendNoContent, sendOne } from './response.js';
import type { defineModule } from './route.js';
import { getValidated } from './validate.js';

/**
 * The item half of the P4 §6 master pattern, declared once: GET, PUT, PATCH and DELETE on
 * /{resource}/:id, plus POST /:id/deactivate and /:id/reactivate. Every master module (estates, fields,
 * factories, warehouses, parties, …) registers its items through this, so they behave identically:
 * If-Match on every change, idempotent status actions, DELETE only for a record created in error.
 */

type Builder = ReturnType<typeof defineModule>;
export type MasterStatus = 'active' | 'inactive';

export interface MasterItemService<Out> {
  get(id: bigint): Promise<Out>;
  update(id: bigint, version: number, changes: never, actorId: bigint): Promise<Out>;
  setStatus(id: bigint, version: number, status: MasterStatus, actorId: bigint): Promise<Out>;
  remove(id: bigint, actorId: bigint): Promise<void>;
}

const byId = { params: z.object({ id: zId }) };

/** GET, PUT, PATCH, DELETE and deactivate/reactivate on /{resource}/:id: the P4 §6 master pattern. */
export function masterItemRoutes<Out extends { version: number }>(
  m: Builder,
  o: {
    module: string;
    label: string;
    out: z.ZodType;
    replace: z.ZodType;
    patch: z.ZodType;
    svc: MasterItemService<Out>;
    updateErrors?: readonly ErrorCode[];
    deleteHelp: string;
  },
): void {
  m.route({
    method: 'get',
    path: '/:id',
    summary: `Get a ${o.label}`,
    auth: { permission: `${o.module}.view` },
    ...byId,
    success: { status: 200, description: `The ${o.label}`, schema: o.out },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const item = await o.svc.get(params.id);
      sendOne(res, item, { version: item.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', o.replace, `Replace a ${o.label}’s details`],
    ['patch', o.patch, `Update some of a ${o.label}’s details`],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      auth: { permission: `${o.module}.edit` },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: o.out },
      errors: ['DUPLICATE_KEY', 'SCOPE_DENIED', ...(o.updateErrors ?? [])],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: o.patch });
        const item = await o.svc.update(params.id, requireIfMatch(req), changes as never, currentActorId());
        sendOne(res, item, { version: item.version });
      },
    });
  }

  m.route({
    method: 'delete',
    path: '/:id',
    summary: `Delete a ${o.label} created in error`,
    description: o.deleteHelp,
    auth: { permission: `${o.module}.delete` },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['REFERENCED_RECORD', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await o.svc.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  for (const [path, status, summary] of [
    ['/:id/deactivate', 'inactive', `Deactivate a ${o.label}`],
    ['/:id/reactivate', 'active', `Reactivate a ${o.label}`],
  ] as const) {
    m.route({
      method: 'post',
      path,
      summary,
      description:
        status === 'inactive'
          ? 'It stays on every record that refers to it, and no new record can be created under it.'
          : 'Only under an active parent.',
      auth: { permission: `${o.module}.edit` },
      ...byId,
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: `The ${o.label} in its new status`, schema: o.out },
      errors: ['SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const item = await o.svc.setStatus(params.id, requireIfMatch(req), status, currentActorId());
        sendOne(res, item, { version: item.version });
      },
    });
  }
}
