import { z } from 'zod';

import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { getListQuery } from '../../core/http/list-query.js';
import { masterItemRoutes } from '../../core/http/master.js';
import { sendCreated, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import {
  AccountNodeOut,
  AccountOut,
  ChartStatusOut,
  CreateAccountBody,
  PatchAccountBody,
  RemoveUnusedOut,
  ReplaceAccountBody,
  SignOffBody,
  SignOffOut,
  STATUSES,
} from './accounts.schema.js';
import { accountsService } from './accounts.service.js';
import { ACCOUNT_SUBTYPES, ACCOUNT_TYPES } from './chart.js';

/** HTTP surface of the chart of accounts (Spec P4 §13.3: accounting.*). The ledger view comes with P3.04. */

export interface AccountingDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
}

const TreeQuery = z.object({
  status: z.enum(STATUSES).optional(),
  account_type: z.enum(ACCOUNT_TYPES).optional(),
});

export function accountingModules({ db, platform, authz, accessLog }: AccountingDeps): ApiModule[] {
  const svc = accountsService(db);
  const m = defineModule({
    name: 'accounts',
    path: '/accounts',
    tag: 'Accounting',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List accounts',
    description:
      'The chart of accounts as a flat list (P4 §13.3). filter[q] searches code (prefix) and name. Organisation-wide: no estate filtering (P4 §4.2).',
    auth: { permission: 'accounting.view' },
    list: {
      pagination: 'page',
      filters: {
        q: { type: 'string', ops: ['eq'] },
        code: { type: 'string', ops: ['eq', 'like'] },
        name: { type: 'string', ops: ['like'] },
        status: { type: { enum: STATUSES } },
        account_type: { type: { enum: ACCOUNT_TYPES } },
        account_subtype: { type: { enum: ACCOUNT_SUBTYPES } },
        is_postable: { type: 'bool' },
        is_control_account: { type: 'bool' },
        is_bank_or_cash: { type: 'bool' },
        is_system: { type: 'bool' },
        parent_id: { type: 'id', ops: ['eq', 'null'] },
        level: { type: 'int', ops: ['eq', 'from', 'to'] },
      },
      sorts: ['code', 'name'],
      defaultSort: ['code'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of accounts', schema: AccountOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'get',
    path: '/tree',
    summary: 'The chart of accounts as a tree',
    description:
      'Every account, nested under its parent, siblings by code: one tree per top-level account. Optionally only one status or one type.',
    auth: { permission: 'accounting.view' },
    query: TreeQuery,
    success: {
      status: 200,
      description: 'The top-level accounts with their subtrees',
      schema: AccountNodeOut,
    },
    errors: [],
    handler: async (req, res) => {
      const { query } = getValidated(res, { query: TreeQuery });
      const roots = await svc.tree(query);
      sendPage(req, res, roots, {
        pagination: { page: 1, perPage: Math.max(roots.length, 1) },
        total: roots.length,
      });
    },
  });

  m.route({
    method: 'get',
    path: '/chart-status',
    summary: 'Whether the chart is signed off',
    description:
      'The accountant’s sign-off, if recorded, and the account counts. Until the sign-off every account is inactive and nothing can post (P3 §31.3).',
    auth: { permission: 'accounting.view' },
    success: { status: 200, description: 'The chart’s status', schema: ChartStatusOut },
    errors: [],
    handler: async (_req, res) => {
      sendOne(res, await svc.status());
    },
  });

  m.route({
    method: 'post',
    path: '/activate-chart',
    summary: 'Record the accountant’s sign-off and activate the chart',
    description:
      'Once only. Records who signed off Part 8, when and under what reference, and activates every account (P3 §31.3, D-3.01-9). From then on accounts are activated and deactivated one by one. accounting.edit is a sensitive permission.',
    auth: { permission: 'accounting.edit' },
    body: SignOffBody,
    idempotent: true,
    success: {
      status: 200,
      description: 'The recorded sign-off and how many accounts it activated',
      schema: z.object({ signed_off: z.literal(true), sign_off: SignOffOut, activated: z.number().int() }),
    },
    errors: ['ALREADY_APPROVED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: SignOffBody });
      sendOne(res, await svc.activateChart(body, currentActorId()));
    },
  });

  m.route({
    method: 'post',
    path: '/remove-unused',
    summary: 'Remove the unused seeded accounts (before sign-off)',
    description:
      'For replacing the seeded chart with the estate’s own (O-39, D-3.01-11): removes every account that is not a system account, has nothing under it and nothing refers to, until none is left. System accounts stay; re-code and re-parent them to the estate’s chart (by import, with system_key), then run this again to clear the emptied groups. Refused after the sign-off.',
    auth: { permission: 'accounting.delete' },
    idempotent: true,
    success: {
      status: 200,
      description: 'How many accounts were removed and how many remain',
      schema: RemoveUnusedOut,
    },
    errors: ['INVALID_TRANSITION'],
    handler: async (_req, res) => {
      sendOne(res, await svc.removeUnused(currentActorId()));
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Create an account',
    description:
      'A child takes its parent’s type (and subtype, when omitted). is_postable defaults to true; expense accounts require a cost centre by default (P8 §3.4). normal_balance only to make a contra account. Active only after the sign-off.',
    auth: { permission: 'accounting.create' },
    body: CreateAccountBody,
    success: { status: 201, description: 'Created', schema: AccountOut },
    errors: ['DUPLICATE_KEY', 'PARENT_IS_POSTABLE', 'ACCOUNT_DEPTH_EXCEEDED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateAccountBody });
      const a = await svc.create(body, currentActorId());
      sendCreated(res, a, `/api/v1/accounts/${a.id}`, a.version);
    },
  });

  masterItemRoutes(m, {
    module: 'accounting',
    label: 'account',
    out: AccountOut,
    replace: ReplaceAccountBody,
    patch: PatchAccountBody,
    svc,
    updateErrors: [
      'ACCOUNT_HAS_CHILDREN',
      'PARENT_IS_POSTABLE',
      'ACCOUNT_DEPTH_EXCEEDED',
      'REFERENCED_RECORD',
      'SYSTEM_RECORD',
    ],
    statusErrors: ['SYSTEM_RECORD', 'CHART_NOT_SIGNED_OFF', 'INVARIANT_VIOLATED'],
    deleteErrors: ['SYSTEM_RECORD'],
    deleteHelp:
      'Only an account that is not a system account, has nothing under it and nothing refers to (P8 §2.5). Otherwise deactivate it.',
  });

  return [m.build()];
}
