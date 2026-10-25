import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import { registerApprovalAdapter } from '../../core/approval/adapters.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { masterItemRoutes } from '../../core/http/master.js';
import { sendCreated, sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { contactsService } from '../facilities/contacts.service.js';
import { contactRoutes } from '../facilities/facilities.routes.js';
import {
  BankChangeOut,
  BUSINESS_TYPES,
  CreateBankChangeBody,
  CreateSupplierBody,
  IdParams,
  PatchBankChangeBody,
  PatchSupplierBody,
  ReplaceSupplierBody,
  SupplierApprovalBody,
  SupplierOut,
  SUPPLIER_STATUSES,
} from './suppliers.schema.js';
import { suppliersService } from './suppliers.service.js';

/**
 * HTTP surface of procurement (Spec P4 §11.3): suppliers (P4.01) with their contacts and bank detail
 * changes. Purchase requests, orders, receipts, supplier invoices and payments follow (P4.02–P4.07).
 */

export interface ProcurementDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly config: Pick<Config, 'timezone'>;
}

const byId = { params: IdParams };

export function procurementModules({ db, platform, authz, accessLog, config }: ProcurementDeps): ApiModule[] {
  const svc = suppliersService(db, { timezone: config.timezone });
  registerApprovalAdapter(svc.adapter);

  // ---- /suppliers (P4.01, P3 §16.1) -----------------------------------------------------------------
  const m = defineModule({
    name: 'suppliers',
    path: '/suppliers',
    tag: 'Procurement',
    platform,
    authz,
    accessLog,
  });
  m.route({
    method: 'get',
    path: '/',
    summary: 'List suppliers',
    description:
      'Organisation-wide (no estate filtering, P6 §4.2). filter[q] searches code (prefix) and name. Each row says ' +
      'whether its bank details changed recently (payments then add the finance step, P7 §8.4) and names its ' +
      'pending bank detail change, if any.',
    auth: { permission: 'supplier.view' },
    list: {
      pagination: 'page',
      filters: {
        q: { type: 'string', ops: ['eq'] },
        code: { type: 'string', ops: ['eq', 'like'] },
        name: { type: 'string', ops: ['like'] },
        business_type: { type: { enum: BUSINESS_TYPES } },
        status: { type: { enum: SUPPLIER_STATUSES } },
        is_approved_supplier: { type: 'bool' },
      },
      sorts: ['code', 'name'],
      defaultSort: ['name'],
    },
    success: { status: 200, description: 'A page of suppliers', schema: SupplierOut },
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
    summary: 'Create a supplier',
    description:
      'code is numbered by the `supplier` format when omitted. Bank details are entered here; afterwards they ' +
      'change only through POST /suppliers/{id}/bank-changes. A new supplier is not approved: ' +
      'POST /suppliers/{id}/approve (supplier.approve) before purchase documents can name it.',
    auth: { permission: 'supplier.create' },
    body: CreateSupplierBody,
    success: { status: 201, description: 'Created', schema: SupplierOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateSupplierBody });
      const s = await svc.create(body, currentActorId());
      sendCreated(res, s, `/api/v1/suppliers/${s.id}`, s.version);
    },
  });
  masterItemRoutes(m, {
    module: 'supplier',
    label: 'supplier',
    out: SupplierOut,
    replace: ReplaceSupplierBody,
    patch: PatchSupplierBody,
    svc,
    deleteHelp:
      'Only a supplier created in error: no bank detail change, payable or payment refers to it. Otherwise deactivate it.',
  });

  for (const [path, approved, summary, description] of [
    [
      '/:id/approve',
      true,
      'Approve a supplier',
      'Sets is_approved_supplier: purchase documents may name it (P7 §6). Only an active supplier.',
    ],
    [
      '/:id/revoke-approval',
      false,
      'Withdraw a supplier’s approval',
      'Clears is_approved_supplier: no new purchase document may name it. Optional reason, kept in the audit trail.',
    ],
  ] as const) {
    m.route({
      method: 'post',
      path,
      summary,
      description,
      auth: { permission: 'supplier.approve' },
      ...byId,
      body: SupplierApprovalBody,
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: 'The supplier', schema: SupplierOut },
      errors: ['INVALID_TRANSITION'],
      handler: async (req, res) => {
        const { params, body } = getValidated(res, { ...byId, body: SupplierApprovalBody });
        const s = await svc.setApproved(
          params.id,
          requireIfMatch(req),
          approved,
          body.reason ?? null,
          currentActorId(),
        );
        sendOne(res, s, { version: s.version });
      },
    });
  }

  m.route({
    method: 'get',
    path: '/:id/bank-changes',
    summary: 'A supplier’s bank detail changes',
    description: 'Newest first: open, approved (with the details they replaced) and rejected.',
    auth: { permission: 'supplier.view' },
    ...byId,
    success: { status: 200, description: 'The changes', schema: BankChangeOut.array() },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await svc.listChanges(params.id));
    },
  });
  m.route({
    method: 'post',
    path: '/:id/bank-changes',
    summary: 'Propose new bank details',
    description:
      'Submitted to the supplier_bank_change workflow at once (P7 §9.6: finance approves), unless submit is ' +
      'false. On approval the details replace the supplier’s and bank_details_changed_at is stamped: for the ' +
      'recent period every payment to this supplier adds the finance-manager step (P7 §8.4). One open change per ' +
      'supplier; proposing the current details is refused. With no workflow it is applied at once (P7 §3.2).',
    auth: { permission: 'supplier.edit' },
    ...byId,
    body: CreateBankChangeBody,
    success: { status: 201, description: 'Proposed', schema: BankChangeOut },
    errors: ['INVALID_TRANSITION', 'RULE_AMBIGUOUS'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CreateBankChangeBody });
      const c = await svc.createChange(params.id, body, currentActorId());
      sendCreated(res, c, `/api/v1/supplier-bank-changes/${c.id}`, c.version);
    },
  });
  contactRoutes(m, contactsService(db, svc.contactOwner), 'supplier', '/suppliers');

  // ---- /supplier-bank-changes (P4.01, P7 §9.6) -------------------------------------------------------
  const b = defineModule({
    name: 'supplier-bank-changes',
    path: '/supplier-bank-changes',
    tag: 'Procurement',
    platform,
    authz,
    accessLog,
  });
  b.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a bank detail change',
    description:
      '`previous` is the supplier’s current details while the change is open, the replaced ones once approved.',
    auth: { permission: 'supplier.view' },
    ...byId,
    success: { status: 200, description: 'The change', schema: BankChangeOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const c = await svc.getChange(params.id);
      sendOne(res, c, { version: c.version });
    },
  });
  b.route({
    method: 'patch',
    path: '/:id',
    summary: 'Correct a draft bank detail change',
    description: 'A draft only: one kept back (submit false) or returned by an approver.',
    auth: { permission: 'supplier.edit' },
    ...byId,
    body: PatchBankChangeBody,
    ifMatch: true,
    success: { status: 200, description: 'Updated', schema: BankChangeOut },
    errors: ['INVALID_TRANSITION'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchBankChangeBody });
      const c = await svc.updateChange(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, c, { version: c.version });
    },
  });
  b.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit a draft bank detail change',
    description:
      'Into the supplier_bank_change workflow; decided with POST /approvals/{approval_request_id}/approve|reject|return.',
    auth: { permission: 'supplier.edit' },
    ...byId,
    ifMatch: true,
    success: { status: 200, description: 'Submitted', schema: BankChangeOut },
    errors: ['INVALID_TRANSITION', 'RULE_AMBIGUOUS'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const c = await svc.submitChange(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, c, { version: c.version });
    },
  });
  b.route({
    method: 'delete',
    path: '/:id',
    summary: 'Withdraw a draft bank detail change',
    auth: { permission: 'supplier.edit' },
    ...byId,
    success: { status: 204, description: 'Withdrawn' },
    errors: ['INVALID_TRANSITION'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.removeChange(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  return [m.build(), b.build()];
}
