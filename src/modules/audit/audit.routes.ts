import { z } from 'zod';

import type { ApiModule } from '../../app.js';
import { ACCESS_EVENTS } from '../../core/audit/access-log.js';
import { AUDIT_ACTIONS } from '../../core/audit/audit.js';
import { idCursorPage, toWhere, type ListFieldMap } from '../../core/db/list.js';
import { Errors } from '../../core/errors/app-error.js';
import { getListQuery, type ListQuery } from '../../core/http/list-query.js';
import { sendCursorPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import type { IdentityDeps } from '../identity/identity.routes.js';

/**
 * /audit (Spec P4 §14: GET /audit/changes and /audit/access-log, audit.view). Read-only: the tables are
 * append-only and nothing in the API can change them (P1 §13.3).
 *
 * These are very-high-growth tables, so every list is cursor-paginated, newest first, and REQUIRES a
 * bounded time range (P4 §2.5, BACKLOG P1.05). Without a record filter the range is at most 366 days.
 */

const MAX_RANGE_DAYS = 366;
const toBigInt = (v: string | number | boolean) => BigInt(String(v));
const toDate = (v: string | number | boolean) => new Date(String(v));

const UserRef = z.object({ id: z.string(), username: z.string() }).nullable();

export const AuditChangeOut = z.object({
  id: z.string(),
  record_type: z.string(),
  record_id: z.string(),
  action: z.enum(AUDIT_ACTIONS),
  field: z.string().nullable(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  changed_by: UserRef,
  acting_for_user_id: z.string().nullable(),
  changed_at: z.string(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  reason: z.string().nullable(),
});

export const StatusHistoryOut = z.object({
  id: z.string(),
  record_type: z.string(),
  record_id: z.string(),
  from_state: z.string().nullable(),
  to_state: z.string(),
  changed_by: UserRef,
  changed_at: z.string(),
  workflow_step_id: z.string().nullable(),
  comment: z.string().nullable(),
});

export const AccessLogOut = z.object({
  id: z.string(),
  user: UserRef,
  event_type: z.enum(ACCESS_EVENTS),
  module: z.string().nullable(),
  record_reference: z.string().nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  occurred_at: z.string(),
  detail: z.record(z.string(), z.unknown()).nullable(),
});

const userRef = (u: { id: bigint; username: string } | null) =>
  u ? { id: u.id.toString(), username: u.username } : null;

/** The range filter must exist (list spec) and be at most MAX_RANGE_DAYS unless a record is named. */
function assertRange(q: ListQuery, field: string, recordFilter?: string): void {
  if (recordFilter && q.filters.some((f) => f.field === recordFilter)) return;
  const from = q.filters.find((f) => f.field === field && f.op === 'from')?.value;
  const to = q.filters.find((f) => f.field === field && f.op === 'to')?.value;
  const days = (Date.parse(String(to)) - Date.parse(String(from))) / 86_400_000;
  if (days > MAX_RANGE_DAYS) {
    throw Errors.validation([
      {
        field: `filter[${field}]`,
        code: 'VALIDATION_FAILED',
        message: `The range may span at most ${String(MAX_RANGE_DAYS)} days (or filter by one record).`,
      },
    ]);
  }
}

function wrapCursor<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof Error && err.message === 'invalid cursor') {
      throw Errors.validation([
        { field: 'cursor', code: 'VALIDATION_FAILED', message: 'is not a valid cursor' },
      ]);
    }
    throw err;
  });
}

const CHANGE_FIELDS: ListFieldMap = {
  record_type: { field: 'recordType' },
  record_id: { field: 'recordId' },
  action: { field: 'action' },
  changed_by: { field: 'changedBy', convert: toBigInt },
  changed_at: { field: 'changedAt', convert: toDate },
};
const STATUS_FIELDS: ListFieldMap = {
  record_type: { field: 'recordType' },
  record_id: { field: 'recordId' },
  changed_at: { field: 'changedAt', convert: toDate },
};
const ACCESS_FIELDS: ListFieldMap = {
  user_id: { field: 'userId', convert: toBigInt },
  event_type: { field: 'eventType' },
  module: { field: 'module' },
  occurred_at: { field: 'occurredAt', convert: toDate },
};

const userSelect = { select: { id: true, username: true } } as const;

export function auditModule({ db, platform, authz, accessLog }: IdentityDeps): ApiModule {
  const m = defineModule({ name: 'audit', path: '/audit', tag: 'Audit', platform, authz, accessLog });

  m.route({
    method: 'get',
    path: '/changes',
    summary: 'Field-level change history',
    description:
      'Before and after values of audited records, newest first. Filter by record (record_type + record_id), user ' +
      'or action. A changed_at range is required (at most 366 days unless a record_id is given).',
    auth: { permission: 'audit.view' },
    list: {
      pagination: 'cursor',
      rangeRequired: 'changed_at',
      filters: {
        record_type: { type: 'string', ops: ['eq', 'in'] },
        record_id: { type: 'string', ops: ['eq'] },
        action: { type: { enum: AUDIT_ACTIONS } },
        changed_by: { type: 'id', ops: ['eq'] },
        changed_at: { type: 'datetime', ops: ['from', 'to'] },
      },
      sorts: [],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of changes', schema: AuditChangeOut },
    errors: [],
    handler: async (_req, res) => {
      const q = getListQuery(res);
      assertRange(q, 'changed_at', 'record_id');
      const { rows, nextCursor, limit } = await wrapCursor(() =>
        idCursorPage(q, ({ where, take }) =>
          db.auditChange.findMany({
            where: { AND: [toWhere(q, CHANGE_FIELDS), where] },
            orderBy: { id: 'desc' },
            take,
            include: { changer: userSelect },
          }),
        ),
      );
      sendCursorPage(
        res,
        rows.map((r) => ({
          id: r.id.toString(),
          record_type: r.recordType,
          record_id: r.recordId,
          action: r.action,
          field: r.field,
          old_value: r.oldValue,
          new_value: r.newValue,
          changed_by: userRef(r.changer),
          acting_for_user_id: r.actingForUserId?.toString() ?? null,
          changed_at: r.changedAt.toISOString(),
          ip_address: r.ipAddress,
          user_agent: r.userAgent,
          reason: r.reason,
        })),
        { cursor: { cursor: q.cursor?.cursor ?? null, limit }, nextCursor },
      );
    },
  });

  m.route({
    method: 'get',
    path: '/status-history',
    summary: 'Lifecycle transitions',
    description:
      'Every state change of stateful records (from → to, who, when), newest first. A record’s current state is ' +
      'reproducible from it. A changed_at range is required (at most 366 days unless a record_id is given).',
    auth: { permission: 'audit.view' },
    list: {
      pagination: 'cursor',
      rangeRequired: 'changed_at',
      filters: {
        record_type: { type: 'string', ops: ['eq', 'in'] },
        record_id: { type: 'string', ops: ['eq'] },
        changed_at: { type: 'datetime', ops: ['from', 'to'] },
      },
      sorts: [],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of transitions', schema: StatusHistoryOut },
    errors: [],
    handler: async (_req, res) => {
      const q = getListQuery(res);
      assertRange(q, 'changed_at', 'record_id');
      const { rows, nextCursor, limit } = await wrapCursor(() =>
        idCursorPage(q, ({ where, take }) =>
          db.statusHistory.findMany({
            where: { AND: [toWhere(q, STATUS_FIELDS), where] },
            orderBy: { id: 'desc' },
            take,
            include: { changer: userSelect },
          }),
        ),
      );
      sendCursorPage(
        res,
        rows.map((r) => ({
          id: r.id.toString(),
          record_type: r.recordType,
          record_id: r.recordId,
          from_state: r.fromState,
          to_state: r.toState,
          changed_by: userRef(r.changer),
          changed_at: r.changedAt.toISOString(),
          workflow_step_id: r.workflowStepId?.toString() ?? null,
          comment: r.comment,
        })),
        { cursor: { cursor: q.cursor?.cursor ?? null, limit }, nextCursor },
      );
    },
  });

  m.route({
    method: 'get',
    path: '/access-log',
    summary: 'The access log',
    description:
      'Sign-ins, failed sign-ins, lockouts, logouts, token refreshes and reuse, password events, permission and ' +
      'scope denials, exports and prints, newest first. An occurred_at range is required (at most 366 days).',
    auth: { permission: 'audit.view' },
    list: {
      pagination: 'cursor',
      rangeRequired: 'occurred_at',
      filters: {
        user_id: { type: 'id', ops: ['eq'] },
        event_type: { type: { enum: ACCESS_EVENTS } },
        module: { type: 'string', ops: ['eq'] },
        occurred_at: { type: 'datetime', ops: ['from', 'to'] },
      },
      sorts: [],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of access events', schema: AccessLogOut },
    errors: [],
    handler: async (_req, res) => {
      const q = getListQuery(res);
      assertRange(q, 'occurred_at');
      const { rows, nextCursor, limit } = await wrapCursor(() =>
        idCursorPage(q, ({ where, take }) =>
          db.accessLog.findMany({
            where: { AND: [toWhere(q, ACCESS_FIELDS), where] },
            orderBy: { id: 'desc' },
            take,
            include: { user: userSelect },
          }),
        ),
      );
      sendCursorPage(
        res,
        rows.map((r) => ({
          id: r.id.toString(),
          user: userRef(r.user),
          event_type: r.eventType,
          module: r.module,
          record_reference: r.recordReference,
          ip_address: r.ipAddress,
          user_agent: r.userAgent,
          occurred_at: r.occurredAt.toISOString(),
          detail: (r.detail as Record<string, unknown> | null) ?? null,
        })),
        { cursor: { cursor: q.cursor?.cursor ?? null, limit }, nextCursor },
      );
    },
  });

  return m.build();
}
