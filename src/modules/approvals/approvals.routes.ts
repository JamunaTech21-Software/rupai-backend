import type { Logger } from 'pino';

import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import { APPROVABLE_DOCUMENTS } from '../../core/approval/document-types.js';
import type { ApprovalActionKind } from '../../core/approval/engine.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { assertPermission, currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import type { JobQueue } from '../../core/jobs/queue.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendCreated, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import {
  ApprovalOut,
  ApproveBody,
  CommentBody,
  DelegateBody,
  DelegationOut,
  HistoryOut,
  HistoryQuery,
  IdParams,
  QueueItemOut,
  RejectBody,
  REQUEST_STATES,
  ReturnBody,
} from './approvals.schema.js';
import { notifyApprovalsSoon } from './approvals.jobs.js';
import { approvalsService } from './approvals.service.js';
import { z } from 'zod';

/** HTTP surface of the approval runtime (Spec P4 §14.1, P7 §10–§14, P5 §13.6). */

export interface ApprovalsDeps {
  readonly config: Config;
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly jobs: JobQueue;
  readonly logger: Logger;
}

const byId = { params: IdParams };
const DOCUMENT_KEYS = APPROVABLE_DOCUMENTS.map((d) => d.key);
const ANY_USER = 'Every user has a queue: what they may approve is decided per item (P4 §14.1 "any").';
const OWN = 'Who may see or act on an approval depends on the approval, not on one permission.';

export function approvalsModule({
  config,
  db,
  platform,
  authz,
  accessLog,
  jobs,
  logger,
}: ApprovalsDeps): ApiModule {
  const svc = approvalsService({
    db,
    authz,
    accessLog,
    timezone: config.timezone,
    afterDecision: () => notifyApprovalsSoon({ db, jobs, logger }),
  });
  const m = defineModule({
    name: 'approvals',
    path: '/approvals',
    tag: 'Approvals',
    platform,
    authz,
    accessLog,
  });

  const queueList = {
    pagination: 'page',
    filters: {
      document_type: { type: { enum: DOCUMENT_KEYS }, ops: ['eq', 'in'] },
      estate_id: { type: 'id', ops: ['eq', 'in'] },
      amount: { type: 'decimal', ops: ['from', 'to'] },
      waiting_hours_from: { type: 'int', ops: ['eq'] },
    },
    sorts: [],
    maxPageSize: 200,
  } as const;

  m.route({
    method: 'get',
    path: '/pending',
    summary: 'My approval queue',
    description:
      'Every approval whose current step you may act on, directly or for someone who delegated to you, ' +
      'across every document type, oldest first (P7 §13.1). filter[waiting_hours_from]=48 shows items ' +
      'waiting at least that long.',
    auth: { signedIn: true, reason: ANY_USER },
    list: queueList,
    success: { status: 200, description: 'A page of the queue', schema: QueueItemOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.queue(currentActorId(), q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'get',
    path: '/pending/count',
    summary: 'How many approvals await me',
    description: 'For the top bar. Refresh it on the dashboard interval, not by polling (P7 §13.1).',
    auth: { signedIn: true, reason: ANY_USER },
    success: { status: 200, description: 'The count', schema: z.object({ count: z.number().int() }) },
    errors: [],
    handler: async (_req, res) => {
      const { total } = await svc.queue(currentActorId(), {
        filters: [],
        sort: [],
        include: [],
        fields: {},
        page: { page: 1, perPage: 1 },
      });
      sendOne(res, { count: total });
    },
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'All approvals',
    description:
      'Every approval within your scope, oldest submission first: the administrative and ageing view ' +
      '(P7 §11.3). filter[is_unresolved]=true gives the stored exception flag; GET /approvals/exceptions ' +
      're-checks it.',
    auth: { permission: 'workflow.view' },
    list: {
      pagination: 'page',
      filters: {
        state: { type: { enum: REQUEST_STATES }, ops: ['eq', 'in'] },
        document_type: { type: { enum: DOCUMENT_KEYS }, ops: ['eq', 'in'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        is_unresolved: { type: 'bool' },
      },
      sorts: [],
      maxPageSize: 100,
    },
    success: { status: 200, description: 'A page of approvals', schema: ApprovalOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q, currentActorId());
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'get',
    path: '/exceptions',
    summary: 'Approvals nobody can act on',
    description:
      'Pending approvals whose current step resolves to nobody (P7 §4.3): a role nobody in scope holds, ' +
      'or a step that cannot be resolved yet. The engine never skips such a step; give someone the role ' +
      '(a temporary role grant will do) and it leaves this list.',
    auth: { permission: 'workflow.view' },
    success: { status: 200, description: 'The exceptions', schema: ApprovalOut },
    errors: [],
    handler: async (req, res) => {
      const items = await svc.exceptions(currentActorId());
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'get',
    path: '/history',
    summary: 'The approval history of a document',
    description:
      'Its approval actions and its state transitions, oldest first (P4 §6.2 /{docs}/{id}/history). Needs ' +
      'the view permission of the document’s module.',
    auth: { signedIn: true, reason: 'The document type decides the permission.' },
    query: HistoryQuery,
    success: { status: 200, description: 'The history', schema: HistoryOut },
    errors: ['PERMISSION_DENIED', 'PASSWORD_CHANGE_REQUIRED'],
    handler: async (req, res) => {
      const { query } = getValidated(res, { query: HistoryQuery });
      await assertPermission(authz, svc.viewPermission(query.document_type), req, accessLog);
      const items = await svc.history(query.document_type, query.document_id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'get',
    path: '/delegations',
    summary: 'List delegations',
    description: 'filter[user_id] matches either side; filter[is_active]=true shows those in force now.',
    auth: { permission: 'user.view' },
    list: {
      pagination: 'page',
      filters: { user_id: { type: 'id', ops: ['eq'] }, is_active: { type: 'bool' } },
      sorts: [],
    },
    success: { status: 200, description: 'A page of delegations', schema: DelegationOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.delegations(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'post',
    path: '/delegate',
    summary: 'Delegate approval authority',
    description:
      'For a bounded period (at most 90 days), with a reason (P7 §11.1). It hands over approval only: the ' +
      'delegate acts only where they already hold the permission, and never on authority that was itself ' +
      'delegated. Optionally for one document type. It ends by itself.',
    auth: { permission: 'user.edit' },
    body: DelegateBody,
    success: { status: 201, description: 'The delegation', schema: DelegationOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: DelegateBody });
      const d = await svc.delegate(body, currentActorId());
      sendCreated(res, d, `/api/v1/approvals/delegations/${d.id}`);
    },
  });

  m.route({
    method: 'post',
    path: '/delegations/:id/end',
    summary: 'End a delegation now',
    description: 'Before its end date. The record is kept.',
    auth: { permission: 'user.edit' },
    ...byId,
    idempotent: true,
    success: { status: 200, description: 'Ended', schema: DelegationOut },
    errors: ['INVALID_TRANSITION'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await svc.endDelegation(params.id, currentActorId()));
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Read an approval',
    description:
      'Its frozen path (every step, with whether it applies, who decided it and who may act on the ' +
      'current one), every action, and what you may do now (`can`). 404 if it is not yours to see.',
    auth: { signedIn: true, reason: OWN },
    ...byId,
    success: { status: 200, description: 'The approval', schema: ApprovalOut },
    errors: ['PASSWORD_CHANGE_REQUIRED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const a = await svc.get(params.id, currentActorId());
      sendOne(res, a, { version: a.version });
    },
  });

  const action = (kind: ApprovalActionKind, body: z.ZodObject, summary: string, description: string) => {
    m.route({
      method: 'post',
      path: `/:id/${kind}`,
      summary,
      description,
      auth: { signedIn: true, reason: OWN },
      ...byId,
      body,
      idempotent: true,
      success: { status: 200, description: 'The approval as it now stands', schema: ApprovalOut },
      errors: [
        'NOT_AN_APPROVER',
        'SELF_APPROVAL_FORBIDDEN',
        'APPROVAL_STEP_CHANGED',
        'INVALID_TRANSITION',
        'PERMISSION_DENIED',
        'PASSWORD_CHANGE_REQUIRED',
      ],
      handler: async (req, res) => {
        const { params, body: input } = getValidated(res, { ...byId, body }) as {
          params: { id: bigint };
          body: { step_number?: number; comment?: string; reason?: string };
        };
        const { approval, guardFailure } = await svc.act(params.id, kind, input, {
          userId: currentActorId(),
          ipAddress: req.ip ?? null,
        });
        // The action is recorded; the document refused. Its own code tells the client why (P4 §6.2).
        if (guardFailure) throw guardFailure;
        sendOne(res, approval, { version: approval.version });
      },
    });
  };
  action(
    'approve',
    ApproveBody,
    'Approve the current step',
    'Send the step_number you are approving. The last step signals the document, which runs its own ' +
      'checks: if it refuses, the approval is still recorded, the document stays submitted, and the ' +
      'answer is that refusal (a 422 with its own code). 409 APPROVAL_STEP_CHANGED: someone else decided ' +
      'this step first.',
  );
  action(
    'reject',
    RejectBody,
    'Reject',
    'Ends the workflow: the document is rejected. A reason is required.',
  );
  action(
    'return',
    ReturnBody,
    'Return for correction',
    'Back to draft with a comment saying what to correct. When it is resubmitted, approval starts again from step one.',
  );
  action(
    'comment',
    CommentBody,
    'Comment',
    'A remark on the approval. Decides nothing. Approvers and the submitter may comment.',
  );

  return m.build();
}
