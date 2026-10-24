import type { z } from 'zod';

import { OPERATORS, type Condition } from '../../core/approval/conditions.js';
import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec, sum, toDecimalString } from '../../core/money/decimal.js';
import { buildLines, type PostingItem } from '../../core/posting/engine.js';
import {
  POSTABLE_SOURCES,
  postableSource,
  resolutionAvailable,
  splitResolutionKey,
  type AccountResolution,
  type PostableSource,
} from '../../core/posting/sources.js';
import { businessDateFromDb, businessDateToDb, type BusinessDate } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { duplicate, iso, versionConflict } from '../organisation/common.js';
import { readSignOff } from './accounts.service.js';
import type { CreateRuleBody, PatchRuleBody, PreviewBody, RuleOutT } from './posting-rules.schema.js';

/**
 * Posting rules (Spec P3 §27.7, P8 §5, §14; D-3.03-9, D-3.03-10). Configuration the accountant reviews:
 *
 *   - a rule names a postable source and purpose, AND-only conditions on the source's fields, a sequence,
 *     effective dates, and its lines (side, how the account resolves, which amount)
 *   - lines and conditions change only while the rule is inactive
 *   - activation needs the chart signed off, every fixed account active and postable, every resolution
 *     available, and someone other than whoever last changed the rule (the approval block)
 *   - deleted only while inactive and never used by a journal
 */

export const POSTING_RULE_AUDIT: AuditedRecord = {
  type: 'posting_rule',
  class: 'policy',
  fields: [
    'rule_code',
    'name',
    'source_type',
    'purpose',
    'conditions',
    'sequence',
    'effective_from',
    'effective_to',
    'lines',
    'is_active',
  ],
};

export const POSTING_RULE_LIST_FIELDS: ListFieldMap = {
  rule_code: { field: 'ruleCode' },
  name: { field: 'name' },
  source_type: { field: 'sourceType' },
  purpose: { field: 'purpose' },
  is_active: { field: 'isActive', convert: (v) => v === true || v === 'true' },
  sequence: { field: 'sequence' },
};

const include = {
  lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { sequence: 'asc' } },
} as const;
type Row = Prisma.PostingRuleGetPayload<{ include: typeof include }>;

export function toRuleOut(r: Row): RuleOutT {
  return {
    id: r.id.toString(),
    rule_code: r.ruleCode,
    name: r.name,
    description: r.description,
    source_type: r.sourceType,
    source_label: postableSource(r.sourceType)?.label ?? r.sourceType,
    purpose: r.purpose as RuleOutT['purpose'],
    conditions: r.conditionJson as unknown as RuleOutT['conditions'],
    sequence: r.sequence,
    is_active: r.isActive,
    effective_from: businessDateFromDb(r.effectiveFrom),
    effective_to: r.effectiveTo ? businessDateFromDb(r.effectiveTo) : null,
    approved_at: iso(r.approvedAt),
    approved_by: r.approvedBy?.toString() ?? null,
    lines: r.lines.map((l) => ({
      sequence: l.sequence,
      side: l.side as 'debit' | 'credit',
      account_resolution: l.accountResolution as AccountResolution,
      account_id: l.accountId?.toString() ?? null,
      account_code: l.account?.code ?? null,
      account_name: l.account?.name ?? null,
      resolution_key: l.resolutionKey,
      amount_source: l.amountSource,
      narration: l.narration,
      resolution_available: resolutionAvailable(l.accountResolution as AccountResolution),
    })),
    version: r.version,
    created_at: r.createdAt.toISOString(),
    updated_at: iso(r.updatedAt),
  };
}

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const fail = (
  code: 'INVALID_TRANSITION' | 'SELF_APPROVAL_FORBIDDEN' | 'CHART_NOT_SIGNED_OFF',
  message: string,
) => new AppError(code, message, [{ code, message }]);

type Lines = NonNullable<z.infer<typeof PatchRuleBody>['lines']>;
type Conditions = NonNullable<z.infer<typeof PatchRuleBody>['conditions']>;

/** The rule's shape against its source (D-3.03-3, D-3.03-4): purposes, amounts, keys, conditions. */
async function checkShape(
  tx: Tx,
  source: PostableSource | undefined,
  purpose: string,
  conditions: Conditions,
  lines: Lines,
): Promise<void> {
  const problems: ErrorDetail[] = [];
  if (!source)
    throw Errors.validation([invalid('source_type', 'Not a postable source (GET /posting-rules/sources).')]);
  if (!source.purposes.includes(purpose as never)) {
    problems.push(invalid('purpose', `${source.label} posts for ${source.purposes.join(', ')}.`));
  }
  const fields = new Set(source.conditionFields.map((f) => f.name));
  for (const [i, c] of conditions.entries()) {
    const at = `conditions[${String(i)}]`;
    if (!fields.has(c.field))
      problems.push(invalid(`${at}.field`, `${source.label} has no field ${c.field}.`));
    const list = c.operator === 'in' || c.operator === 'not_in' || c.operator === 'between';
    const flag = c.operator === 'is_true' || c.operator === 'is_false';
    if (
      list !== Array.isArray(c.value) ||
      (flag && c.value !== null) ||
      (!flag && !list && typeof c.value !== 'string')
    ) {
      problems.push(invalid(`${at}.value`, `Not a value for ${c.operator} (${OPERATORS.join(', ')}).`));
    }
  }
  if (!lines.some((l) => l.side === 'debit') || !lines.some((l) => l.side === 'credit')) {
    problems.push(invalid('lines', 'A rule has at least one debit and one credit line.'));
  }
  const amounts = new Set(source.amounts.map((a) => a.name));
  const accountFields = new Set(source.accountFields.map((a) => a.name));
  const refs = new Set(source.refs.map((a) => a.name));
  for (const [i, l] of lines.entries()) {
    const at = `lines[${String(i)}]`;
    if (!amounts.has(l.amount_source))
      problems.push(invalid(`${at}.amount_source`, `${source.label} supplies no ${l.amount_source}.`));
    if (l.account_resolution === 'fixed') {
      if (l.account_id === undefined || l.account_id === null) {
        problems.push(invalid(`${at}.account_id`, 'A fixed line names its account.'));
      } else {
        const a = await tx.account.findUnique({
          where: { id: l.account_id },
          select: { isPostable: true, code: true },
        });
        if (!a?.isPostable)
          problems.push(invalid(`${at}.account_id`, 'Must be a postable account of the chart.'));
      }
    } else {
      const key = l.resolution_key ?? '';
      const fieldLine = l.account_resolution === 'from_account_field';
      const known = fieldLine ? accountFields : refs;
      if (!known.has(fieldLine ? key : splitResolutionKey(key).ref)) {
        problems.push(
          invalid(
            `${at}.resolution_key`,
            `${source.label} supplies ${[...known].join(', ') || 'nothing'} for ${l.account_resolution}.`,
          ),
        );
      }
      if (l.account_id !== undefined && l.account_id !== null) {
        problems.push(invalid(`${at}.account_id`, 'Only a fixed line names an account.'));
      }
    }
  }
  if (problems.length > 0) throw Errors.validation(problems);
}

const lineRows = (lines: Lines, actorId: bigint) =>
  lines.map((l, i) => ({
    side: l.side,
    accountResolution: l.account_resolution,
    accountId: l.account_resolution === 'fixed' ? (l.account_id ?? null) : null,
    resolutionKey: l.account_resolution === 'fixed' ? null : (l.resolution_key ?? null),
    amountSource: l.amount_source,
    sequence: i + 1,
    narration: l.narration ?? null,
    createdBy: actorId,
  }));

export function postingRulesService(db: Database) {
  async function orNotFound(tx: Database | Tx, id: bigint): Promise<Row> {
    const r = await tx.postingRule.findUnique({ where: { id }, include });
    if (!r) throw Errors.notFound('Posting rule not found.');
    return r;
  }
  const inactiveOnly = (r: Row) => {
    if (r.isActive) throw fail('INVALID_TRANSITION', 'An active rule does not change: deactivate it first.');
  };

  return {
    sources: () =>
      POSTABLE_SOURCES.map((s) => ({
        key: s.key,
        label: s.label,
        phase: s.phase,
        purposes: [...s.purposes],
        amounts: [...s.amounts],
        account_fields: [...s.accountFields],
        refs: [...s.refs],
        condition_fields: [...s.conditionFields],
      })),

    async list(q: ListQuery) {
      const where = toWhere(q, POSTING_RULE_LIST_FIELDS) as Prisma.PostingRuleWhereInput;
      const [rows, total] = await Promise.all([
        db.postingRule.findMany({
          where,
          include,
          orderBy: [...toOrderBy(q.sort, POSTING_RULE_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.postingRule.count({ where }),
      ]);
      return { items: rows.map(toRuleOut), total };
    },

    async get(id: bigint) {
      return toRuleOut(await orNotFound(db, id));
    },

    async create(b: z.infer<typeof CreateRuleBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const conditions = b.conditions ?? [];
        await checkShape(tx, postableSource(b.source_type), b.purpose, conditions, b.lines);
        if (b.effective_to && b.effective_to < b.effective_from) {
          throw Errors.validation([invalid('effective_to', 'Cannot be before effective_from.')]);
        }
        const r = await tx.postingRule
          .create({
            data: {
              ruleCode: b.rule_code,
              name: b.name,
              description: b.description ?? null,
              sourceType: b.source_type,
              purpose: b.purpose,
              conditionJson: conditions,
              sequence: b.sequence ?? 10,
              effectiveFrom: businessDateToDb(b.effective_from),
              effectiveTo: b.effective_to ? businessDateToDb(b.effective_to) : null,
              createdBy: actorId,
              lines: { create: lineRows(b.lines, actorId) },
            },
            select: { id: true },
          })
          .catch(duplicate('rule_code', `Rule code ${b.rule_code}`));
        const out = toRuleOut(await orNotFound(tx, r.id));
        await auditCreate(tx, POSTING_RULE_AUDIT, r.id, out, { actorId });
        await recordStatusChange(tx, POSTING_RULE_AUDIT.type, r.id, null, 'inactive', { actorId });
        return out;
      });
    },

    async update(id: bigint, expectedVersion: number, c: z.infer<typeof PatchRuleBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        if (before.version !== expectedVersion) versionConflict(before, toRuleOut(before));
        inactiveOnly(before);
        const old = toRuleOut(before);
        const sourceType = c.source_type ?? before.sourceType;
        const purpose = c.purpose ?? before.purpose;
        const conditions = c.conditions ?? old.conditions;
        const lines: Lines =
          c.lines ??
          old.lines.map((l) => ({
            side: l.side,
            account_resolution: l.account_resolution,
            account_id: l.account_id === null ? null : BigInt(l.account_id),
            resolution_key: l.resolution_key,
            amount_source: l.amount_source,
            narration: l.narration,
          }));
        await checkShape(tx, postableSource(sourceType), purpose, conditions, lines);
        const from = c.effective_from ?? old.effective_from;
        const to = c.effective_to !== undefined ? c.effective_to : old.effective_to;
        if (to && to < from)
          throw Errors.validation([invalid('effective_to', 'Cannot be before effective_from.')]);
        const { count } = await tx.postingRule
          .updateMany({
            where: { id, version: expectedVersion },
            data: {
              ...(c.rule_code !== undefined ? { ruleCode: c.rule_code } : {}),
              ...(c.name !== undefined ? { name: c.name } : {}),
              ...(c.description !== undefined ? { description: c.description } : {}),
              sourceType,
              purpose,
              conditionJson: conditions,
              ...(c.sequence !== undefined ? { sequence: c.sequence } : {}),
              effectiveFrom: businessDateToDb(from as BusinessDate),
              effectiveTo: to ? businessDateToDb(to as BusinessDate) : null,
              version: { increment: 1 },
              updatedAt: new Date(),
              updatedBy: actorId,
            },
          })
          .catch(duplicate('rule_code', `Rule code ${c.rule_code ?? ''}`));
        if (count !== 1) versionConflict(before, old);
        if (c.lines !== undefined) {
          await tx.postingRuleLine.deleteMany({ where: { postingRuleId: id } });
          await tx.postingRuleLine.createMany({
            data: lineRows(c.lines, actorId).map((l) => ({ ...l, postingRuleId: id })),
          });
        }
        const after = toRuleOut(await orNotFound(tx, id));
        await auditUpdate(tx, POSTING_RULE_AUDIT, id, old, after, { actorId });
        return after;
      });
    },

    async activate(id: bigint, expectedVersion: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        if (before.version !== expectedVersion) versionConflict(before, toRuleOut(before));
        if (before.isActive) return toRuleOut(before);
        if ((await readSignOff(tx)) === null) {
          throw fail(
            'CHART_NOT_SIGNED_OFF',
            'Posting rules stay inactive until the accountant signs off the chart (P3 §31.3).',
          );
        }
        if ((before.updatedBy ?? before.createdBy) === actorId) {
          throw fail(
            'SELF_APPROVAL_FORBIDDEN',
            'Someone other than whoever last changed this rule activates it.',
          );
        }
        const problems: ErrorDetail[] = [];
        for (const l of before.lines) {
          const at = `lines[${String(l.sequence - 1)}]`;
          if (!resolutionAvailable(l.accountResolution as AccountResolution)) {
            problems.push(
              invalid(
                `${at}.account_resolution`,
                `${l.accountResolution} is not available yet: it arrives with ${postableSource(before.sourceType)?.phase ?? 'its phase'}.`,
              ),
            );
          }
          if (l.accountId !== null) {
            const a = await tx.account.findUnique({
              where: { id: l.accountId },
              select: { code: true, status: true, isPostable: true },
            });
            if (a?.status !== 'active' || !a.isPostable) {
              problems.push(
                invalid(`${at}.account_id`, `${a?.code ?? 'The account'} is not an active postable account.`),
              );
            }
          }
        }
        if (problems.length > 0) throw Errors.validation(problems);
        const now = new Date();
        await tx.postingRule.update({
          where: { id },
          data: {
            isActive: true,
            approvedAt: now,
            approvedBy: actorId,
            version: { increment: 1 },
            updatedAt: now,
          },
        });
        const after = toRuleOut(await orNotFound(tx, id));
        await auditUpdate(tx, POSTING_RULE_AUDIT, id, toRuleOut(before), after, { actorId });
        await recordStatusChange(tx, POSTING_RULE_AUDIT.type, id, 'inactive', 'active', { actorId });
        return after;
      });
    },

    async deactivate(id: bigint, expectedVersion: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        if (before.version !== expectedVersion) versionConflict(before, toRuleOut(before));
        if (!before.isActive) return toRuleOut(before);
        await tx.postingRule.update({
          where: { id },
          data: { isActive: false, version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId },
        });
        const after = toRuleOut(await orNotFound(tx, id));
        await auditUpdate(tx, POSTING_RULE_AUDIT, id, toRuleOut(before), after, { actorId });
        await recordStatusChange(tx, POSTING_RULE_AUDIT.type, id, 'active', 'inactive', { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const r = await orNotFound(tx, id);
        inactiveOnly(r);
        if ((await tx.journal.count({ where: { postingRuleId: id } })) > 0) {
          throw new AppError('REFERENCED_RECORD', 'Journals were posted by this rule, so it is kept.', [
            { code: 'REFERENCED_RECORD', message: 'Leave it inactive instead.' },
          ]);
        }
        await tx.postingRule.delete({ where: { id } });
        await auditDelete(tx, POSTING_RULE_AUDIT, id, toRuleOut(r), { actorId });
      });
    },

    /** The journal the rule would write for sample amounts (no writes, any state, D-3.03-9). */
    async preview(id: bigint, b: z.infer<typeof PreviewBody>) {
      return withTransaction(db, async (tx) => {
        const r = await orNotFound(tx, id);
        const amounts: Record<string, string | PostingItem[]> = {};
        for (const [k, v] of Object.entries(b.amounts)) {
          amounts[k] = Array.isArray(v)
            ? v.map((item) => ({
                amount: item.amount.toFixed(),
                ...(item.accounts ? { accounts: item.accounts } : {}),
                ...(item.refs ? { refs: item.refs } : {}),
                ...(item.cost_centre_id !== undefined ? { costCentreId: item.cost_centre_id } : {}),
                ...(item.estate_id !== undefined ? { estateId: item.estate_id } : {}),
              }))
            : v.toFixed();
        }
        const built = await buildLines(
          tx,
          r.lines,
          {
            amounts,
            ...(b.accounts ? { accounts: b.accounts } : {}),
            dimensions: { costCentreId: b.cost_centre_id ?? null, estateId: b.estate_id ?? null },
          },
          false,
        );
        const ids = [...new Set(built.flatMap((l) => (l.accountId === null ? [] : [l.accountId])))];
        const accounts = new Map(
          (
            await tx.account.findMany({
              where: { id: { in: ids } },
              select: { id: true, code: true, name: true },
            })
          ).map((a) => [a.id, a]),
        );
        const total = (side: 'debit' | 'credit') =>
          sum(built.filter((l) => l.side === side).map((l) => l.amount));
        const debit = total('debit');
        const credit = total('credit');
        return {
          lines: built.map((l) => ({
            rule_line: l.ruleLine,
            side: l.side,
            account_id: l.accountId?.toString() ?? null,
            account_code: l.accountId === null ? null : (accounts.get(l.accountId)?.code ?? null),
            account_name: l.accountId === null ? null : (accounts.get(l.accountId)?.name ?? null),
            amount: toDecimalString(l.amount, 'money'),
            cost_centre_id: l.costCentreId?.toString() ?? null,
            estate_id: l.estateId?.toString() ?? null,
          })),
          total_debit: toDecimalString(debit, 'money'),
          total_credit: toDecimalString(credit, 'money'),
          balanced: debit.equals(credit) && debit.greaterThan(dec('0')),
          unresolved: built.filter((l) => l.accountId === null).length,
        };
      });
    },
  };
}

export type { Condition };
