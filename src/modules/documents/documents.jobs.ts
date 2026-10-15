import { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { activeRules, emit, recipients, type ItemPlace, type RuleRow } from '../../core/notify/notify.js';
import { runUnscoped } from '../../core/scope/scope.js';
import { addDays, businessDateFromDb, businessDateToDb, diffDays, todayIn } from '../../core/time/dates.js';
import { documentOwner } from './documents.owners.js';

/**
 * Document expiry alerts (P1.16; P3 §28.4 "expiry is what drives the licence and document expiry
 * alerts"). Nightly: every current, active document whose expiry date falls within a rule's lead_days,
 * or has passed, is reported to the rule's recipients who may see its owner (the owner's view
 * permission and scope, as for the document itself, P1.12).
 *
 * Once per document version: the occurrence is the expiry date, so the job finds the same licence every
 * night and reports it once. A renewal is a new version, with its own expiry, and its own alert.
 */

export const DEFAULT_LEAD_DAYS = 30;
export const DOCUMENT_EXPIRY_JOB = 'document.notify_expiry';

/** condition_json: { "document_type_codes": ["TRADE_LICENCE", …] } limits a rule to those types. */
function typeCodes(condition: unknown): string[] | null {
  if (typeof condition !== 'object' || condition === null) return null;
  const codes = (condition as Record<string, unknown>).document_type_codes;
  return Array.isArray(codes) && codes.length > 0 ? codes.map(String) : null;
}

export function documentExpiryJob(db: Database, timezone: string) {
  async function runRule(rule: RuleRow, signal: AbortSignal) {
    const today = todayIn(timezone);
    const horizon = addDays(today, rule.leadDays ?? DEFAULT_LEAD_DAYS);
    const codes = typeCodes(rule.conditionJson);
    let after = 0n;
    let found = 0;
    let created = 0;
    for (;;) {
      signal.throwIfAborted();
      const docs = await db.documentFile.findMany({
        where: {
          id: { gt: after },
          isCurrent: true,
          status: 'active',
          expiryDate: { not: null, lte: businessDateToDb(horizon) },
          ...(codes ? { documentType: { code: { in: codes } } } : {}),
        },
        include: { documentType: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take: 200,
      });
      if (docs.length === 0) break;
      after = docs[docs.length - 1]?.id ?? after;
      const byType = new Map<string, bigint[]>();
      for (const d of docs) byType.set(d.ownerType, [...(byType.get(d.ownerType) ?? []), d.ownerId]);
      const labels = new Map<string, Map<bigint, string>>();
      const places = new Map<string, Map<bigint, ItemPlace>>();
      for (const [type, ids] of byType) {
        const owner = documentOwner(type);
        if (!owner) continue;
        labels.set(type, await owner.find(db, ids));
        places.set(type, await owner.places(db, ids));
      }
      for (const d of docs) {
        const owner = documentOwner(d.ownerType);
        const ownerLabel = labels.get(d.ownerType)?.get(d.ownerId);
        if (!owner || !ownerLabel || !d.expiryDate) continue; // an owner that no longer exists
        found += 1;
        const expiry = businessDateFromDb(d.expiryDate);
        const days = diffDays(today, expiry);
        const what = d.title ?? d.documentType.name;
        const users = await recipients(db, rule, {
          place: places.get(d.ownerType)?.get(d.ownerId) ?? null,
          viewPermission: `${owner.module}.view`,
        });
        created += await emit(db, rule, users, {
          subject:
            days < 0
              ? `${what} has expired: ${ownerLabel}`
              : `${what} expires ${days === 0 ? 'today' : `in ${String(days)} day${days === 1 ? '' : 's'}`}: ${ownerLabel}`,
          body:
            `${what} (${d.documentType.name}, version ${String(d.version)}) of the ${owner.label} ${ownerLabel} ` +
            `${days < 0 ? 'expired' : 'expires'} on ${expiry}. Upload the renewed document as a new version ` +
            'to keep the record current.',
          linkType: 'document_file',
          linkId: d.id,
          occurredOn: expiry,
          ...(days < 0 ? { severity: 'critical' as const } : {}),
        });
      }
    }
    return { found, created };
  }

  return defineJob({
    type: DOCUMENT_EXPIRY_JOB,
    label: 'Tell people about expiring documents',
    payload: z.object({}),
    async run(ctx) {
      // Every owner's documents, whatever estate: the recipients' scope is applied per document.
      return runUnscoped('document expiry alerts cover every owner', async () => {
        const rules = await activeRules(db, 'document_expiry');
        const result: Record<string, { found: number; created: number }> = {};
        for (const rule of rules) result[rule.code] = await runRule(rule, ctx.signal);
        return { result: { rules: result } };
      });
    },
  });
}

export const DOCUMENT_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'document.notify_expiry',
    description: 'Tells people about licences and other documents that expire soon or have expired.',
    cron: '0 6 * * *',
    jobType: DOCUMENT_EXPIRY_JOB,
  },
];
