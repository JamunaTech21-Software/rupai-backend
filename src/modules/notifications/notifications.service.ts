import type { z } from 'zod';

import { auditCreate, auditUpdate, type AuditedRecord } from '../../core/audit/audit.js';
import { toPaging } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { wholeSecond } from '../../core/jobs/store.js';
import {
  TRIGGER_BY_KEY,
  TRIGGERS,
  type Channel,
  type RecipientRule,
  type Severity,
  type TriggerDefinition,
  type TriggerType,
} from '../../core/notify/triggers.js';
import { businessDateFromDb } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { duplicate, iso } from '../organisation/common.js';
import type {
  CreateRuleBody,
  NotificationOut,
  PatchRuleBody,
  RuleOut,
  SummaryOut,
  TriggerOut,
} from './notifications.schema.js';

/**
 * Notifications and their rules (Spec P3 §28.5; P4 §14 /notifications, any user; P6 §7.1 the
 * administrator's notification administration).
 *
 * NOTIFICATIONS are personal: each user sees, reads and dismisses only their own (P6 §5.4 baseline). Any
 * other id is 404. Reading and dismissing are not audited: they change nobody's data but the reader's.
 *
 * RULES are master data (notification.*), audited. The trigger types are the system's; a rule picks one
 * and says who, how far ahead and how. A rule is never deleted (notifications refer to it): deactivate it.
 */

type NotificationOutT = z.infer<typeof NotificationOut>;
type RuleOutT = z.infer<typeof RuleOut>;

const RULE_AUDIT: AuditedRecord = {
  type: 'notification_rule',
  class: 'master',
  fields: [
    'code',
    'name',
    'description',
    'trigger_type',
    'condition',
    'lead_days',
    'recipient_rule',
    'role_id',
    'user_id',
    'channel',
    'severity',
    'is_active',
  ],
};

/** Where the web app shows what a notification is about (P5 §13 routes). */
export function linkRoute(type: string, id: bigint): string {
  if (type === 'approval_request') return `/approvals/${id.toString()}`;
  if (type.startsWith('approval_queue.'))
    return `/approvals?document_type=${type.slice('approval_queue.'.length)}`;
  if (type === 'document_file') return '/documents/expiring';
  if (type === 'access_review') return '/admin/access-review';
  if (type === 'job') return `/jobs/${id.toString()}`;
  return '/notifications';
}

const notificationInclude = {
  rule: { select: { code: true, name: true, triggerType: true } },
} satisfies Prisma.NotificationInclude;
type NotificationRow = Prisma.NotificationGetPayload<{ include: typeof notificationInclude }>;

export function toNotificationOut(n: NotificationRow): NotificationOutT {
  return {
    id: n.id.toString(),
    subject: n.subject,
    body: n.body,
    severity: n.severity as Severity,
    link: { type: n.linkType, id: n.linkId.toString(), route: linkRoute(n.linkType, n.linkId) },
    rule: { code: n.rule.code, name: n.rule.name, trigger_type: n.rule.triggerType as TriggerType },
    occurred_on: businessDateFromDb(n.generationDate),
    created_at: n.createdAt.toISOString(),
    is_read: n.readAt !== null,
    read_at: iso(n.readAt),
    dismissed_at: iso(n.dismissedAt),
    email: {
      state: n.deliveryState as NotificationOutT['email']['state'],
      delivered_at: iso(n.deliveredAt),
      error: n.deliveryError,
    },
  };
}

const flag = (q: ListQuery, field: string): boolean | undefined => {
  const f = q.filters.find((x) => x.field === field);
  return f === undefined ? undefined : f.value === true || f.value === 'true';
};
const values = (q: ListQuery, field: string) =>
  q.filters
    .filter((f) => f.field === field)
    .flatMap((f) => (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]));

export function notificationsService(db: Database) {
  async function own(tx: Database | Tx, id: bigint, userId: bigint) {
    const n = await tx.notification.findFirst({ where: { id, userId }, include: notificationInclude });
    // Someone else's notification does not exist, as far as the caller can tell (P4 §4.3).
    if (!n) throw Errors.notFound('No such notification.');
    return n;
  }

  return {
    /** The caller's notifications, newest first. Dismissed ones only when asked for. */
    async list(userId: bigint, q: ListQuery): Promise<{ items: NotificationOutT[]; total: number }> {
      const read = flag(q, 'is_read');
      const dismissed = flag(q, 'is_dismissed') ?? false;
      const severities = values(q, 'severity');
      const triggers = values(q, 'trigger_type');
      const where: Prisma.NotificationWhereInput = {
        userId,
        dismissedAt: dismissed ? { not: null } : null,
        ...(read === undefined ? {} : { readAt: read ? { not: null } : null }),
        ...(severities.length > 0 ? { severity: { in: severities } } : {}),
        ...(triggers.length > 0 ? { rule: { triggerType: { in: triggers } } } : {}),
      };
      const [rows, total] = await Promise.all([
        db.notification.findMany({
          where,
          include: notificationInclude,
          orderBy: { id: 'desc' },
          ...toPaging(q),
        }),
        db.notification.count({ where }),
      ]);
      return { items: rows.map(toNotificationOut), total };
    },

    async summary(userId: bigint): Promise<z.infer<typeof SummaryOut>> {
      const open = { userId, readAt: null, dismissedAt: null };
      const [unread, critical, latest] = await Promise.all([
        db.notification.count({ where: open }),
        db.notification.count({ where: { ...open, severity: 'critical' } }),
        db.notification.findFirst({
          where: { userId, dismissedAt: null },
          orderBy: { id: 'desc' },
          select: { createdAt: true },
        }),
      ]);
      return { unread, unread_critical: critical, latest_at: iso(latest?.createdAt ?? null) };
    },

    async get(id: bigint, userId: bigint) {
      return toNotificationOut(await own(db, id, userId));
    },

    /** read / unread / dismiss / restore. Idempotent: doing it twice changes nothing more. */
    async mark(id: bigint, userId: bigint, action: 'read' | 'unread' | 'dismiss' | 'restore') {
      const n = await own(db, id, userId);
      const now = wholeSecond();
      const data: Prisma.NotificationUpdateManyMutationInput =
        action === 'read'
          ? { readAt: n.readAt ?? now }
          : action === 'unread'
            ? { readAt: null }
            : action === 'dismiss'
              ? // Dismissing something unread also reads it: it should not keep the bell lit.
                { dismissedAt: n.dismissedAt ?? now, readAt: n.readAt ?? now }
              : { dismissedAt: null };
      await db.notification.updateMany({ where: { id, userId }, data });
      return toNotificationOut(await own(db, id, userId));
    },

    async readAll(userId: bigint, upToId: bigint | undefined) {
      const { count } = await db.notification.updateMany({
        where: { userId, readAt: null, dismissedAt: null, ...(upToId ? { id: { lte: upToId } } : {}) },
        data: { readAt: wholeSecond() },
      });
      return { marked_read: count };
    },
  };
}

// ---- rules ------------------------------------------------------------------------------------------

export function toTriggerOut(t: TriggerDefinition): z.infer<typeof TriggerOut> {
  return {
    key: t.key,
    label: t.label,
    description: t.description,
    recipient_rules: [...t.recipientRules],
    uses_lead_days: t.usesLeadDays,
    evaluated: t.evaluated,
    arrives_with: t.arrivesWith,
  };
}

const ruleInclude = {
  role: { select: { id: true, code: true, name: true } },
  user: { select: { id: true, username: true } },
} satisfies Prisma.NotificationRuleInclude;
type RuleRow = Prisma.NotificationRuleGetPayload<{ include: typeof ruleInclude }>;

const asCondition = (v: Prisma.JsonValue): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 ? v : null;

export function toRuleOut(r: RuleRow): RuleOutT {
  const trigger = TRIGGER_BY_KEY.get(r.triggerType);
  if (!trigger) throw new Error(`notification rule ${r.code} has an unknown trigger ${r.triggerType}`);
  return {
    id: r.id.toString(),
    code: r.code,
    name: r.name,
    description: r.description,
    trigger_type: trigger.key,
    trigger: toTriggerOut(trigger),
    condition: asCondition(r.conditionJson),
    lead_days: r.leadDays,
    recipient_rule: r.recipientRule as RecipientRule,
    role: r.role ? { id: r.role.id.toString(), code: r.role.code, name: r.role.name } : null,
    user: r.user ? { id: r.user.id.toString(), username: r.user.username } : null,
    channel: r.channel as Channel,
    severity: r.severity as Severity,
    is_active: r.isActive,
    version: r.version,
    created_at: r.createdAt.toISOString(),
    updated_at: iso(r.updatedAt),
  };
}

const auditOf = (r: RuleOutT) => ({
  code: r.code,
  name: r.name,
  description: r.description,
  trigger_type: r.trigger_type,
  condition: r.condition,
  lead_days: r.lead_days,
  recipient_rule: r.recipient_rule,
  role_id: r.role?.id ?? null,
  user_id: r.user?.id ?? null,
  channel: r.channel,
  severity: r.severity,
  is_active: r.is_active,
});

interface RuleValues {
  readonly triggerType: TriggerType;
  readonly condition: z.infer<typeof PatchRuleBody>['condition'];
  readonly leadDays: number | null;
  readonly recipientRule: RecipientRule;
  readonly roleId: bigint | null;
  readonly userId: bigint | null;
}

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});

/** What the database's checks hold, said in the client's terms, plus what only the application knows. */
async function checkRule(tx: Tx, v: RuleValues): Promise<void> {
  const trigger = TRIGGER_BY_KEY.get(v.triggerType);
  const problems: ErrorDetail[] = [];
  if (!trigger) throw new Error(`unknown trigger ${v.triggerType}`);
  if (!trigger.recipientRules.includes(v.recipientRule)) {
    problems.push(
      invalid('recipient_rule', `${trigger.label} goes to: ${trigger.recipientRules.join(', ')}.`),
    );
  }
  if (v.recipientRule === 'by_role') {
    if (v.roleId === null) problems.push(invalid('role_id', 'Choose the role whose holders are told.'));
    else if ((await tx.role.count({ where: { id: v.roleId, status: 'active' } })) !== 1)
      problems.push(invalid('role_id', 'No such active role.'));
  } else if (v.roleId !== null) problems.push(invalid('role_id', 'Only a by_role rule names a role.'));
  if (v.recipientRule === 'by_named_user') {
    if (v.userId === null) problems.push(invalid('user_id', 'Choose the user who is told.'));
    else if ((await tx.user.count({ where: { id: v.userId, status: 'active' } })) !== 1)
      problems.push(invalid('user_id', 'No such active user.'));
  } else if (v.userId !== null) problems.push(invalid('user_id', 'Only a by_named_user rule names a user.'));
  if (!trigger.usesLeadDays && v.leadDays !== null)
    problems.push(invalid('lead_days', `${trigger.label} has no date to look ahead to.`));
  const c = v.condition ?? null;
  if (c?.document_type_codes !== undefined) {
    if (v.triggerType !== 'document_expiry')
      problems.push(
        invalid('condition.document_type_codes', 'Only document expiry rules limit document types.'),
      );
    else {
      const codes = c.document_type_codes.map((x) => x.toUpperCase());
      const found = await tx.documentType.findMany({
        where: { code: { in: codes } },
        select: { code: true },
      });
      const missing = codes.filter((x) => !found.some((f) => f.code === x));
      if (missing.length > 0)
        problems.push(
          invalid('condition.document_type_codes', `No such document type: ${missing.join(', ')}.`),
        );
    }
  }
  if (c?.notify_next_step_approvers !== undefined && v.triggerType !== 'approval_unresolved')
    problems.push(
      invalid('condition.notify_next_step_approvers', 'Only approval_unresolved rules use this.'),
    );
  if (problems.length > 0) throw Errors.validation(problems);
}

const conditionJson = (c: z.infer<typeof PatchRuleBody>['condition']) =>
  c
    ? ({
        ...(c.document_type_codes
          ? { document_type_codes: c.document_type_codes.map((x) => x.toUpperCase()) }
          : {}),
        ...(c.notify_next_step_approvers !== undefined
          ? { notify_next_step_approvers: c.notify_next_step_approvers }
          : {}),
      } as Prisma.InputJsonObject)
    : undefined;

export function rulesService(db: Database) {
  async function orNotFound(tx: Database | Tx, id: bigint) {
    const r = await tx.notificationRule.findUnique({ where: { id }, include: ruleInclude });
    if (!r) throw Errors.notFound('No such notification rule.');
    return r;
  }

  return {
    triggers: () => TRIGGERS.map(toTriggerOut),

    async list(q: ListQuery) {
      const triggers = values(q, 'trigger_type');
      const active = flag(q, 'is_active');
      const where: Prisma.NotificationRuleWhereInput = {
        ...(triggers.length > 0 ? { triggerType: { in: triggers } } : {}),
        ...(active === undefined ? {} : { isActive: active }),
      };
      const [rows, total] = await Promise.all([
        db.notificationRule.findMany({
          where,
          include: ruleInclude,
          orderBy: [{ triggerType: 'asc' }, { code: 'asc' }],
          ...toPaging(q),
        }),
        db.notificationRule.count({ where }),
      ]);
      return { items: rows.map(toRuleOut), total };
    },

    async get(id: bigint) {
      return toRuleOut(await orNotFound(db, id));
    },

    async create(b: z.infer<typeof CreateRuleBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const roleId = b.role_id;
        const userId = b.user_id;
        await checkRule(tx, {
          triggerType: b.trigger_type,
          condition: b.condition,
          leadDays: b.lead_days,
          recipientRule: b.recipient_rule,
          roleId,
          userId,
        });
        const condition = conditionJson(b.condition);
        try {
          const r = await tx.notificationRule.create({
            data: {
              code: b.code,
              name: b.name,
              description: b.description,
              triggerType: b.trigger_type,
              ...(condition ? { conditionJson: condition } : {}),
              leadDays: b.lead_days,
              recipientRule: b.recipient_rule,
              roleId,
              userId,
              channel: b.channel,
              severity: b.severity,
              isActive: b.is_active,
              createdBy: actorId,
            },
            include: ruleInclude,
          });
          const out = toRuleOut(r);
          await auditCreate(tx, RULE_AUDIT, r.id, auditOf(out), { actorId });
          return out;
        } catch (err) {
          return duplicate('code', 'This notification rule code')(err);
        }
      });
    },

    async update(id: bigint, expectedVersion: number, b: z.infer<typeof PatchRuleBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        const recipientRule = b.recipient_rule ?? (before.recipientRule as RecipientRule);
        // Changing who receives it clears the role or user that no longer applies, unless one is given.
        const roleId =
          b.role_id !== undefined ? b.role_id : recipientRule === 'by_role' ? before.roleId : null;
        const userId =
          b.user_id !== undefined ? b.user_id : recipientRule === 'by_named_user' ? before.userId : null;
        const condition =
          b.condition !== undefined
            ? b.condition
            : (asCondition(before.conditionJson) as RuleValues['condition']);
        const leadDays = b.lead_days !== undefined ? b.lead_days : before.leadDays;
        await checkRule(tx, {
          triggerType: before.triggerType as TriggerType,
          condition,
          leadDays,
          recipientRule,
          roleId,
          userId,
        });
        const { count } = await tx.notificationRule.updateMany({
          where: { id, version: expectedVersion },
          data: {
            ...(b.name !== undefined ? { name: b.name } : {}),
            ...(b.description !== undefined ? { description: b.description } : {}),
            ...(b.condition !== undefined ? { conditionJson: conditionJson(b.condition) ?? {} } : {}),
            leadDays,
            recipientRule,
            roleId,
            userId,
            ...(b.channel !== undefined ? { channel: b.channel } : {}),
            ...(b.severity !== undefined ? { severity: b.severity } : {}),
            ...(b.is_active !== undefined ? { isActive: b.is_active } : {}),
            version: { increment: 1 },
            updatedAt: new Date(),
            updatedBy: actorId,
          },
        });
        if (count !== 1)
          throw Errors.versionConflict({ version: before.version, resource: toRuleOut(before) });
        const after = toRuleOut(await orNotFound(tx, id));
        await auditUpdate(tx, RULE_AUDIT, id, auditOf(toRuleOut(before)), auditOf(after), { actorId });
        return after;
      });
    },
  };
}
