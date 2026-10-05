import type { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type {
  AccessCheckOut,
  AuthorisationOut,
  ConcentrationReportOut,
  RequirementOut,
} from './identity.schema.js';
import * as repo from './identity.repository.js';
import { requirementsFor, SENSITIVE_WHY, SOD_RULES, type Requirement } from './sod-rules.js';

/**
 * Separation of duties and sensitive permissions (Spec P6 §5.3, §9, §10).
 *
 *   - Checked on the UNION of a user's live roles, whenever that union changes: role assignment, a
 *     role's permissions changing, a role being reactivated (P6 §9.1).
 *   - A prohibited combination or a sensitive permission does not block the change; it requires a
 *     named, written authorisation with a reason, recorded with who gave it and when. Without one the
 *     change is refused with 422 AUTHORISATION_REQUIRED, listing exactly what needs authorising.
 *   - An authorisation stays on the concentration report until it is removed. Removal is recorded,
 *     never deleted.
 *   - The concentration report doubles as the scheduled review (P6 §9.1): it finds every conflict or
 *     sensitive permission held WITHOUT an authorisation, however it arose. Running it on a schedule
 *     arrives with the job runner (P1.15).
 */

type RequirementOutT = z.infer<typeof RequirementOut>;
type AuthorisationOutT = z.infer<typeof AuthorisationOut>;

export interface ProvidedAuthorisation {
  readonly key: string;
  readonly reason: string;
  /** The user it is for. Omitted when the change concerns one user (role assignment). */
  readonly user_id?: bigint;
}

export interface Subject {
  readonly userId: bigint;
  readonly username: string;
  /** The user's effective permissions AFTER the change. */
  readonly permissions: ReadonlySet<string>;
}

const toRequirementOut = (r: Requirement, authorised: boolean): RequirementOutT => ({
  key: r.key,
  kind: r.kind,
  rule: r.rule,
  title: r.title,
  why: r.why,
  permissions: [...r.permissions],
  authorised,
});

export function toAuthorisationOut(a: repo.AuthorisationRow): AuthorisationOutT {
  return {
    id: a.id.toString(),
    user_id: a.userId.toString(),
    kind: a.kind as AuthorisationOutT['kind'],
    rule: a.ruleCode,
    key: a.authorisationKey,
    permissions: a.permissions.split(','),
    reason: a.reason,
    authorised_by: a.authorisedBy.toString(),
    authorised_at: a.authorisedAt.toISOString(),
    removed_at: a.removedAt?.toISOString() ?? null,
    removed_by: a.removedBy?.toString() ?? null,
    active: a.removedAt === null,
  };
}

/**
 * Inside the caller's transaction: refuses the change unless every requirement of every subject is
 * covered by an active authorisation or by one provided now, then records the provided ones.
 *
 * @param field the request field holding the authorisations, for error paths (`authorisations`).
 */
export async function enforceAuthorisations(
  tx: Tx,
  subjects: readonly Subject[],
  provided: readonly ProvidedAuthorisation[],
  actorId: bigint,
  field = 'authorisations',
): Promise<void> {
  const byUser = new Map<bigint, ProvidedAuthorisation[]>();
  for (const p of provided) {
    const uid = p.user_id ?? subjects[0]?.userId;
    if (uid === undefined) continue;
    byUser.set(uid, [...(byUser.get(uid) ?? []), p]);
  }

  const missing: ErrorDetail[] = [];
  const unused = new Set(provided);
  const toInsert: Parameters<typeof repo.insertAuthorisations>[1][number][] = [];

  for (const s of subjects) {
    const active = await repo.activeAuthorisationKeys(tx, s.userId);
    const offered = new Map((byUser.get(s.userId) ?? []).map((p) => [p.key, p]));
    for (const r of requirementsFor(s.permissions)) {
      if (active.has(r.key)) continue;
      const given = offered.get(r.key);
      if (given) {
        unused.delete(given);
        toInsert.push({
          userId: s.userId,
          kind: r.kind,
          ruleCode: r.rule,
          authorisationKey: r.key,
          permissions: r.permissions.join(','),
          reason: given.reason.trim(),
          authorisedBy: actorId,
        });
        continue;
      }
      missing.push({
        field,
        code: r.kind === 'sod_override' ? 'SOD_CONFLICT' : 'SENSITIVE_PERMISSION',
        message:
          r.kind === 'sod_override'
            ? `${s.username}: ${r.title}. ${r.why}`
            : `${s.username}: ${r.title} needs a named authorisation. ${r.why}`,
        context: {
          key: r.key,
          rule: r.rule,
          kind: r.kind,
          permissions: r.permissions,
          user_id: s.userId.toString(),
          username: s.username,
        },
      });
    }
  }

  // An authorisation for something the change does not need is a client mistake, not silently kept.
  const stray = provided
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => unused.has(p))
    .map(({ i }) => ({
      field: `${field}.${String(i)}.key`,
      code: 'VALIDATION_FAILED',
      message: 'This change does not need this authorisation (or it is already authorised).',
    }));
  if (stray.length > 0) throw Errors.validation(stray);

  if (missing.length > 0) {
    throw new AppError(
      'AUTHORISATION_REQUIRED',
      'This change needs a named authorisation for each conflict and sensitive permission listed.',
      missing,
    );
  }
  await repo.insertAuthorisations(tx, toInsert);
}

const roleCodesOf = (u: Awaited<ReturnType<typeof repo.effectiveAccessOfActiveUsers>>[number]) =>
  u.roles.map((r) => r.role.code).sort();
const permissionsOf = (u: Awaited<ReturnType<typeof repo.effectiveAccessOfActiveUsers>>[number]) =>
  new Set(
    u.roles.flatMap((r) => r.role.permissions.map((p) => `${p.permission.module}.${p.permission.action}`)),
  );

export function accessService(db: Database) {
  return {
    rules() {
      return SOD_RULES.map((r) => ({
        code: r.code,
        title: r.title,
        why: r.why,
        combinations: r.combinations.map((c) => [...c]),
      }));
    },

    /** What a proposed role set would require for a user. Changes nothing. */
    async check(
      userId: bigint,
      roles: readonly { role_id: bigint; expires_at?: Date | null | undefined }[],
    ): Promise<z.infer<typeof AccessCheckOut>> {
      if (!(await repo.userExists(db, userId))) throw Errors.notFound('User not found.');
      const now = Date.now();
      const live = roles.filter((r) => !r.expires_at || r.expires_at.getTime() > now).map((r) => r.role_id);
      const permissions = await repo.permissionKeysOfRoles(db, live);
      const active = await repo.activeAuthorisationKeys(db, userId);
      const requirements = requirementsFor(permissions).map((r) => toRequirementOut(r, active.has(r.key)));
      return {
        user_id: userId.toString(),
        permissions: [...permissions].sort(),
        requirements,
        missing: requirements.filter((r) => !r.authorised).length,
      };
    },

    async listForUser(userId: bigint): Promise<AuthorisationOutT[]> {
      if (!(await repo.userExists(db, userId))) throw Errors.notFound('User not found.');
      return (await repo.listAuthorisations(db, { userId })).map(toAuthorisationOut);
    },

    async remove(userId: bigint, authorisationId: bigint, actorId: bigint): Promise<void> {
      await withTransaction(db, async (tx) => {
        if ((await repo.removeAuthorisation(tx, userId, authorisationId, actorId)) === 0) {
          throw Errors.notFound('No active authorisation with this id for this user.');
        }
      });
    },

    /** P6 §9.2, and the scheduled review of §9.1. */
    async concentrationReport(): Promise<z.infer<typeof ConcentrationReportOut>> {
      const users = await repo.effectiveAccessOfActiveUsers(db);
      const overrides = await repo.listAuthorisations(db, { removedAt: null });
      const activeByUser = new Map<bigint, Set<string>>();
      for (const a of overrides) {
        activeByUser.set(a.userId, (activeByUser.get(a.userId) ?? new Set()).add(a.authorisationKey));
      }
      const perUser = new Map(users.map((u) => [u.id, { u, perms: permissionsOf(u) }]));

      const sensitive = new Map<string, { id: string; username: string; authorised: boolean }[]>();
      const unauthorised: z.infer<typeof ConcentrationReportOut>['unauthorised'] = [];
      const approveAndPost: z.infer<typeof ConcentrationReportOut>['approve_and_post'] = [];
      const manyRoles: z.infer<typeof ConcentrationReportOut>['users_with_many_roles'] = [];

      for (const { u, perms } of perUser.values()) {
        const active = activeByUser.get(u.id) ?? new Set<string>();
        const reqs = requirementsFor(perms);
        for (const r of reqs.filter((x) => x.kind === 'sensitive_grant')) {
          const p = r.permissions[0] ?? '';
          sensitive.set(p, [
            ...(sensitive.get(p) ?? []),
            { id: u.id.toString(), username: u.username, authorised: active.has(r.key) },
          ]);
        }
        const open = reqs.filter((r) => !active.has(r.key));
        if (open.length > 0) {
          unauthorised.push({
            id: u.id.toString(),
            username: u.username,
            requirements: open.map((r) => toRequirementOut(r, false)),
          });
        }
        const modules = [...perms]
          .filter((p) => p.endsWith('.approve') && perms.has(p.replace(/\.approve$/, '.post')))
          .map((p) => p.replace(/\.approve$/, ''))
          .sort();
        if (modules.length > 0) approveAndPost.push({ id: u.id.toString(), username: u.username, modules });
        const roles = roleCodesOf(u);
        if (roles.length >= 4) manyRoles.push({ id: u.id.toString(), username: u.username, roles });
      }

      return {
        generated_at: new Date().toISOString(),
        active_overrides: overrides
          .filter((a) => a.kind === 'sod_override')
          .map((a) => {
            const held = perUser.get(a.userId)?.perms;
            return {
              ...toAuthorisationOut(a),
              user: { id: a.user.id.toString(), username: a.user.username },
              still_held: held !== undefined && a.permissions.split(',').every((p) => held.has(p)),
            };
          }),
        sensitive_holders: [...sensitive.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([permission, holders]) => ({
            permission,
            why: SENSITIVE_WHY[permission] ?? '',
            holders,
          })),
        users_with_many_roles: manyRoles,
        approve_and_post: approveAndPost,
        unauthorised,
      };
    },
  };
}

export type AccessService = ReturnType<typeof accessService>;
