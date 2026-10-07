import type { z } from 'zod';

import { constraintViolation } from '../../core/db/errors.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { TargetedScopeType } from '../../core/scope/scope.js';
import { SCOPE_TARGETS } from '../../core/scope/targets.js';
import type { CreateScopeGrantBody, ScopeGrantOut } from './identity.schema.js';
import { auditCreate, auditDelete, auditUpdate } from '../../core/audit/audit.js';
import { SCOPE_AUDIT, scopeAuditValues } from './identity.audit.js';
import * as repo from './identity.repository.js';

/**
 * Data-scope grants (Spec P3 §28.2, P6 §4, §11.2).
 *
 *   - A user's effective scope is the union of their live grants, plus implicit self (P6 §6.1).
 *   - A grant may expire, for temporary cover. A lapsed grant is kept, shows active=false, and confers
 *     nothing. Changing the expiry records who decided it and when.
 *   - all_estates and self name no target; the other types name exactly one record, which must exist
 *     once its table does (core/scope/targets.ts).
 *   - The same grant twice is DUPLICATE_KEY. A grant's target never changes: revoke and grant again.
 *   - Changes apply to the user's very next request: scope is resolved per request, never cached in a
 *     token or session.
 */

type ScopeGrantOutT = z.infer<typeof ScopeGrantOut>;

export function toScopeGrantOut(g: repo.ScopeGrantRow, now = new Date()): ScopeGrantOutT {
  return {
    id: g.id.toString(),
    user_id: g.userId.toString(),
    scope_type: g.scopeType as ScopeGrantOutT['scope_type'],
    scope_id: g.scopeId?.toString() ?? null,
    granted_at: g.grantedAt.toISOString(),
    granted_by: g.grantedBy.toString(),
    expires_at: g.expiresAt?.toISOString() ?? null,
    active: g.expiresAt === null || g.expiresAt > now,
    version: g.version,
    created_at: g.createdAt.toISOString(),
    updated_at: g.updatedAt?.toISOString() ?? null,
  };
}

function inTheFuture(expiresAt: Date | null | undefined): void {
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw Errors.validation([
      { field: 'expires_at', code: 'VALIDATION_FAILED', message: 'Must be in the future.' },
    ]);
  }
}

async function userOrNotFound(tx: Tx, userId: bigint): Promise<void> {
  if (!(await repo.userExists(tx, userId))) throw Errors.notFound('User not found.');
}

async function grantOrNotFound(tx: Tx, userId: bigint, grantId: bigint): Promise<repo.ScopeGrantRow> {
  const g = await repo.findScopeGrant(tx, userId, grantId);
  if (!g) throw Errors.notFound('Scope grant not found.');
  return g;
}

export function userScopesService(db: Database) {
  return {
    async list(userId: bigint): Promise<ScopeGrantOutT[]> {
      await userOrNotFound(db, userId);
      const now = new Date();
      return (await repo.listScopeGrants(db, userId)).map((g) => toScopeGrantOut(g, now));
    },

    async grant(
      userId: bigint,
      body: z.infer<typeof CreateScopeGrantBody>,
      actorId: bigint,
    ): Promise<ScopeGrantOutT> {
      inTheFuture(body.expires_at);
      return withTransaction(db, async (tx) => {
        await userOrNotFound(tx, userId);
        const scopeId = body.scope_type === 'all_estates' ? null : (body.scope_id ?? null);
        const check = scopeId === null ? undefined : SCOPE_TARGETS.get(body.scope_type as TargetedScopeType);
        if (check && scopeId !== null && !(await check(tx, scopeId))) {
          throw Errors.validation([
            { field: 'scope_id', code: 'VALIDATION_FAILED', message: `No such ${body.scope_type}.` },
          ]);
        }
        const { id } = await repo
          .insertScopeGrant(tx, {
            userId,
            scopeType: body.scope_type,
            scopeId,
            expiresAt: body.expires_at ?? null,
            actorId,
          })
          .catch((err: unknown) => {
            if (constraintViolation(err)?.kind === 'unique') {
              throw new AppError('DUPLICATE_KEY', 'The user already holds this scope.', [
                {
                  field: 'scope_id',
                  code: 'DUPLICATE_KEY',
                  message: 'Change the existing grant’s expiry instead.',
                },
              ]);
            }
            throw err;
          });
        const out = toScopeGrantOut(await grantOrNotFound(tx, userId, id));
        await auditCreate(tx, SCOPE_AUDIT, id, scopeAuditValues(out), { actorId });
        return out;
      });
    },

    async setExpiry(
      userId: bigint,
      grantId: bigint,
      expectedVersion: number,
      expiresAt: Date | null,
      actorId: bigint,
    ): Promise<ScopeGrantOutT> {
      inTheFuture(expiresAt);
      return withTransaction(db, async (tx) => {
        const g = await grantOrNotFound(tx, userId, grantId);
        const conflict = async () => {
          const now = await grantOrNotFound(tx, userId, grantId);
          return Errors.versionConflict({ version: now.version, resource: toScopeGrantOut(now) });
        };
        if (g.version !== expectedVersion) throw await conflict();
        if (!(await repo.updateScopeGrantExpiryAtVersion(tx, grantId, expectedVersion, expiresAt, actorId))) {
          throw await conflict();
        }
        const after = toScopeGrantOut(await grantOrNotFound(tx, userId, grantId));
        await auditUpdate(
          tx,
          SCOPE_AUDIT,
          grantId,
          scopeAuditValues(toScopeGrantOut(g)),
          scopeAuditValues(after),
          {
            actorId,
          },
        );
        return after;
      });
    },

    async revoke(userId: bigint, grantId: bigint, actorId: bigint): Promise<void> {
      await withTransaction(db, async (tx) => {
        await userOrNotFound(tx, userId);
        const g = await grantOrNotFound(tx, userId, grantId);
        await repo.deleteScopeGrant(tx, userId, grantId);
        await auditDelete(tx, SCOPE_AUDIT, grantId, scopeAuditValues(toScopeGrantOut(g)), { actorId });
      });
    },
  };
}
