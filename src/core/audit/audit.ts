import { currentActorId } from '../auth/authorize.js';
import { getRequestContext } from '../context/request-context.js';
import type { Tx } from '../db/transaction.js';

/**
 * The audit writer (Spec P1 §13, P2 §6.3, P3 §29.1). Every audited change calls it with the SAME `tx`
 * as the change, so an audited action whose audit write fails fails entirely (P1 §13.3).
 *
 * Depth is set by record class (P1 Table 13.1): a master records its significant fields, policy and
 * financial records every field plus the client address and user agent. A module declares, per record
 * type, its class and the fields it tracks; nothing else is written.
 *
 *   create  one row, field NULL, new_value = JSON snapshot of the tracked fields
 *   update  one row per tracked field whose value changed (old_value, new_value)
 *   delete  one row, field NULL, old_value = JSON snapshot
 *   approve | reject | post | reverse | cancel  one row, optionally naming a field
 *
 * The tables are append-only in the database itself: the app account has no UPDATE or DELETE on them.
 */

export type RecordClass = 'master' | 'policy' | 'operational' | 'financial' | 'derived';

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'approve',
  'reject',
  'post',
  'reverse',
  'cancel',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export interface AuditedRecord {
  /** Short entity key, snake_case: never a class or model name (P3 §29.1). */
  readonly type: string;
  readonly class: RecordClass;
  /** The tracked fields, by their API (snake_case) names. */
  readonly fields: readonly string[];
}

export type AuditValues = Readonly<Record<string, unknown>>;

export interface AuditOptions {
  /** Defaults to the request's authenticated user. */
  readonly actorId?: bigint;
  readonly actingForUserId?: bigint | null;
  /** Required by the caller for overrides, reversals, adjustments and retrospective rules (P1 §13.2). */
  readonly reason?: string | null;
}

/** Values are stored as text: strings as is, everything else as stable JSON (sorted keys, bigint as string). */
export function auditValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(sortKeys(v));
}

function sortKeys(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

function pick(rec: AuditedRecord, values: AuditValues): Record<string, unknown> {
  return Object.fromEntries(rec.fields.map((f) => [f, values[f] ?? null]));
}

function common(rec: AuditedRecord, recordId: bigint | string, opts: AuditOptions) {
  const ctx = getRequestContext();
  const withClient = rec.class === 'policy' || rec.class === 'financial';
  return {
    recordType: rec.type,
    recordId: recordId.toString(),
    changedBy: opts.actorId ?? currentActorId(),
    actingForUserId: opts.actingForUserId ?? null,
    ipAddress: withClient ? (ctx?.clientIp ?? null) : null,
    userAgent: withClient ? (ctx?.userAgent ?? null) : null,
    reason: opts.reason?.slice(0, 500) ?? null,
  };
}

export async function auditCreate(
  tx: Tx,
  rec: AuditedRecord,
  recordId: bigint | string,
  after: AuditValues,
  opts: AuditOptions = {},
): Promise<void> {
  await tx.auditChange.create({
    data: { ...common(rec, recordId, opts), action: 'create', newValue: auditValue(pick(rec, after)) },
  });
}

/** One row per tracked field that changed. Returns how many were written (0: nothing tracked changed). */
export async function auditUpdate(
  tx: Tx,
  rec: AuditedRecord,
  recordId: bigint | string,
  before: AuditValues,
  after: AuditValues,
  opts: AuditOptions = {},
): Promise<number> {
  const base = common(rec, recordId, opts);
  const rows = rec.fields
    .map((field) => ({ field, oldValue: auditValue(before[field]), newValue: auditValue(after[field]) }))
    .filter((r) => r.oldValue !== r.newValue)
    .map((r) => ({ ...base, action: 'update', ...r }));
  if (rows.length > 0) await tx.auditChange.createMany({ data: rows });
  return rows.length;
}

export async function auditDelete(
  tx: Tx,
  rec: AuditedRecord,
  recordId: bigint | string,
  before: AuditValues,
  opts: AuditOptions = {},
): Promise<void> {
  await tx.auditChange.create({
    data: { ...common(rec, recordId, opts), action: 'delete', oldValue: auditValue(pick(rec, before)) },
  });
}

/** A whole-record decision (approve, reject, post, reverse, cancel), optionally naming one field. */
export async function auditAction(
  tx: Tx,
  rec: AuditedRecord,
  recordId: bigint | string,
  action: Exclude<AuditAction, 'create' | 'update' | 'delete'>,
  opts: AuditOptions & { field?: string; oldValue?: unknown; newValue?: unknown } = {},
): Promise<void> {
  await tx.auditChange.create({
    data: {
      ...common(rec, recordId, opts),
      action,
      field: opts.field ?? null,
      oldValue: auditValue(opts.oldValue),
      newValue: auditValue(opts.newValue),
    },
  });
}

/**
 * A lifecycle transition (P3 §29.2). Written for every state change of a stateful record, from the
 * first state (from = null) on, so the current state is always reproducible from the history.
 */
export async function recordStatusChange(
  tx: Tx,
  recordType: string,
  recordId: bigint | string,
  fromState: string | null,
  toState: string,
  opts: { actorId?: bigint; comment?: string | null; workflowStepId?: bigint | null } = {},
): Promise<void> {
  await tx.statusHistory.create({
    data: {
      recordType,
      recordId: recordId.toString(),
      fromState,
      toState,
      changedBy: opts.actorId ?? currentActorId(),
      comment: opts.comment?.slice(0, 1000) ?? null,
      workflowStepId: opts.workflowStepId ?? null,
    },
  });
}
