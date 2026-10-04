import type { Logger } from 'pino';

import type { Database } from '../db/prisma.js';
import type { Tx } from '../db/transaction.js';
import { getLogger } from '../logging/logger.js';
import type { RedisClient } from '../redis/redis.js';

/**
 * Server-side session state (Spec P4 §2.2.1, P1 §12.4): "a store of active token identifiers, in Redis
 * with a database fallback, checked on every request".
 *
 *   - The database (auth_session) is the authority. A session is live while it is not revoked, not past
 *     its absolute expiry, and its user is active.
 *   - Redis caches that answer for a few seconds, so the per-request check is one Redis read. After a
 *     revocation commits, `markRevoked` overwrites the entry with a tombstone (a revoked session never
 *     comes back), and cache fills only write when no entry exists, so a request that read the database
 *     just before the revocation cannot put a stale "live" back. If Redis is unavailable the check goes
 *     to the database: slower, never wrong.
 *   - Disabling a user, changing or resetting a password, logging out and refresh-token reuse all revoke
 *     sessions through this module, so access ends on the next request rather than at token expiry.
 */

export const REVOKE_REASONS = [
  'logout',
  'logout_all',
  'session_revoked',
  'refresh_reuse',
  'user_disabled',
  'password_changed',
  'password_reset',
] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export interface SessionState {
  readonly userId: bigint;
  /** Not revoked, not expired, and the user is active. */
  readonly live: boolean;
  readonly mustChangePassword: boolean;
}

export interface SessionStore {
  /** The session's state, or null if it does not exist. */
  state(sessionId: bigint): Promise<SessionState | null>;
  /**
   * Revokes the user's live sessions (all, or all but one) inside the caller's transaction. Returns the
   * revoked ids: pass them to `forget` AFTER the transaction commits.
   */
  revokeForUser(
    tx: Tx,
    userId: bigint,
    reason: RevokeReason,
    options?: { except?: bigint },
  ): Promise<bigint[]>;
  /** Revokes one session if it is live. Returns its id when it was revoked. */
  revoke(tx: Tx, sessionId: bigint, reason: RevokeReason): Promise<bigint[]>;
  /** After the revoking transaction commits: the next check refuses at once. Never throws. */
  markRevoked(sessionIds: readonly bigint[]): Promise<void>;
  /** After a change to a live session's user (e.g. password changed): re-read next time. Never throws. */
  forget(sessionIds: readonly bigint[]): Promise<void>;
}

/** Upper bound on how long a cached answer is trusted if an invalidation is ever lost. */
export const SESSION_CACHE_SECONDS = 30;

/**
 * The database name taken from a connection URL. Session ids are per database, so the cache key carries
 * it: two databases sharing one Redis (a developer's machine running the server and the tests) never
 * read each other's entries.
 */
export function databaseNameOf(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).pathname.replace(/^\//, '') || 'default';
  } catch {
    return 'default';
  }
}

interface Row {
  user_id: bigint;
  live: number | bigint;
  must_change_password: number | boolean;
  seconds_left: number | bigint | null;
}

async function readState(
  db: Database | Tx,
  sessionId: bigint,
): Promise<(SessionState & { ttl: number }) | null> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT s.user_id,
           (s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP() AND u.status = 'active') AS live,
           u.must_change_password,
           TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), s.expires_at) AS seconds_left
      FROM auth_session s
      JOIN user u ON u.id = s.user_id
     WHERE s.id = ${sessionId}`;
  const r = rows[0];
  if (!r) return null;
  return {
    userId: r.user_id,
    live: Number(r.live) === 1,
    mustChangePassword: Boolean(Number(r.must_change_password)),
    ttl: Math.max(0, Math.min(SESSION_CACHE_SECONDS, Number(r.seconds_left ?? 0))),
  };
}

export function sessionStore(
  db: Database,
  redis: RedisClient | null,
  logger: Logger,
  options: { namespace?: string } = {},
): SessionStore {
  const prefix = `sess:${options.namespace ?? 'default'}:`;
  const cacheKey = (sessionId: bigint) => `${prefix}${sessionId.toString()}`;
  const log = () => getLogger(logger);

  async function cached(sessionId: bigint): Promise<SessionState | null | undefined> {
    if (!redis) return undefined;
    try {
      const raw = await redis.get(cacheKey(sessionId));
      if (raw === null) return undefined;
      if (raw === 'none') return null;
      if (raw === 'revoked') return { userId: 0n, live: false, mustChangePassword: false };
      const v = JSON.parse(raw) as { u: string; l: boolean; m: boolean };
      return { userId: BigInt(v.u), live: v.l, mustChangePassword: v.m };
    } catch (err) {
      log().warn({ err }, 'session cache read failed; using the database');
      return undefined;
    }
  }

  async function store(sessionId: bigint, state: (SessionState & { ttl: number }) | null): Promise<void> {
    if (!redis) return;
    try {
      const value = state
        ? JSON.stringify({ u: state.userId.toString(), l: state.live, m: state.mustChangePassword })
        : 'none';
      // NX: never overwrite, so a fill cannot undo a tombstone written by a revocation in the meantime.
      await redis.set(
        cacheKey(sessionId),
        value,
        'EX',
        state && state.ttl > 0 ? state.ttl : SESSION_CACHE_SECONDS,
        'NX',
      );
    } catch (err) {
      log().warn({ err }, 'session cache write failed');
    }
  }

  async function revokeWhere(
    tx: Tx,
    where: { userId?: bigint; id?: bigint; exceptId?: bigint },
    reason: RevokeReason,
  ): Promise<bigint[]> {
    const live = await tx.authSession.findMany({
      where: {
        ...(where.userId !== undefined ? { userId: where.userId } : {}),
        ...(where.id !== undefined ? { id: where.id } : {}),
        ...(where.exceptId !== undefined ? { id: { not: where.exceptId } } : {}),
        revokedAt: null,
      },
      select: { id: true },
    });
    const ids = live.map((s) => s.id);
    if (ids.length > 0) {
      await tx.authSession.updateMany({
        where: { id: { in: ids }, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: reason },
      });
    }
    return ids;
  }

  return {
    async state(sessionId) {
      const hit = await cached(sessionId);
      if (hit !== undefined) return hit;
      const fresh = await readState(db, sessionId);
      await store(sessionId, fresh);
      return fresh
        ? { userId: fresh.userId, live: fresh.live, mustChangePassword: fresh.mustChangePassword }
        : null;
    },

    revokeForUser(tx, userId, reason, options = {}) {
      return revokeWhere(
        tx,
        { userId, ...(options.except !== undefined ? { exceptId: options.except } : {}) },
        reason,
      );
    },

    revoke(tx, sessionId, reason) {
      return revokeWhere(tx, { id: sessionId }, reason);
    },

    async markRevoked(sessionIds) {
      if (!redis || sessionIds.length === 0) return;
      try {
        const multi = redis.multi();
        for (const id of sessionIds) multi.set(cacheKey(id), 'revoked', 'EX', SESSION_CACHE_SECONDS);
        await multi.exec();
      } catch (err) {
        // The cached entry expires within SESSION_CACHE_SECONDS anyway.
        log().error({ err, session_ids: sessionIds.map(String) }, 'session cache invalidation failed');
      }
    },

    async forget(sessionIds) {
      if (!redis || sessionIds.length === 0) return;
      try {
        await redis.del(...sessionIds.map(cacheKey));
      } catch (err) {
        // The cached entry expires within SESSION_CACHE_SECONDS anyway.
        log().error({ err, session_ids: sessionIds.map(String) }, 'session cache invalidation failed');
      }
    },
  };
}
