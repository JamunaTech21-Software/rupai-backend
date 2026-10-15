import { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import type { Seeder } from '../../core/db/seed.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { wholeSecond } from '../../core/jobs/store.js';
import type { Mailer } from '../../core/mail/mailer.js';
import { DELIVERY_JOB } from '../../core/notify/notify.js';
import type { Channel, RecipientRule, Severity, TriggerType } from '../../core/notify/triggers.js';
import { BOOTSTRAP_ADMIN_ID } from '../identity/identity.seed.js';
import { ADMINISTRATOR_ROLE_CODE } from '../identity/permission-catalogue.js';
import { linkRoute } from './notifications.service.js';

/** Email delivery, retention, and the seeded rules (P1.16). */

/** Attempts per email before it is marked failed. */
export const MAX_SEND_ATTEMPTS = 3;
/** A send started longer ago than this and never finished: the process died mid-send. */
const STALE_SEND_MINUTES = 10;
/** Notifications are kept this long, then purged. */
export const RETENTION_DAYS = 180;

/**
 * Sends the email of every notification whose rule says email. Each message is claimed (pending →
 * sending) by a conditional update before it is sent, so two runs never send one twice. A run that dies
 * mid-send leaves it `sending`; the next run marks it failed rather than risk a second copy (the
 * notification is in-app regardless). A refused send is retried by later runs, up to 3 attempts.
 */
export function deliverJob(db: Database, mailer: Mailer, publicUrl: string | null) {
  return defineJob({
    type: DELIVERY_JOB,
    label: 'Send notification emails',
    payload: z.object({}),
    async run(ctx) {
      const stale = await db.notification.updateMany({
        where: {
          deliveryState: 'sending',
          deliveryStartedAt: { lt: new Date(Date.now() - STALE_SEND_MINUTES * 60_000) },
        },
        data: {
          deliveryState: 'failed',
          deliveryError: 'Interrupted while sending: it may or may not have arrived.',
        },
      });
      let sent = 0;
      let failed = 0;
      let retrying = 0;
      let skipped = 0;
      for (let after = 0n; ;) {
        ctx.signal.throwIfAborted();
        const rows = await db.notification.findMany({
          where: { deliveryState: 'pending', id: { gt: after } },
          include: { user: { select: { email: true, status: true } }, rule: { select: { name: true } } },
          orderBy: { id: 'asc' },
          take: 50,
        });
        if (rows.length === 0) break;
        for (const n of rows) {
          after = n.id;
          ctx.signal.throwIfAborted();
          if (!n.user.email || n.user.status !== 'active') {
            await db.notification.updateMany({
              where: { id: n.id, deliveryState: 'pending' },
              data: { deliveryState: 'skipped', deliveryError: 'No email address, or the user is disabled.' },
            });
            skipped += 1;
            continue;
          }
          const claimed = await db.notification.updateMany({
            where: { id: n.id, deliveryState: 'pending' },
            data: {
              deliveryState: 'sending',
              deliveryStartedAt: wholeSecond(),
              deliveryAttempts: { increment: 1 },
            },
          });
          if (claimed.count !== 1) continue; // another run has it
          const attempts = n.deliveryAttempts + 1;
          try {
            const link = publicUrl ? `\n\nOpen it: ${publicUrl}${linkRoute(n.linkType, n.linkId)}` : '';
            await mailer.send({
              to: n.user.email,
              subject: `[RupAI] ${n.subject}`,
              text:
                `${n.body}${link}\n\n` +
                `You receive this by email because the notification rule "${n.rule.name}" says so. ` +
                'It is also in your notifications in RupAI.',
            });
            await db.notification.update({
              where: { id: n.id },
              data: { deliveryState: 'sent', deliveredAt: wholeSecond(), deliveryError: null },
            });
            sent += 1;
          } catch (err) {
            const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
            const final = attempts >= MAX_SEND_ATTEMPTS;
            await db.notification.update({
              where: { id: n.id },
              data: { deliveryState: final ? 'failed' : 'pending', deliveryError: message },
            });
            if (final) failed += 1;
            else retrying += 1;
            ctx.logger.warn(
              { notification_id: n.id.toString(), attempts, err },
              'notification email refused',
            );
          }
        }
        // Ones left pending for a retry are behind the cursor: they wait for the next run.
        await ctx.progress(sent + failed + retrying + skipped);
      }
      return {
        result: { sent, failed, retry_later: retrying, skipped, interrupted_marked_failed: stale.count },
      };
    },
  });
}

export function purgeNotificationsJob(db: Database) {
  return defineJob({
    type: 'notification.purge',
    label: 'Purge old notifications',
    payload: z.object({}),
    async run(ctx) {
      let deleted = 0;
      for (;;) {
        ctx.signal.throwIfAborted();
        const n = await db.$executeRaw`
          DELETE FROM notification WHERE created_at < UTC_TIMESTAMP() - INTERVAL ${RETENTION_DAYS} DAY
          ORDER BY id LIMIT 1000`;
        deleted += n;
        await ctx.progress(deleted);
        if (n < 1000) break;
      }
      return { result: { deleted } };
    },
  });
}

export const NOTIFICATION_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'notification.deliver',
    description: 'Sends notification emails still waiting, including retries of refused ones.',
    cron: '*/10 * * * *',
    jobType: DELIVERY_JOB,
  },
  {
    name: 'notification.purge',
    description: `Removes notifications older than ${String(RETENTION_DAYS)} days.`,
    cron: '30 3 * * *',
    jobType: 'notification.purge',
  },
];

// ---- seed -------------------------------------------------------------------------------------------

interface SeedRule {
  readonly code: string;
  readonly name: string;
  readonly trigger: TriggerType;
  readonly recipients: RecipientRule;
  readonly toAdministrators?: boolean;
  readonly leadDays?: number;
  readonly channel: Channel;
  readonly severity: Severity;
}

/** P3 Table 31.2: "Active, with conservative defaults". Email only for the administrators' few. */
export const SEED_RULES: readonly SeedRule[] = [
  {
    code: 'APPROVAL_PENDING',
    name: 'Approval waiting for you',
    trigger: 'approval_pending',
    recipients: 'approvers',
    channel: 'in_app',
    severity: 'info',
  },
  {
    code: 'APPROVAL_UNRESOLVED',
    name: 'Approval nobody can act on',
    trigger: 'approval_unresolved',
    recipients: 'by_role',
    toAdministrators: true,
    channel: 'email',
    severity: 'warning',
  },
  {
    code: 'DOCUMENT_EXPIRY',
    name: 'Document expiring within 30 days',
    trigger: 'document_expiry',
    recipients: 'by_scope',
    leadDays: 30,
    channel: 'in_app',
    severity: 'warning',
  },
  {
    code: 'ACCESS_REVIEW',
    name: 'Access review findings',
    trigger: 'access_review',
    recipients: 'by_role',
    toAdministrators: true,
    channel: 'email',
    severity: 'warning',
  },
  {
    code: 'BUDGET_THRESHOLD',
    name: 'Budget threshold reached',
    trigger: 'budget_threshold',
    recipients: 'by_scope',
    channel: 'in_app',
    severity: 'warning',
  },
  {
    code: 'PAYMENT_DUE',
    name: 'Payment due within 7 days',
    trigger: 'payment_due',
    recipients: 'by_scope',
    leadDays: 7,
    channel: 'in_app',
    severity: 'warning',
  },
  {
    code: 'ABNORMAL_YIELD',
    name: 'Abnormal yield',
    trigger: 'abnormal_yield',
    recipients: 'by_scope',
    channel: 'in_app',
    severity: 'info',
  },
  {
    code: 'LOW_STOCK',
    name: 'Stock at reorder level',
    trigger: 'low_stock',
    recipients: 'by_scope',
    channel: 'in_app',
    severity: 'warning',
  },
  {
    code: 'CONTRACT_EXPIRY',
    name: 'Contract ending within 30 days',
    trigger: 'contract_expiry',
    recipients: 'by_scope',
    leadDays: 30,
    channel: 'in_app',
    severity: 'warning',
  },
  {
    code: 'LEASE_DUE',
    name: 'Lease payment due within 15 days',
    trigger: 'lease_due',
    recipients: 'by_scope',
    leadDays: 15,
    channel: 'in_app',
    severity: 'warning',
  },
];

/** Insert-only by code: the client's edits are never overwritten (as number formats, P1.11). */
export const notificationRuleSeeder: Seeder = {
  name: 'notifications: one rule per trigger, conservative defaults',
  async run(tx) {
    const admin = await tx.role.findUnique({
      where: { code: ADMINISTRATOR_ROLE_CODE },
      select: { id: true },
    });
    let inserted = 0;
    for (const r of SEED_RULES) {
      if (await tx.notificationRule.findUnique({ where: { code: r.code }, select: { id: true } })) continue;
      if (r.toAdministrators && !admin) throw new Error('the Administrator role must be seeded first');
      await tx.notificationRule.create({
        data: {
          code: r.code,
          name: r.name,
          triggerType: r.trigger,
          leadDays: r.leadDays ?? null,
          recipientRule: r.recipients,
          roleId: r.toAdministrators ? (admin?.id ?? null) : null,
          channel: r.channel,
          severity: r.severity,
          isActive: true,
          createdBy: BOOTSTRAP_ADMIN_ID,
        },
      });
      inserted += 1;
    }
    return { inserted, updated: 0 };
  },
};
