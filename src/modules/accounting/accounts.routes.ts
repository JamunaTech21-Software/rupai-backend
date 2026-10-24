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
import {
  ACCOUNT_KINDS,
  BankAccountOut,
  CreateBankAccountBody,
  PatchBankAccountBody,
  ReplaceBankAccountBody,
} from './bank-accounts.schema.js';
import { bankAccountsService } from './bank-accounts.service.js';
import {
  CreateRuleBody,
  PatchRuleBody,
  PreviewBody,
  PreviewOut,
  RuleOut,
  SourceOut,
} from './posting-rules.schema.js';
import { postingRulesService } from './posting-rules.service.js';
import { POSTING_PURPOSES } from '../../core/posting/sources.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { sendNoContent } from '../../core/http/response.js';
import { zId } from '../../core/ids/ids.js';
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

  // ---- /bank-accounts (P3.02, P3 §27.2, D-3.02-6) --------------------------------------------------
  const banks = bankAccountsService(db, accessLog);
  const b = defineModule({
    name: 'bank-accounts',
    path: '/bank-accounts',
    tag: 'Accounting',
    platform,
    authz,
    accessLog,
  });
  b.route({
    method: 'get',
    path: '/',
    summary: 'List bank accounts',
    description:
      'Bank, cash and mobile-money accounts, each posting to one cash-or-bank account of the chart. An organisation-wide account (no estate) is seen by everyone with the permission; an estate’s follows estate scope.',
    auth: { permission: 'bank_account.view' },
    list: {
      pagination: 'page',
      filters: {
        code: { type: 'string', ops: ['eq', 'like'] },
        name: { type: 'string', ops: ['like'] },
        status: { type: { enum: STATUSES } },
        account_kind: { type: { enum: ACCOUNT_KINDS } },
        estate_id: { type: 'id', ops: ['eq', 'null'] },
        currency_id: { type: 'id', ops: ['eq'] },
      },
      sorts: ['code', 'name'],
      defaultSort: ['code'],
    },
    success: { status: 200, description: 'A page of bank accounts', schema: BankAccountOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await banks.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });
  b.route({
    method: 'post',
    path: '/',
    summary: 'Create a bank account',
    description:
      'account_id is a postable cash-or-bank account of the chart, with at most one bank account each. currency_id defaults to (and must be) the chart account’s currency. A bank needs bank_name and account_number.',
    auth: { permission: 'bank_account.create' },
    body: CreateBankAccountBody,
    success: { status: 201, description: 'Created', schema: BankAccountOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateBankAccountBody });
      const a = await banks.create(body, currentActorId());
      sendCreated(res, a, `/api/v1/bank-accounts/${a.id}`, a.version);
    },
  });
  masterItemRoutes(b, {
    module: 'bank_account',
    label: 'bank account',
    out: BankAccountOut,
    replace: ReplaceBankAccountBody,
    patch: PatchBankAccountBody,
    svc: banks,
    deleteHelp:
      'Only a bank account nothing refers to (payments and collections will). Otherwise deactivate it.',
  });

  // ---- /posting-rules (P3.03, P3 §27.7, D-3.03-9) ---------------------------------------------------
  const rules = postingRulesService(db);
  const r = defineModule({
    name: 'posting-rules',
    path: '/posting-rules',
    tag: 'Accounting',
    platform,
    authz,
    accessLog,
  });
  const byId = { params: z.object({ id: zId }) };
  r.route({
    method: 'get',
    path: '/sources',
    summary: 'What can post',
    description:
      'Every postable document (P1 Table 7.2, P8 §14): its purposes, the amounts it supplies, the accounts it can name, the keys the resolvers read and the fields rule conditions may test. Declared before the documents exist so rules can be reviewed now.',
    auth: { permission: 'accounting.view' },
    success: { status: 200, description: 'The postable sources', schema: SourceOut },
    errors: [],
    handler: (req, res) => {
      const items = rules.sources();
      sendPage(req, res, items, { pagination: { page: 1, perPage: items.length }, total: items.length });
    },
  });
  r.route({
    method: 'get',
    path: '/',
    summary: 'List posting rules',
    auth: { permission: 'accounting.view' },
    list: {
      pagination: 'page',
      filters: {
        rule_code: { type: 'string', ops: ['eq', 'like'] },
        name: { type: 'string', ops: ['like'] },
        source_type: { type: 'string', ops: ['eq', 'in'] },
        purpose: { type: { enum: POSTING_PURPOSES } },
        is_active: { type: 'bool' },
      },
      sorts: ['rule_code', 'source_type', 'sequence'],
      defaultSort: ['source_type', 'sequence'],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of rules', schema: RuleOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await rules.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });
  r.route({
    method: 'post',
    path: '/',
    summary: 'Create a posting rule',
    description:
      'Created inactive. Lines in order; a fixed line names its account, every other resolution its key.',
    auth: { permission: 'accounting.create' },
    body: CreateRuleBody,
    success: { status: 201, description: 'Created', schema: RuleOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateRuleBody });
      const out = await rules.create(body, currentActorId());
      sendCreated(res, out, `/api/v1/posting-rules/${out.id}`, out.version);
    },
  });
  r.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a posting rule',
    auth: { permission: 'accounting.view' },
    ...byId,
    success: { status: 200, description: 'The rule with its lines', schema: RuleOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const out = await rules.get(params.id);
      sendOne(res, out, { version: out.version });
    },
  });
  r.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change an inactive posting rule',
    description: 'lines, when given, replace the rule’s lines.',
    auth: { permission: 'accounting.edit' },
    ...byId,
    body: PatchRuleBody,
    ifMatch: true,
    success: { status: 200, description: 'Updated', schema: RuleOut },
    errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchRuleBody });
      const out = await rules.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, out, { version: out.version });
    },
  });
  r.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete an inactive posting rule never used',
    auth: { permission: 'accounting.delete' },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'REFERENCED_RECORD'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await rules.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  for (const [path, action, summary, description] of [
    [
      '/:id/activate',
      'activate',
      'Activate a posting rule',
      'Needs the chart signed off, active postable fixed accounts, available resolutions, and someone other than whoever last changed the rule.',
    ],
    [
      '/:id/deactivate',
      'deactivate',
      'Deactivate a posting rule',
      'Postings it would have made fail with RULE_NOT_FOUND until another rule applies.',
    ],
  ] as const) {
    r.route({
      method: 'post',
      path,
      summary,
      description,
      auth: { permission: 'accounting.edit' },
      ...byId,
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: 'The rule', schema: RuleOut },
      errors: action === 'activate' ? ['CHART_NOT_SIGNED_OFF', 'SELF_APPROVAL_FORBIDDEN'] : [],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const out = await rules[action](params.id, requireIfMatch(req), currentActorId());
        sendOne(res, out, { version: out.version });
      },
    });
  }
  r.route({
    method: 'post',
    path: '/:id/preview',
    summary: 'Preview the journal a rule would write',
    description:
      'For sample amounts (and accounts the document would name): the lines, their accounts and totals. Writes nothing; works on inactive rules. Lines whose resolver has not arrived show no account.',
    auth: { permission: 'accounting.view' },
    ...byId,
    body: PreviewBody,
    success: { status: 200, description: 'The journal that would be written', schema: PreviewOut },
    errors: [],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PreviewBody });
      sendOne(res, await rules.preview(params.id, body));
    },
  });

  return [m.build(), b.build(), r.build()];
}
