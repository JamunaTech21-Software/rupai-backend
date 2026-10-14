import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import { APPROVABLE_DOCUMENTS } from '../../core/approval/document-types.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import type { PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendCreated, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { RULE_STATES } from '../../core/rules/rule-table.js';
import {
  ApproveBody,
  CreateWorkflowBody,
  DocumentTypeOut,
  IdParams,
  PatchWorkflowBody,
  PreviewOut,
  PreviewQuery,
  RejectBody,
  ReturnBody,
  SupersedeWorkflowBody,
  WorkflowOut,
} from './workflows.schema.js';
import { workflowsService } from './workflows.service.js';

/** HTTP surface of approval workflow definitions (Spec P4 §14.1, P7 §15). */

export interface WorkflowsDeps {
  readonly config: Config;
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
}

const byId = { params: IdParams };
const VALIDATION =
  'Refused with 422 when the definition is not valid; each detail names the field and a code: ' +
  'WORKFLOW_CONDITION_INVALID, WORKFLOW_STEP_INVALID, WORKFLOW_NO_UNCONDITIONAL_STEP, WORKFLOW_LADDER_INVALID, ' +
  'WORKFLOW_SELF_APPROVAL_FORBIDDEN, WORKFLOW_REFERENCE_INVALID.';

export function workflowsModule({ config, db, platform, authz, accessLog }: WorkflowsDeps): ApiModule {
  const svc = workflowsService({ db, accessLog, timezone: config.timezone });
  const m = defineModule({
    name: 'workflows',
    path: '/workflows',
    tag: 'Workflows',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List workflow versions',
    description:
      'Every version of every workflow you may see, by document type. filter[as_of]=YYYY-MM-DD gives the ' +
      'workflows in force on a date. Steps are included; warnings are not (read one workflow for those).',
    auth: { permission: 'workflow.view' },
    list: {
      pagination: 'page',
      filters: {
        document_type: { type: { enum: APPROVABLE_DOCUMENTS.map((d) => d.key) }, ops: ['eq', 'in'] },
        state: { type: { enum: RULE_STATES }, ops: ['eq', 'in'] },
        code: { type: 'string', ops: ['eq'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        as_of: { type: 'date', ops: ['eq'] },
      },
      sorts: [],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of workflow versions', schema: WorkflowOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'get',
    path: '/document-types',
    summary: 'The approvable document types',
    description:
      'Each document type a workflow can govern, the fields its conditions may test with the operators ' +
      'each allows, and how many workflows are in force for it today. A type with none is approved on ' +
      'submission: show that as a warning.',
    auth: { permission: 'workflow.view' },
    success: { status: 200, description: 'The document types', schema: DocumentTypeOut },
    errors: [],
    handler: async (req, res) => {
      const items = await svc.documentTypes();
      sendPage(req, res, items, { pagination: { page: 1, perPage: items.length }, total: items.length });
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Create a workflow',
    description:
      `A new workflow, as a draft. Steps are in order: the first is step 1. It takes effect when it is ` +
      `submitted and approved. ${VALIDATION}`,
    auth: { permission: 'workflow.create' },
    body: CreateWorkflowBody,
    success: { status: 201, description: 'The draft', schema: WorkflowOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateWorkflowBody });
      const w = await svc.create(body);
      sendCreated(res, w, `/api/v1/workflows/${w.id}`, w.version);
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Read a workflow version',
    description: 'With its steps and the warnings that apply to it now.',
    auth: { permission: 'workflow.view' },
    ...byId,
    success: { status: 200, description: 'The workflow version', schema: WorkflowOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const w = await svc.get(params.id);
      sendOne(res, w, { version: w.version });
    },
  });

  m.route({
    method: 'patch',
    path: '/:id',
    summary: 'Edit a draft workflow',
    description:
      `Drafts only (409 otherwise: supersede an active workflow instead). Steps, when sent, replace the ` +
      `whole list. A later version keeps its code, document type and scope. ${VALIDATION}`,
    auth: { permission: 'workflow.edit' },
    ...byId,
    body: PatchWorkflowBody,
    ifMatch: true,
    success: { status: 200, description: 'The draft', schema: WorkflowOut },
    errors: ['INVALID_TRANSITION', 'DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchWorkflowBody });
      const w = await svc.update(params.id, requireIfMatch(req), body);
      sendOne(res, w, { version: w.version });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/supersede',
    summary: 'Start the next version of an active workflow',
    description:
      'A new draft with the same code, document type and scope. Its steps are copied unless you send ' +
      'new ones. When it is approved, the current version is closed the day before it starts; documents ' +
      `already submitted keep the steps they were submitted under. ${VALIDATION}`,
    auth: { permission: 'workflow.create' },
    ...byId,
    body: SupersedeWorkflowBody,
    success: { status: 201, description: 'The draft', schema: WorkflowOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: SupersedeWorkflowBody });
      const w = await svc.supersede(params.id, body);
      sendCreated(res, w, `/api/v1/workflows/${w.id}`, w.version);
    },
  });

  m.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit a draft workflow for approval',
    description: `The definition is checked again. An overlap with another active version is reported now. ${VALIDATION}`,
    auth: { permission: 'workflow.edit' },
    ...byId,
    idempotent: true,
    success: { status: 200, description: 'Submitted', schema: WorkflowOut },
    errors: ['INVALID_TRANSITION', 'RULE_OVERLAP', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const w = await svc.submit(params.id);
      sendOne(res, w, { version: w.version });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/return',
    summary: 'Return a submitted workflow to draft',
    description: 'For correction. Say what needs correcting.',
    auth: { permission: 'workflow.approve' },
    ...byId,
    body: ReturnBody,
    idempotent: true,
    success: { status: 200, description: 'Back to draft', schema: WorkflowOut },
    errors: ['INVALID_TRANSITION', 'NOT_SUBMITTED', 'ALREADY_APPROVED', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: ReturnBody });
      const w = await svc.returnToDraft(params.id, body.comment);
      sendOne(res, w, { version: w.version });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/reject',
    summary: 'Reject a submitted workflow',
    description: 'Final: a rejected version is never used. A reason is required.',
    auth: { permission: 'workflow.approve' },
    ...byId,
    body: RejectBody,
    idempotent: true,
    success: { status: 200, description: 'Rejected', schema: WorkflowOut },
    errors: ['INVALID_TRANSITION', 'NOT_SUBMITTED', 'ALREADY_APPROVED', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: RejectBody });
      const w = await svc.reject(params.id, body.reason);
      sendOne(res, w, { version: w.version });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/approve',
    summary: 'Approve a submitted workflow',
    description:
      'The workflow takes effect from its effective date. Nobody approves a version they created ' +
      '(403 SELF_APPROVAL_FORBIDDEN). A version that takes effect in the past needs a reason. Two active ' +
      'workflows may never cover the same document type, scope and date (422 RULE_OVERLAP).',
    auth: { permission: 'workflow.approve' },
    ...byId,
    body: ApproveBody,
    idempotent: true,
    success: { status: 200, description: 'Active', schema: WorkflowOut },
    errors: [
      'INVALID_TRANSITION',
      'NOT_SUBMITTED',
      'ALREADY_APPROVED',
      'SELF_APPROVAL_FORBIDDEN',
      'RULE_OVERLAP',
      'RETROSPECTIVE_APPROVAL_REQUIRED',
      'SCOPE_DENIED',
    ],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: ApproveBody });
      const w = await svc.approve(params.id, body.reason ?? null);
      sendOne(res, w, { version: w.version });
    },
  });

  m.route({
    method: 'get',
    path: '/:id/preview',
    summary: 'Preview a workflow against a sample document',
    description:
      'Which steps a document with these values would go through, and who could approve each. Send the ' +
      'values as sample[field]=value, using the fields of GET /workflows/document-types (amounts as ' +
      'decimals, flags as true or false). Nothing is stored. Works on any version, a draft included.',
    auth: { permission: 'workflow.view' },
    ...byId,
    query: PreviewQuery,
    success: { status: 200, description: 'The path', schema: PreviewOut },
    errors: [],
    handler: async (_req, res) => {
      const { params, query } = getValidated(res, { ...byId, query: PreviewQuery });
      sendOne(res, await svc.preview(params.id, query.sample ?? {}));
    },
  });

  return m.build();
}
