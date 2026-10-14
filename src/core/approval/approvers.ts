import type { Database } from '../db/prisma.js';
import type { Tx } from '../db/transaction.js';
import type { ApprovableDocument } from './document-types.js';
import type { ApproverRule } from './definition.js';

/**
 * Approver resolution (Spec P7 §4). A step stores a rule; who that means is worked out when it is needed,
 * so a change of estate manager needs no data migration (P7 §4.2).
 *
 *   by_role        every ACTIVE user holding the role (grant not lapsed) whose scope includes the
 *                  document: an estate manager of Estate A is never offered an Estate B document, and a
 *                  user whose scope grant has expired is not resolved (P7 §4.4)
 *   by_named_user  that user, if active
 *   by_reporting_line, by_cost_centre_manager
 *                  follow the submitter and the document, so they can only be resolved for a real
 *                  submission (P1.14; the tables they read arrive in Phase 2 and Phase 3)
 *
 * An empty result is not an error here: at runtime it raises the unresolved-step exception (P7 §4.3).
 */

export interface StepApproverRule {
  readonly approverRule: ApproverRule;
  readonly roleId: bigint | null;
  readonly userId: bigint | null;
}

/** Where the document sits, for scope. Absent: unknown (a preview without a place). */
export interface DocumentPlace {
  readonly estateId?: bigint | null;
  readonly factoryId?: bigint | null;
  readonly warehouseId?: bigint | null;
}

export interface ResolvedApprovers {
  readonly users: readonly { readonly id: string; readonly username: string }[];
  /** Why no users are listed although the step is valid: resolved only for a real submission. */
  readonly deferred: boolean;
}

/** The live scope grants that let a user act on a document in this place. */
export function scopeFilter(document: ApprovableDocument, place: DocumentPlace) {
  const live = { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] };
  const grants: { scopeType: string; scopeId?: bigint }[] = [{ scopeType: 'all_estates' }];
  if (document.tier === 'estate' && place.estateId)
    grants.push({ scopeType: 'estate', scopeId: place.estateId });
  if (document.tier === 'facility') {
    if (place.factoryId) grants.push({ scopeType: 'factory', scopeId: place.factoryId });
    if (place.warehouseId) grants.push({ scopeType: 'warehouse', scopeId: place.warehouseId });
  }
  return { AND: [live, { OR: grants }] };
}

/** Whether the place needed to judge scope for this document's tier is known. */
export function placeKnown(document: ApprovableDocument, place: DocumentPlace): boolean {
  if (document.tier === 'organisation') return true;
  if (document.tier === 'estate') return Boolean(place.estateId);
  return Boolean(place.factoryId) || Boolean(place.warehouseId);
}

export async function resolveApprovers(
  db: Database | Tx,
  document: ApprovableDocument,
  step: StepApproverRule,
  place: DocumentPlace,
): Promise<ResolvedApprovers> {
  if (step.approverRule === 'by_named_user') {
    const user =
      step.userId === null
        ? null
        : await db.user.findFirst({
            where: { id: step.userId, status: 'active' },
            select: { id: true, username: true },
          });
    return { users: user ? [{ id: user.id.toString(), username: user.username }] : [], deferred: false };
  }
  if (step.approverRule !== 'by_role' || step.roleId === null) return { users: [], deferred: true };

  const users = await db.user.findMany({
    where: {
      status: 'active',
      roles: {
        some: {
          roleId: step.roleId,
          role: { status: 'active' },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      },
      // Without a place (a preview that names no estate) every holder is listed.
      ...(placeKnown(document, place) ? { scopes: { some: scopeFilter(document, place) } } : {}),
    },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
    take: 50,
  });
  return { users: users.map((u) => ({ id: u.id.toString(), username: u.username })), deferred: false };
}

/**
 * Whether this one user is an approver of the step, by the same rule as `resolveApprovers`. At runtime the
 * place is always known (it is copied from the document at submission), so scope always applies.
 */
export async function isApprover(
  db: Database | Tx,
  document: ApprovableDocument,
  step: StepApproverRule,
  place: DocumentPlace,
  userId: bigint,
): Promise<boolean> {
  if (step.approverRule === 'by_named_user') {
    return step.userId === userId && (await db.user.count({ where: { id: userId, status: 'active' } })) === 1;
  }
  if (step.approverRule !== 'by_role' || step.roleId === null) return false;
  const count = await db.user.count({
    where: {
      id: userId,
      status: 'active',
      roles: {
        some: {
          roleId: step.roleId,
          role: { status: 'active' },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
      },
      ...(placeKnown(document, place) ? { scopes: { some: scopeFilter(document, place) } } : {}),
    },
  });
  return count === 1;
}
