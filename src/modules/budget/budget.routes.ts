import { z } from 'zod';

import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import { registerApprovalAdapter } from '../../core/approval/adapters.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendCreated, sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import { zId } from '../../core/ids/ids.js';
import type { Platform } from '../../core/platform.js';
import { CONTROL_MODES } from '../../core/budget/budget.js';
import { budgetControlService } from './budget-control.service.js';
import {
  AvailabilityOut,
  AvailabilityQuery,
  BUDGET_STATES,
  BUDGET_TYPES,
  BudgetLineOut,
  BudgetOut,
  CONTROL_STATES,
  ConsumptionOut,
  ControlOut,
  CreateBudgetBody,
  CreateControlBody,
  PatchBudgetBody,
  PatchControlBody,
  VsActualOut,
  VsActualQuery,
} from './budget.schema.js';
import { budgetService } from './budget.service.js';

/**
 * HTTP surface of budgets (P3.06; Spec P4 §13 "Funding and budget", P3 §26.3–§26.6): budgets (budget.*),
 * budget lines with their consumption, availability, budget vs actual, and budget controls (budget_control.*).
 */

export interface BudgetDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly config: Pick<Config, 'timezone'>;
}

export function budgetModules({ db, platform, authz, accessLog, config }: BudgetDeps): ApiModule[] {
  const budgets = budgetService({ db, accessLog, timezone: config.timezone });
  const controls = budgetControlService({ db, accessLog, timezone: config.timezone });
  registerApprovalAdapter(budgets.adapter);
  registerApprovalAdapter(controls.adapter);
  const byId = { params: z.object({ id: zId }) };

  // ---- /budgets ---------------------------------------------------------------------------------------
  const b = defineModule({ name: 'budgets', path: '/budgets', tag: 'Budget', platform, authz, accessLog });
  b.route({
    method: 'get',
    path: '/',
    summary: 'List budgets',
    description:
      'Every budget and revision. A budget of an estate follows estate scope; an organisation-wide one is seen by every budget.view holder. Lines are on GET /budgets/{id}.',
    auth: { permission: 'budget.view' },
    list: {
      pagination: 'page',
      filters: {
        budget_code: { type: 'string', ops: ['eq', 'like'] },
        fiscal_year_id: { type: 'id', ops: ['eq'] },
        estate_id: { type: 'id', ops: ['eq', 'null'] },
        department_id: { type: 'id', ops: ['eq', 'null'] },
        budget_type: { type: { enum: BUDGET_TYPES }, ops: ['eq'] },
        state: { type: { enum: BUDGET_STATES }, ops: ['eq', 'in'] },
        name: { type: 'string', ops: ['like'] },
      },
      sorts: ['budget_code', 'name', 'revision_number'],
      defaultSort: ['-budget_code'],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of budgets', schema: BudgetOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await budgets.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });
  b.route({
    method: 'get',
    path: '/availability',
    summary: 'Budget available for a spend',
    description:
      'What purchase and expense screens check before submission (P4 §13, D-3.06-11): the active budget line that would be consumed (the head or its nearest ancestor; the cost centre or none), annual, committed, actual, available, utilisation, available after this amount, the control in force and the outcome (ok, warn, require_approval, block). line null: no active budget covers it.',
    auth: { permission: 'budget.view' },
    query: AvailabilityQuery,
    success: { status: 200, description: 'The availability', schema: AvailabilityOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { query } = getValidated(res, { query: AvailabilityQuery });
      sendOne(res, await budgets.availability(query));
    },
  });
  b.route({
    method: 'post',
    path: '/',
    summary: 'Create a budget (draft)',
    description:
      'Fiscal year, estate (empty = organisation-wide), department (optional), operating or capital. Lines: one per budget head and cost centre; an operating budget takes expense heads, a capital budget capital heads. Each line has 12 monthly amounts summing to its annual amount, or they are spread evenly.',
    auth: { permission: 'budget.create' },
    body: CreateBudgetBody,
    success: { status: 201, description: 'Created', schema: BudgetOut },
    errors: ['ALLOCATION_MISMATCH', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateBudgetBody });
      const out = await budgets.create(body, currentActorId());
      sendCreated(res, out, `/api/v1/budgets/${out.id}`, out.version);
    },
  });
  b.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a budget with its lines',
    description:
      'Each line with its monthly allocation and its figures: committed, actual, available, utilisation, variance.',
    auth: { permission: 'budget.view' },
    ...byId,
    success: { status: 200, description: 'The budget', schema: BudgetOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const out = await budgets.get(params.id);
      sendOne(res, out, { version: out.version });
    },
  });
  b.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a draft budget',
    description:
      'lines, when given, replace the draft’s lines. A submitted, approved or active budget is immutable: revise it.',
    auth: { permission: 'budget.edit' },
    ...byId,
    body: PatchBudgetBody,
    ifMatch: true,
    success: { status: 200, description: 'Updated', schema: BudgetOut },
    errors: ['INVALID_TRANSITION', 'ALLOCATION_MISMATCH', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchBudgetBody });
      const out = await budgets.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, out, { version: out.version });
    },
  });
  b.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft budget',
    description: 'Only a draft, with its lines.',
    auth: { permission: 'budget.delete' },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await budgets.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  for (const [action, summary, description, permission, errors] of [
    [
      'submit',
      'Submit a budget for approval',
      'At least one line. Routed through the budget workflow: total_amount and is_single_estate are its condition fields (P7 §9.4). A revision follows the same workflow.',
      'budget.submit',
      ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    ],
    [
      'activate',
      'Release (activate) an approved budget',
      'The design’s "Release Budget": an approved budget becomes active and consumable. One active budget per fiscal year, estate, department and type. Releasing a revision supersedes the budget it revises; its lines take over the committed, actual and monthly position.',
      'budget.approve',
      ['INVALID_TRANSITION', 'DUPLICATE_KEY', 'PERIOD_CLOSED', 'SCOPE_DENIED'],
    ],
    [
      'revise',
      'Revise an approved or active budget',
      'Creates a new draft copying the lines and monthly allocations (revision_number + 1, supersedes the original). The original stays as it is, in force, until the revision is released. Returns the revision.',
      'budget.create',
      ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    ],
  ] as const) {
    b.route({
      method: 'post',
      path: `/:id/${action}`,
      summary,
      description,
      auth: { permission },
      ...byId,
      ifMatch: true,
      idempotent: true,
      success: { status: action === 'revise' ? 201 : 200, description: 'The budget', schema: BudgetOut },
      errors: [...errors],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const out = await budgets[action](params.id, requireIfMatch(req), currentActorId());
        if (action === 'revise') sendCreated(res, out, `/api/v1/budgets/${out.id}`, out.version);
        else sendOne(res, out, { version: out.version });
      },
    });
  }
  b.route({
    method: 'get',
    path: '/:id/vs-actual',
    summary: 'Budget vs actual',
    description:
      'By budget head, cost centre or period (month): budget, committed, actual, available, utilisation and the variance (annual − actual) labelled surplus or overrun (P9 §19.2).',
    auth: { permission: 'budget.view' },
    ...byId,
    query: VsActualQuery,
    success: { status: 200, description: 'Budget vs actual', schema: VsActualOut },
    errors: [],
    handler: async (_req, res) => {
      const { params, query } = getValidated(res, { ...byId, query: VsActualQuery });
      sendOne(res, await budgets.vsActual(params.id, query));
    },
  });

  // ---- /budget-lines -----------------------------------------------------------------------------------
  const l = defineModule({
    name: 'budget-lines',
    path: '/budget-lines',
    tag: 'Budget',
    platform,
    authz,
    accessLog,
  });
  l.route({
    method: 'get',
    path: '/',
    summary: 'List budget lines with their figures',
    description:
      'Annual, committed, actual, available, utilisation and variance per line; the scope of their budget.',
    auth: { permission: 'budget.view' },
    list: {
      pagination: 'page',
      filters: {
        budget_id: { type: 'id', ops: ['eq'] },
        budget_head_id: { type: 'id', ops: ['eq'] },
        cost_centre_id: { type: 'id', ops: ['eq', 'null'] },
        estate_id: { type: 'id', ops: ['eq', 'null'] },
      },
      sorts: ['available_amount', 'utilisation_percentage'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of budget lines', schema: BudgetLineOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await budgets.lines(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });
  l.route({
    method: 'get',
    path: '/:id/consumption',
    summary: 'The consumption of a budget line',
    description:
      'Commitments, actuals and releases with their source documents, oldest first, including those recorded against the same head and cost centre in earlier revisions. A reversal row counts negative.',
    auth: { permission: 'budget.view' },
    ...byId,
    success: { status: 200, description: 'The consumption', schema: z.array(ConsumptionOut) },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await budgets.consumption(params.id));
    },
  });

  // ---- /budget-controls --------------------------------------------------------------------------------
  const c = defineModule({
    name: 'budget-controls',
    path: '/budget-controls',
    tag: 'Budget',
    platform,
    authz,
    accessLog,
  });
  c.route({
    method: 'get',
    path: '/',
    summary: 'List budget controls',
    description:
      'Active, draft, superseded and rejected controls. A head without one is warned (the default); block is never the default.',
    auth: { permission: 'budget_control.view' },
    list: {
      pagination: 'page',
      filters: {
        budget_head_id: { type: 'id', ops: ['eq', 'null'] },
        estate_id: { type: 'id', ops: ['eq', 'null'] },
        fiscal_year_id: { type: 'id', ops: ['eq', 'null'] },
        control_mode: { type: { enum: CONTROL_MODES }, ops: ['eq'] },
        state: { type: { enum: CONTROL_STATES }, ops: ['eq', 'in'] },
      },
      sorts: [],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of budget controls', schema: ControlOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await controls.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });
  c.route({
    method: 'post',
    path: '/',
    summary: 'Create a budget control (draft)',
    description:
      'Budget head (empty = organisation default), estate and fiscal year (empty = all); mode none, warn, require_approval (names the escalation role) or block; warning and critical thresholds and the overrun tolerance in percent. In force once approved through the budget_control workflow.',
    auth: { permission: 'budget_control.create' },
    body: CreateControlBody,
    success: { status: 201, description: 'Created', schema: ControlOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateControlBody });
      const out = await controls.create(body, currentActorId());
      sendCreated(res, out, `/api/v1/budget-controls/${out.id}`, out.version);
    },
  });
  c.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a budget control',
    description: 'One control.',
    auth: { permission: 'budget_control.view' },
    ...byId,
    success: { status: 200, description: 'The control', schema: ControlOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const out = await controls.get(params.id);
      sendOne(res, out, { version: out.version });
    },
  });
  c.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a draft budget control',
    description: 'Only a draft. An active control is changed by revision.',
    auth: { permission: 'budget_control.edit' },
    ...byId,
    body: PatchControlBody,
    ifMatch: true,
    success: { status: 200, description: 'Updated', schema: ControlOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchControlBody });
      const out = await controls.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, out, { version: out.version });
    },
  });
  c.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft budget control',
    description: 'Only a draft.',
    auth: { permission: 'budget_control.edit' },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await controls.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  for (const [action, summary, description, permission] of [
    [
      'submit',
      'Submit a budget control for approval',
      'Through the budget_control workflow; is_relaxation is true when the mode is lowered or a threshold or the tolerance raised. Approval puts it in force and supersedes the control it replaces.',
      'budget_control.edit',
    ],
    [
      'revise',
      'Revise an active budget control',
      'A draft copy; approving it supersedes the original. Returns the revision.',
      'budget_control.create',
    ],
  ] as const) {
    c.route({
      method: 'post',
      path: `/:id/${action}`,
      summary,
      description,
      auth: { permission },
      ...byId,
      ifMatch: true,
      idempotent: true,
      success: { status: action === 'revise' ? 201 : 200, description: 'The control', schema: ControlOut },
      errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const out = await controls[action](params.id, requireIfMatch(req), currentActorId());
        if (action === 'revise') sendCreated(res, out, `/api/v1/budget-controls/${out.id}`, out.version);
        else sendOne(res, out, { version: out.version });
      },
    });
  }

  return [b.build(), l.build(), c.build()];
}
