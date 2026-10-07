import type { Database } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/transaction.js';

/**
 * Persistence for sign-in, sessions, refresh tokens and password resets. No business rules here.
 * Session revocation itself lives in core/auth/sessions.ts, because users.service (disable) needs it too.
 */

export function findUserForLogin(db: Database, username: string) {
  return db.user.findUnique({
    where: { username },
    select: {
      id: true,
      username: true,
      passwordHash: true,
      status: true,
      lockedUntil: true,
      mustChangePassword: true,
    },
  });
}

/**
 * One failed attempt, atomically. At the threshold the account locks and the counter restarts.
 * MySQL evaluates SET assignments left to right, so locked_until is decided from the OLD counter.
 * @returns the lock expiry when this attempt locked the account, otherwise null.
 */
export async function recordFailedAttempt(
  tx: Tx,
  userId: bigint,
  threshold: number,
  lockSeconds: number,
): Promise<Date | null> {
  await tx.$executeRaw`
    UPDATE user
       SET locked_until    = IF(failed_attempts + 1 >= ${threshold},
                                UTC_TIMESTAMP() + INTERVAL ${lockSeconds} SECOND, locked_until),
           failed_attempts = IF(failed_attempts + 1 >= ${threshold}, 0, failed_attempts + 1)
     WHERE id = ${userId}`;
  const row = await tx.user.findUnique({
    where: { id: userId },
    select: { lockedUntil: true, failedAttempts: true },
  });
  return row?.failedAttempts === 0 && row.lockedUntil && row.lockedUntil > new Date()
    ? row.lockedUntil
    : null;
}

export async function recordSuccessfulLogin(
  tx: Tx,
  userId: bigint,
  at: Date,
  rehashed: string | null,
): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: {
      failedAttempts: 0,
      lockedUntil: null,
      lastLoginAt: at,
      ...(rehashed ? { passwordHash: rehashed } : {}),
    },
  });
}

export function insertSession(
  tx: Tx,
  data: { userId: bigint; expiresAt: Date; ipAddress: string | null; userAgent: string | null },
): Promise<{ id: bigint }> {
  return tx.authSession.create({ data, select: { id: true } });
}

export async function insertRefreshToken(
  tx: Tx,
  data: { sessionId: bigint; tokenHash: string; expiresAt: Date },
): Promise<void> {
  await tx.authRefreshToken.create({ data });
}

export interface RefreshTokenRow {
  id: bigint;
  session_id: bigint;
  used: number | bigint;
  token_live: number | bigint;
  session_live: number | bigint;
  session_expires_at: Date;
  user_id: bigint;
  username: string;
  user_active: number | bigint;
  must_change_password: number | boolean;
}

/** The token, its session and user. Locks the token and session rows: one refresh per session at a time. */
export async function lockRefreshToken(tx: Tx, tokenHash: string): Promise<RefreshTokenRow | null> {
  const rows = await tx.$queryRaw<RefreshTokenRow[]>`
    SELECT t.id, t.session_id,
           (t.used_at IS NOT NULL)                                    AS used,
           (t.expires_at > UTC_TIMESTAMP())                           AS token_live,
           (s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP())  AS session_live,
           s.expires_at                                               AS session_expires_at,
           u.id AS user_id, u.username, (u.status = 'active')         AS user_active,
           u.must_change_password
      FROM auth_refresh_token t
      JOIN auth_session s ON s.id = t.session_id
      JOIN user u         ON u.id = s.user_id
     WHERE t.token_hash = ${tokenHash}
       FOR UPDATE OF t, s`;
  return rows[0] ?? null;
}

export async function markRefreshTokenUsed(tx: Tx, id: bigint): Promise<void> {
  await tx.authRefreshToken.update({ where: { id }, data: { usedAt: new Date() } });
}

export async function touchSession(tx: Tx, id: bigint, ipAddress: string | null): Promise<void> {
  await tx.authSession.update({ where: { id }, data: { lastUsedAt: new Date(), ipAddress } });
}

export async function findSessionIdByRefreshToken(db: Database, tokenHash: string): Promise<bigint | null> {
  const row = await db.authRefreshToken.findUnique({ where: { tokenHash }, select: { sessionId: true } });
  return row?.sessionId ?? null;
}

export function findSession(db: Database | Tx, id: bigint) {
  return db.authSession.findUnique({ where: { id } });
}

/** Sessions that can still be refreshed: not revoked, not past their absolute or idle expiry. */
export function listLiveSessions(db: Database, userId: bigint, idleSince: Date) {
  return db.authSession.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() }, lastUsedAt: { gt: idleSince } },
    orderBy: [{ lastUsedAt: 'desc' }, { id: 'desc' }],
  });
}

export function findPasswordHash(db: Database, userId: bigint) {
  return db.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true, status: true, mustChangePassword: true },
  });
}

/**
 * Sets a new password (change or reset): clears must-change and any lockout, and moves the user's
 * version, because must_change_password is part of the user resource.
 */
export async function setPassword(tx: Tx, userId: bigint, passwordHash: string): Promise<void> {
  await tx.user.update({
    where: { id: userId },
    data: {
      passwordHash,
      mustChangePassword: false,
      failedAttempts: 0,
      lockedUntil: null,
      version: { increment: 1 },
      updatedAt: new Date(),
      updatedBy: userId,
    },
  });
}

export function findActiveUserByEmail(db: Database, email: string) {
  return db.user.findFirst({
    where: { email, status: 'active' },
    select: { id: true, username: true, email: true },
  });
}

/** A new reset link invalidates any earlier one that was not used. */
export async function replaceResetToken(
  tx: Tx,
  data: { userId: bigint; tokenHash: string; expiresAt: Date; requestedIp: string | null },
): Promise<void> {
  await tx.passwordResetToken.updateMany({
    where: { userId: data.userId, usedAt: null },
    data: { usedAt: new Date() },
  });
  await tx.passwordResetToken.create({ data });
}

export interface ResetTokenRow {
  id: bigint;
  user_id: bigint;
  usable: number | bigint;
}

export async function lockResetToken(tx: Tx, tokenHash: string): Promise<ResetTokenRow | null> {
  const rows = await tx.$queryRaw<ResetTokenRow[]>`
    SELECT t.id, t.user_id,
           (t.used_at IS NULL AND t.expires_at > UTC_TIMESTAMP() AND u.status = 'active') AS usable
      FROM password_reset_token t
      JOIN user u ON u.id = t.user_id
     WHERE t.token_hash = ${tokenHash}
       FOR UPDATE OF t`;
  return rows[0] ?? null;
}

export async function markResetTokenUsed(tx: Tx, id: bigint): Promise<void> {
  await tx.passwordResetToken.update({ where: { id }, data: { usedAt: new Date() } });
}
