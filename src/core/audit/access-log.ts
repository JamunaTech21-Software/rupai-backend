import type { Logger } from 'pino';

import { Prisma } from '../../generated/prisma/client.js';
import { getRequestContext } from '../context/request-context.js';
import type { Database } from '../db/prisma.js';
import { getLogger } from '../logging/logger.js';

/**
 * The access log (Spec P3 §29.2, P1 §12.4, P6 §11.4): every authentication event, every permission and
 * scope denial, every export and print. Append-only in the database.
 *
 * Written OUTSIDE the caller's transaction, on purpose: a refused sign-in or a denied request is exactly
 * the case whose transaction never commits, and the event must still be recorded. A failure to write
 * is logged and does not change the answer the caller gets.
 */

export const ACCESS_EVENTS = [
  'login',
  'logout',
  'failed_login',
  'lockout',
  'token_refresh',
  'refresh_reuse',
  'session_revoked',
  'password_changed',
  'password_change_failed',
  'password_reset',
  'password_reset_requested',
  'permission_denied',
  'scope_denied',
  'export',
  'print',
] as const;
export type AccessEventType = (typeof ACCESS_EVENTS)[number];

export interface AccessEvent {
  /** Defaults to the request's authenticated user; null when nobody is known (unknown username). */
  readonly userId?: bigint | null;
  readonly eventType: AccessEventType;
  readonly module?: string | null;
  readonly recordReference?: string | null;
  /** Structured context. Never a password, token or secret. */
  readonly detail?: Readonly<Record<string, unknown>> | null;
}

export interface AccessLog {
  record(event: AccessEvent): Promise<void>;
}

const jsonSafe = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x))) as unknown;

/** The access log on the database. `db` must be a client OUTSIDE any interactive transaction. */
export function dbAccessLog(db: Database, logger: Logger): AccessLog {
  return {
    async record(event) {
      const ctx = getRequestContext();
      const actor = ctx?.actorId && /^\d+$/.test(ctx.actorId) ? BigInt(ctx.actorId) : null;
      const userId = event.userId === undefined ? actor : event.userId;
      try {
        await db.accessLog.create({
          data: {
            userId,
            eventType: event.eventType,
            module: event.module?.slice(0, 40) ?? null,
            recordReference: event.recordReference?.slice(0, 100) ?? null,
            ipAddress: ctx?.clientIp ?? null,
            userAgent: ctx?.userAgent ?? null,
            detail: event.detail ? (jsonSafe(event.detail) as Prisma.InputJsonValue) : Prisma.DbNull,
          },
        });
      } catch (err) {
        getLogger(logger).error({ err, event: event.eventType }, 'access log write failed');
      }
    },
  };
}

/** Discards events. For tests and tools that build modules without a database. */
export const noAccessLog: AccessLog = { record: () => Promise.resolve() };
