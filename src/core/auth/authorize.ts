import type { RequestHandler } from 'express';

import { getRequestContext } from '../context/request-context.js';
import type { Database } from '../db/prisma.js';
import { AppError } from '../errors/app-error.js';

/**
 * Permission check (Spec P6 §2.1, P4 §4.1): may this user perform this action at all?
 *
 *   user → active roles (not lapsed) → permissions
 *
 * Resolved server-side on EVERY request, never from the token (P4 §2.2.1), so a disabled user, a
 * removed role or a lapsed temporary grant loses access immediately rather than at token expiry.
 *
 * Scope (WHICH records) is the second, independent layer and arrives with P1.03.
 */
export interface PermissionResolver {
  /** The effective permission keys (`module.action`) of an ACTIVE user. Empty for a disabled one. */
  permissionsOf(userId: bigint): Promise<ReadonlySet<string>>;
}

/** Reads effective permissions from the database: active user, active roles, unexpired grants. */
export function dbPermissionResolver(db: Database): PermissionResolver {
  return {
    async permissionsOf(userId) {
      const rows = await db.$queryRaw<{ module: string; action: string }[]>`
        SELECT DISTINCT p.module, p.action
          FROM user u
          JOIN user_role ur      ON ur.user_id = u.id
          JOIN role r            ON r.id = ur.role_id
          JOIN role_permission rp ON rp.role_id = r.id
          JOIN permission p      ON p.id = rp.permission_id
         WHERE u.id = ${userId}
           AND u.status = 'active'
           AND r.status = 'active'
           AND (ur.expires_at IS NULL OR ur.expires_at > UTC_TIMESTAMP())`;
      return new Set(rows.map((r) => `${r.module}.${r.action}`));
    },
  };
}

/** A resolver granting a fixed set to everyone. Tests and documentation generation only. */
export function staticPermissionResolver(permissions: Iterable<string> | 'all'): PermissionResolver {
  const set = permissions === 'all' ? null : new Set(permissions);
  const all: ReadonlySet<string> = { has: () => true } as unknown as ReadonlySet<string>;
  return { permissionsOf: () => Promise.resolve(set ?? all) };
}

export function unauthenticated(code: 'UNAUTHENTICATED' | 'SESSION_EXPIRED' = 'UNAUTHENTICATED'): AppError {
  return code === 'SESSION_EXPIRED'
    ? new AppError('SESSION_EXPIRED', 'Your session has ended. Sign in again.')
    : new AppError('UNAUTHENTICATED', 'Sign in to continue.');
}

/**
 * The authenticated user's id, or 401 (SESSION_EXPIRED when a token was presented but is expired or its
 * session revoked, so the client knows to refresh). Services call this rather than reading the request.
 */
export function currentActorId(): bigint {
  const ctx = getRequestContext();
  const actor = ctx?.actorId;
  if (!actor || !/^\d{1,20}$/.test(actor)) throw unauthenticated(ctx?.authFailure);
  return BigInt(actor);
}

/** The current session's id, or 401. Only real sign-ins have one (not the test actor header). */
export function currentSessionId(): bigint | null {
  const ctx = getRequestContext();
  currentActorId();
  return ctx?.sessionId ? BigInt(ctx.sessionId) : null;
}

/** Route guard for own-account endpoints: any signed-in user, even one who must change a password. */
export function requireSignedIn(): RequestHandler {
  return (_req, _res, next) => {
    currentActorId();
    next();
  };
}

function passwordChangeRequired(): AppError {
  return new AppError('PASSWORD_CHANGE_REQUIRED', 'Change your temporary password to continue.', [
    { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Use POST /api/v1/auth/password/change.' },
  ]);
}

/**
 * Route guard: 401 without an authenticated user, 403 PERMISSION_DENIED without the permission.
 * The resolved permission set is kept on the request context for the rest of the request.
 * (Denials are written to access_log from P1.05.)
 */
export function requirePermission(resolver: PermissionResolver, permission: string): RequestHandler {
  return (_req, _res, next) => {
    const ctx = getRequestContext();
    const actorId = currentActorId();
    // A temporary password unlocks nothing but the user's own account (P3 §32.2).
    if (ctx?.mustChangePassword) throw passwordChangeRequired();
    const run = async () => {
      const permissions = ctx?.permissions ?? (await resolver.permissionsOf(actorId));
      if (ctx) ctx.permissions = permissions;
      if (!permissions.has(permission)) {
        throw new AppError('PERMISSION_DENIED', 'You do not have permission to do this.', [
          { code: 'PERMISSION_DENIED', message: `Requires ${permission}.`, context: { permission } },
        ]);
      }
    };
    run().then(() => {
      next();
    }, next);
  };
}
