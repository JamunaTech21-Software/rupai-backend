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
 *   by_reporting_line
 *                  the submitter's supervisor, or the supervisor N levels up (P7 Table 4.1): the
 *                  submitter's user account → its employment profile → supervisor_profile_id, N times →
 *                  the active user accounts linked to that profile, within the document's scope (P2.03).
 *                  It follows the submitter, so it is resolved only for a real submission
 *   by_cost_centre_manager
 *                  the active user accounts linked to the manager profile of the document's cost centre,
 *                  within the document's scope (P3.02, D-3.02-8). No cost centre, or a centre without a
 *                  manager, resolves to nobody; a preview that names no cost centre is deferred
 *
 * An empty result is not an error here: at runtime it raises the unresolved-step exception (P7 §4.3).
 */

export interface StepApproverRule {
  readonly approverRule: ApproverRule;
  readonly roleId: bigint | null;
  readonly userId: bigint | null;
  /** by_reporting_line: how many levels up (1 = the submitter's own supervisor). */
  readonly reportingLevel?: number | null;
}

/** The approver rule of a workflow step row. */
export function stepRule(s: {
  readonly approverRule: string;
  readonly roleId: bigint | null;
  readonly userId: bigint | null;
  readonly reportingLevel: number | null;
}): StepApproverRule {
  return {
    approverRule: s.approverRule as ApproverRule,
    roleId: s.roleId,
    userId: s.userId,
    reportingLevel: s.reportingLevel,
  };
}

/** Where the document sits, for scope. Absent: unknown (a preview without a place). */
export interface DocumentPlace {
  readonly estateId?: bigint | null;
  readonly factoryId?: bigint | null;
  readonly warehouseId?: bigint | null;
  /** Who submitted it: a reporting-line step follows them. Absent: a preview, not yet submitted. */
  readonly submittedBy?: bigint | null;
  /** Its cost centre: a cost-centre-manager step follows it. Absent: a preview that names none. */
  readonly costCentreId?: bigint | null;
}

/** The place of a pending approval request, as stored when it was submitted. */
export function placeOfRequest(r: {
  readonly estateId: bigint | null;
  readonly factoryId: bigint | null;
  readonly warehouseId: bigint | null;
  readonly submittedBy: bigint;
  readonly costCentreId: bigint | null;
}): DocumentPlace {
  return {
    estateId: r.estateId,
    factoryId: r.factoryId,
    warehouseId: r.warehouseId,
    submittedBy: r.submittedBy,
    costCentreId: r.costCentreId,
  };
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

const MAX_REPORTING_LEVEL = 10;

/**
 * The profile `level` steps up the submitter's reporting line, or null when the line ends first (no
 * profile, no supervisor, or a supervisor separated). A loop in the line stops at the depth limit.
 */
async function supervisorProfileOf(db: Database | Tx, submitterId: bigint, level: number) {
  const user = await db.user.findUnique({
    where: { id: submitterId },
    select: { employmentProfileId: true },
  });
  let profileId = user?.employmentProfileId ?? null;
  for (let i = 0; i < Math.min(Math.max(level, 1), MAX_REPORTING_LEVEL) && profileId !== null; i += 1) {
    // Reads the line itself, whatever the reader's scope: the line is not the data being protected.
    const rows = await db.$queryRaw<
      { supervisor_profile_id: bigint | number | null; status: string | null }[]
    >`
      SELECT s.id AS supervisor_profile_id, s.status
        FROM employment_profile p
        LEFT JOIN employment_profile s ON s.id = p.supervisor_profile_id
       WHERE p.id = ${profileId}`;
    const next = rows[0];
    const supervisor = next?.supervisor_profile_id ?? null;
    profileId = supervisor !== null && next?.status !== 'separated' ? BigInt(supervisor) : null;
  }
  return profileId;
}

async function reportingLineUsers(
  db: Database | Tx,
  document: ApprovableDocument,
  step: StepApproverRule,
  place: DocumentPlace,
  only?: bigint,
) {
  if (!place.submittedBy) return null;
  const profileId = await supervisorProfileOf(db, place.submittedBy, step.reportingLevel ?? 1);
  if (profileId === null) return [];
  return db.user.findMany({
    where: {
      ...(only !== undefined ? { id: only } : {}),
      employmentProfileId: profileId,
      status: 'active',
      ...(placeKnown(document, place) ? { scopes: { some: scopeFilter(document, place) } } : {}),
    },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });
}

/** The users managing the document's cost centre (null: a preview that names no cost centre). */
async function costCentreManagers(
  db: Database | Tx,
  document: ApprovableDocument,
  place: DocumentPlace,
  only?: bigint,
) {
  if (place.costCentreId === undefined) return null;
  if (place.costCentreId === null) return [];
  const centre = await db.costCentre.findUnique({
    where: { id: place.costCentreId },
    select: { managerProfileId: true, status: true },
  });
  if (!centre?.managerProfileId || centre.status !== 'active') return [];
  return db.user.findMany({
    where: {
      ...(only !== undefined ? { id: only } : {}),
      employmentProfileId: centre.managerProfileId,
      status: 'active',
      ...(placeKnown(document, place) ? { scopes: { some: scopeFilter(document, place) } } : {}),
    },
    select: { id: true, username: true },
    orderBy: { username: 'asc' },
  });
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
  if (step.approverRule === 'by_reporting_line') {
    const users = await reportingLineUsers(db, document, step, place);
    if (users === null) return { users: [], deferred: true };
    return { users: users.map((u) => ({ id: u.id.toString(), username: u.username })), deferred: false };
  }
  if (step.approverRule === 'by_cost_centre_manager') {
    const users = await costCentreManagers(db, document, place);
    if (users === null) return { users: [], deferred: true };
    return { users: users.map((u) => ({ id: u.id.toString(), username: u.username })), deferred: false };
  }
  if (step.roleId === null) return { users: [], deferred: true };

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
  if (step.approverRule === 'by_reporting_line') {
    return ((await reportingLineUsers(db, document, step, place, userId)) ?? []).length === 1;
  }
  if (step.approverRule === 'by_cost_centre_manager') {
    return ((await costCentreManagers(db, document, place, userId)) ?? []).length === 1;
  }
  if (step.roleId === null) return false;
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
