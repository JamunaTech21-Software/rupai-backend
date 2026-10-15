import type { Logger } from 'pino';

import type { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../db/prisma.js';
import type { Tx } from '../db/transaction.js';
import type { JobQueue } from '../jobs/queue.js';
import { jobDefinition } from '../jobs/registry.js';
import { createJob } from '../jobs/store.js';
import { businessDateToDb, type BusinessDate } from '../time/dates.js';
import type { Channel, RecipientRule, Severity, TriggerType } from './triggers.js';

/**
 * The notification contract (Spec P1 §7.1: "Queues an alert for delivery. Atomic with source: No — must
 * never block"). It is used ONLY from jobs: the module that owns the data evaluates its trigger in a job
 * of its own, finds what to report, and calls `emit`. A business transaction never writes a
 * notification, so a notification failure can never fail one (P1 §4.3). After its commit, a request may
 * at most ask for an evaluation to run soon (`requestSoon`), which never throws.
 *
 * Duplicates are impossible by construction: the dedupe key (rule, user, link, generation_date, P3 §28.5)
 * is unique, and `generation_date` is the day of the OCCURRENCE (the expiry date, the day the step
 * started), not the day the job ran. So the nightly job finds the same item every night and writes it
 * once.
 */

export interface RuleRow {
  readonly id: bigint;
  readonly code: string;
  readonly triggerType: string;
  readonly conditionJson: Prisma.JsonValue;
  readonly leadDays: number | null;
  readonly recipientRule: string;
  readonly roleId: bigint | null;
  readonly userId: bigint | null;
  readonly channel: string;
  readonly severity: string;
}

/** Where the reported item sits, for scope (P6 §6): recipients only hear of what they may see. */
export interface ItemPlace {
  readonly estateId?: bigint | null;
  readonly factoryId?: bigint | null;
  readonly warehouseId?: bigint | null;
}

/** Who should hear of one item. */
export interface Audience {
  /** null: an organisation-level item, or an administrative one (no scope applies). */
  readonly place: ItemPlace | null;
  /** by_scope: the permission that lets a user see the item, e.g. estate.view. */
  readonly viewPermission?: string;
  /** approvers: the people the event itself names. */
  readonly approvers?: readonly bigint[];
  /** Added whatever the rule says (e.g. the next step's approvers of a stuck approval, P7 §4.3). */
  readonly also?: readonly bigint[];
}

export interface Draft {
  readonly subject: string;
  readonly body: string;
  readonly linkType: string;
  readonly linkId: bigint;
  readonly occurredOn: BusinessDate;
  /** Overrides the rule's severity (e.g. a document that has already expired). */
  readonly severity?: Severity;
}

export async function activeRules(db: Database | Tx, trigger: TriggerType): Promise<RuleRow[]> {
  return db.notificationRule.findMany({
    where: { triggerType: trigger, isActive: true },
    orderBy: { id: 'asc' },
  });
}

const liveRole = (roleId?: bigint) => ({
  ...(roleId !== undefined ? { roleId } : {}),
  role: { status: 'active' },
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
});

/** The live scope grants that reach an item in this place (the approvers' rule, P7 §4.4). */
function reaching(place: ItemPlace): Prisma.UserWhereInput {
  const grants: Prisma.UserScopeWhereInput[] = [{ scopeType: 'all_estates' }];
  if (place.estateId) grants.push({ scopeType: 'estate', scopeId: place.estateId });
  if (place.factoryId) grants.push({ scopeType: 'factory', scopeId: place.factoryId });
  if (place.warehouseId) grants.push({ scopeType: 'warehouse', scopeId: place.warehouseId });
  return {
    scopes: {
      some: { AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, { OR: grants }] },
    },
  };
}

const placed = (p: ItemPlace | null) => p !== null && Boolean(p.estateId ?? p.factoryId ?? p.warehouseId);

/** The active users a rule sends one item to. Disabled users never receive anything. */
export async function recipients(db: Database | Tx, rule: RuleRow, audience: Audience): Promise<bigint[]> {
  const scope = placed(audience.place) && audience.place ? reaching(audience.place) : {};
  let ids: bigint[] = [];
  const rr = rule.recipientRule as RecipientRule;
  if (rr === 'approvers') ids = [...(audience.approvers ?? [])];
  else if (rr === 'by_named_user' && rule.userId !== null) ids = [rule.userId];
  else if (rr === 'by_role' && rule.roleId !== null) {
    const rows = await db.user.findMany({
      where: { status: 'active', roles: { some: liveRole(rule.roleId) }, ...scope },
      select: { id: true },
    });
    ids = rows.map((r) => r.id);
  } else if (rr === 'by_scope' && audience.viewPermission) {
    const [module = '', action = ''] = audience.viewPermission.split('.');
    const rows = await db.user.findMany({
      where: {
        status: 'active',
        roles: {
          some: {
            ...liveRole(),
            role: { status: 'active', permissions: { some: { permission: { module, action } } } },
          },
        },
        ...scope,
      },
      select: { id: true },
    });
    ids = rows.map((r) => r.id);
  }
  const all = [...new Set([...ids, ...(audience.also ?? [])])];
  if (all.length === 0) return [];
  // Named and computed recipients are checked too: a disabled user hears of nothing.
  const active = await db.user.findMany({
    where: { id: { in: all }, status: 'active' },
    select: { id: true },
  });
  return active.map((u) => u.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export const DELIVERY_JOB = 'notification.deliver';

/**
 * Writes one notification per (draft, user). A row that already exists (same rule, user, link and
 * occurrence) is skipped by the unique key, so this is safe to repeat. Returns how many were new.
 * Email notifications are left pending for the delivery job, which is asked to run.
 */
export async function emit(
  db: Database,
  rule: RuleRow,
  users: readonly bigint[],
  draft: Draft,
): Promise<number> {
  if (users.length === 0) return 0;
  const email = (rule.channel as Channel) === 'email';
  const withEmail = email
    ? new Set(
        (
          await db.user.findMany({
            where: { id: { in: [...users] }, email: { not: null } },
            select: { id: true },
          })
        ).map((u) => u.id),
      )
    : new Set<bigint>();
  const { count } = await db.notification.createMany({
    data: users.map((userId) => ({
      notificationRuleId: rule.id,
      userId,
      subject: draft.subject.slice(0, 200),
      body: draft.body.slice(0, 2000),
      linkType: draft.linkType,
      linkId: draft.linkId,
      severity: draft.severity ?? rule.severity,
      generationDate: businessDateToDb(draft.occurredOn),
      deliveryState: !email ? 'not_required' : withEmail.has(userId) ? 'pending' : 'skipped',
    })),
    skipDuplicates: true,
  });
  if (count > 0 && withEmail.size > 0) await askForDelivery(db);
  return count;
}

/** One delivery run at a time; a request while one is queued or running joins it. */
export async function askForDelivery(db: Database | Tx): Promise<bigint | null> {
  if (!jobDefinition(DELIVERY_JOB)) return null;
  const { job } = await createJob(db, {
    type: DELIVERY_JOB,
    payload: {},
    dedupeKey: 'notification:email:deliver',
  });
  return job.id;
}

/**
 * After a business transaction has COMMITTED: asks for an evaluation job to run soon, rather than at its
 * next scheduled time. It never throws: if this fails, the schedule finds the item anyway.
 */
export async function requestSoon(
  deps: { readonly db: Database; readonly jobs: JobQueue; readonly logger?: Logger },
  jobType: string,
  dedupeKey: string,
): Promise<void> {
  try {
    if (!jobDefinition(jobType)) return;
    const { job, created } = await createJob(deps.db, { type: jobType, payload: {}, dedupeKey });
    if (created) await deps.jobs.dispatch(job.id);
  } catch (err) {
    deps.logger?.warn({ err, job_type: jobType }, 'could not ask for a notification run; the schedule will');
  }
}
