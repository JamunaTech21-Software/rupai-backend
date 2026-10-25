import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ErrorCode } from '../../core/errors/codes.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { SETTING_AUDIT } from '../system/system.service.js';
import type { Account, Prisma } from '../../generated/prisma/client.js';
import { duplicate, idIn, idOut, inUse, iso, versionConflict } from '../organisation/common.js';
import {
  MAX_ACCOUNT_LEVEL,
  normalBalanceOf,
  oppositeBalance,
  pathOf,
  shapeErrors,
  subtreeHeight,
  type AccountShape,
  type AccountType,
  type NormalBalance,
} from './chart.js';
import type {
  AccountNode,
  AccountOutT,
  CreateAccountBody,
  PatchAccountBody,
  SignOff,
  SignOffOutT,
  Status,
} from './accounts.schema.js';
import type { z } from 'zod';

/**
 * The chart of accounts (Spec P3 §27.1, P8 §2–§4; decisions D-3.01-1 to D-3.01-11).
 *
 *   - One tree per account type, at most four levels; a child has its parent's type. Only leaves are
 *     postable: a group is never postable, and nothing is added under a postable account. level and
 *     path are maintained here, on every save, for the whole moved subtree.
 *   - Stability (P8 §2.5): an account that is referenced (ACCOUNT_REFERENCES) or has postings
 *     (ACCOUNT_POSTINGS) is never deleted, and its type and postability never change; one with postings
 *     also keeps its parent and code. System accounts (system_key) are never deleted, deactivated or re-typed.
 *   - The interlock (P3 §31.3, D-3.01-9): the seed is inactive, and no account becomes active until
 *     POST /accounts/activate-chart records the accountant's sign-off.
 *   - Structural changes lock the account rows they depend on (the parent, the node), so two requests
 *     cannot together give a postable account a child.
 *   - Organisation tier: no data scope (P4 §4.2).
 */

/** The system_setting holding the accountant's sign-off. Written only here (system.service reserves it). */
export const SIGN_OFF_SETTING = 'accounting.chart_sign_off';

export const ACCOUNT_AUDIT: AuditedRecord = {
  type: 'account',
  class: 'master',
  fields: [
    'code',
    'name',
    'parent_id',
    'account_type',
    'account_subtype',
    'normal_balance',
    'is_postable',
    'is_control_account',
    'control_subledger',
    'is_bank_or_cash',
    'currency_id',
    'requires_cost_centre',
    'requires_estate',
    'is_clearing',
    'status',
  ],
};

export const ACCOUNT_LIST_FIELDS: ListFieldMap = {
  code: { field: 'code' },
  name: { field: 'name' },
  status: { field: 'status' },
  account_type: { field: 'accountType' },
  account_subtype: { field: 'accountSubtype' },
  is_postable: { field: 'isPostable', convert: (v) => v === true || v === 'true' },
  is_control_account: { field: 'isControlAccount', convert: (v) => v === true || v === 'true' },
  is_bank_or_cash: { field: 'isBankOrCash', convert: (v) => v === true || v === 'true' },
  is_system: { field: 'isSystem', convert: (v) => v === true || v === 'true' },
  parent_id: { field: 'parentId', convert: (v) => BigInt(String(v)) },
  level: { field: 'level' },
};

// ---- what refers to an account ----------------------------------------------------------------------

/**
 * Records that name an account. Each later epic adds its own (budget_head and bank_account in P3.02,
 * posting_rule_line in P3.03, …), so delete, re-typing and making a postable account a group all see every reference.
 */
export interface AccountReference {
  readonly label: string;
  count(tx: Tx, accountId: bigint): Promise<number>;
}
const ACCOUNT_REFERENCES: AccountReference[] = [
  {
    label: 'benefit types',
    count: (tx, id) => tx.benefitType.count({ where: { expenseAccountId: id } }),
  },
  // P3.02 (D-3.02-7).
  { label: 'budget heads', count: (tx, id) => tx.budgetHead.count({ where: { accountId: id } }) },
  { label: 'a bank account', count: (tx, id) => tx.bankAccount.count({ where: { accountId: id } }) },
  // P3.03.
  { label: 'posting rules', count: (tx, id) => tx.postingRuleLine.count({ where: { accountId: id } }) },
  // P3.04: a manual journal not yet posted (posted ones count through their journal lines).
  {
    label: 'draft journals',
    count: (tx, id) =>
      tx.journalDraftLine.count({ where: { accountId: id, journal: { state: { not: 'posted' } } } }),
  },
];
/** Journal lines on an account (P3.03): postings fix its code, type, place and postability. */
const ACCOUNT_POSTINGS: AccountReference[] = [
  { label: 'journal lines', count: (tx, id) => tx.journalLine.count({ where: { accountId: id } }) },
];

export function registerAccountReference(ref: AccountReference): void {
  ACCOUNT_REFERENCES.push(ref);
}
export function registerAccountPostings(ref: AccountReference): void {
  ACCOUNT_POSTINGS.push(ref);
}

/** The first thing that refers to the account, or null. */
async function usedBy(tx: Tx, id: bigint): Promise<string | null> {
  for (const ref of [...ACCOUNT_POSTINGS, ...ACCOUNT_REFERENCES]) {
    if ((await ref.count(tx, id)) > 0) return ref.label;
  }
  return null;
}
export async function hasPostings(tx: Tx, id: bigint): Promise<boolean> {
  for (const ref of ACCOUNT_POSTINGS) if ((await ref.count(tx, id)) > 0) return true;
  return false;
}

// ---- errors -------------------------------------------------------------------------------------------

const fail = (code: ErrorCode, message: string, field?: string): AppError =>
  new AppError(code, message, [{ code, message, ...(field ? { field } : {}) }]);
const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const systemRecord = (what: string) =>
  fail('SYSTEM_RECORD', `This is a system account: it ${what}. The application reaches it by its key.`);
const notSignedOff = () =>
  fail(
    'CHART_NOT_SIGNED_OFF',
    'The chart of accounts is inactive until the accountant’s sign-off is recorded (POST /accounts/activate-chart).',
  );

// ---- mapping -----------------------------------------------------------------------------------------

export function toAccountOut(a: Account): AccountOutT {
  return {
    id: a.id.toString(),
    parent_id: idOut(a.parentId),
    code: a.code,
    name: a.name,
    account_type: a.accountType as AccountOutT['account_type'],
    account_subtype: a.accountSubtype as AccountOutT['account_subtype'],
    normal_balance: a.normalBalance as NormalBalance,
    is_postable: a.isPostable,
    is_control_account: a.isControlAccount,
    control_subledger: a.controlSubledger as AccountOutT['control_subledger'],
    is_bank_or_cash: a.isBankOrCash,
    currency_id: idOut(a.currencyId),
    requires_cost_centre: a.requiresCostCentre,
    requires_estate: a.requiresEstate,
    is_clearing: a.isClearing,
    system_key: a.systemKey,
    is_system: a.isSystem,
    level: a.level,
    path: a.path,
    status: a.status as Status,
    version: a.version,
    created_at: a.createdAt.toISOString(),
    updated_at: iso(a.updatedAt),
  };
}

/** Nests a flat chart (any order) into trees, siblings by code. */
export function buildTree(accounts: readonly AccountOutT[]): AccountNode[] {
  const nodes = new Map<string, AccountNode>(accounts.map((a) => [a.id, { ...a, children: [] }]));
  const roots: AccountNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id === null ? undefined : nodes.get(node.parent_id);
    (parent ? parent.children : roots).push(node);
  }
  const sort = (list: AccountNode[]) => {
    list.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** Ids arrive as bigint (zId) and leave as strings; compare them as strings. */
const idText = (v: bigint | string | null | undefined): string | null =>
  v === null || v === undefined ? null : v.toString();

const stamp = (actorId: bigint) => ({ version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId });

// ---- sign-off ------------------------------------------------------------------------------------------

export async function readSignOff(tx: Database | Tx): Promise<SignOffOutT | null> {
  const s = await tx.systemSetting.findUnique({ where: { settingKey: SIGN_OFF_SETTING } });
  if (!s?.settingValue) return null;
  return JSON.parse(s.settingValue) as SignOffOutT;
}

/**
 * The accountant's sign-off of P8 (P3 §31.3, D-3.01-9), in the caller's transaction: recorded once, it
 * activates every account. From then on accounts activate and deactivate one by one.
 */
export async function activateChartIn(tx: Tx, body: SignOff, actorId: bigint) {
  if ((await readSignOff(tx)) !== null)
    throw fail('ALREADY_APPROVED', 'The chart of accounts is already signed off.');
  const value: SignOffOutT = {
    signed_off_by: body.signed_off_by,
    signed_off_on: body.signed_off_on,
    reference: body.reference,
    note: body.note ?? null,
    recorded_by: actorId.toString(),
    recorded_at: new Date().toISOString(),
  };
  // ux_system_setting_key makes a concurrent second sign-off fail here.
  const setting = await tx.systemSetting
    .create({
      data: {
        settingKey: SIGN_OFF_SETTING,
        settingGroup: 'accounting',
        valueType: 'json',
        settingValue: JSON.stringify(value),
        description: 'The accountant’s sign-off of the chart of accounts (P3 §31.3). Written by the system.',
        createdBy: actorId,
      },
    })
    .catch((err: unknown) => {
      if (constraintViolation(err)?.kind === 'unique')
        throw fail('ALREADY_APPROVED', 'The chart of accounts is already signed off.');
      throw err;
    });
  await auditCreate(
    tx,
    SETTING_AUDIT,
    setting.id,
    { key: SIGN_OFF_SETTING, group: 'accounting', value: setting.settingValue },
    { actorId },
  );
  const inactive = await tx.account.findMany({
    where: { status: 'inactive' },
    select: { id: true },
  });
  await tx.account.updateMany({
    where: { status: 'inactive' },
    data: { status: 'active', ...stamp(actorId) },
  });
  await tx.statusHistory.createMany({
    data: inactive.map((a) => ({
      recordType: ACCOUNT_AUDIT.type,
      recordId: a.id.toString(),
      fromState: 'inactive',
      toState: 'active',
      changedBy: actorId,
      comment: `Chart signed off by ${body.signed_off_by} (${body.reference})`,
    })),
  });
  return { signed_off: true, sign_off: value, activated: inactive.length };
}

// ---- the service ---------------------------------------------------------------------------------------

type CreateBody = z.infer<typeof CreateAccountBody>;
type PatchBody = z.infer<typeof PatchAccountBody>;

export function accountsService(db: Database) {
  async function orNotFound(tx: Database | Tx, id: bigint): Promise<Account> {
    const a = await tx.account.findUnique({ where: { id } });
    if (!a) throw Errors.notFound('Account not found.');
    return a;
  }

  /** Locks an account row for the rest of the transaction and returns it. */
  async function locked(tx: Tx, id: bigint, field = 'id'): Promise<Account> {
    await lockRowsForUpdate(tx, 'account', { id });
    const a = await tx.account.findUnique({ where: { id } });
    if (!a) {
      throw field === 'id'
        ? Errors.notFound('Account not found.')
        : Errors.validation([invalid(field, 'No such account.')]);
    }
    return a;
  }

  async function assertCurrency(tx: Tx, id: bigint | null) {
    if (id === null) return;
    if ((await tx.currency.count({ where: { id } })) !== 1)
      throw Errors.validation([invalid('currency_id', 'No such currency.')]);
  }

  function assertShape(shape: AccountShape) {
    const errors = shapeErrors(shape);
    if (errors.length > 0) throw Errors.validation(errors.map((e) => invalid(e.field, e.message)));
  }

  /** A parent that can take one more child: not postable, its type, not at the last level. */
  function assertParent(parent: Account, type: AccountType, height = 1) {
    if (parent.isPostable) {
      throw fail(
        'PARENT_IS_POSTABLE',
        `${parent.code} is a postable account. Make it a group first; only leaves are postable.`,
        'parent_id',
      );
    }
    if (parent.accountType !== type) {
      throw Errors.validation([
        invalid('account_type', `Must be ${parent.accountType}, the type of its parent ${parent.code}.`),
      ]);
    }
    if (parent.level + height > MAX_ACCOUNT_LEVEL) {
      throw fail(
        'ACCOUNT_DEPTH_EXCEEDED',
        `The chart has at most ${String(MAX_ACCOUNT_LEVEL)} levels; ${parent.code} is at level ${String(parent.level)}.`,
        'parent_id',
      );
    }
  }

  /** Rewrites level and path for a node's subtree after it moved (path prefix replaced). */
  async function repath(tx: Tx, node: Account, newPath: string, newLevel: number) {
    const oldPath = node.path ?? pathOf(null, node.id);
    const shift = newLevel - node.level;
    await tx.$executeRaw`
      UPDATE account SET path = CONCAT(${newPath}, SUBSTRING(path, ${oldPath.length + 1})),
        level = level + ${shift}
      WHERE path LIKE ${`${oldPath}%`}`;
  }

  /** The deepest level in a node's subtree (its own when it has no children). */
  async function deepestLevel(tx: Tx, node: Account): Promise<number> {
    const r = await tx.account.aggregate({
      where: { path: { startsWith: node.path ?? pathOf(null, node.id) } },
      _max: { level: true },
    });
    return r._max.level ?? node.level;
  }

  async function createIn(tx: Tx, b: CreateBody, actorId: bigint): Promise<AccountOutT> {
    const parentId = idIn(b.parent_id ?? null);
    const parent = parentId === null ? null : await locked(tx, parentId, 'parent_id');
    const type = b.account_type ?? (parent?.accountType as AccountType | undefined);
    if (!type) throw Errors.validation([invalid('account_type', 'A top-level account gives its type.')]);
    if (parent) assertParent(parent, type);
    const isPostable = b.is_postable ?? true;
    const shape: AccountShape = {
      account_type: type,
      account_subtype:
        b.account_subtype !== undefined
          ? b.account_subtype
          : ((parent?.accountSubtype as AccountShape['account_subtype'] | undefined) ?? null),
      is_postable: isPostable,
      is_control_account: b.is_control_account ?? false,
      control_subledger: b.control_subledger ?? null,
      is_bank_or_cash: b.is_bank_or_cash ?? false,
      currency_id: idText(b.currency_id),
    };
    assertShape(shape);
    await assertCurrency(tx, idIn(shape.currency_id));
    const signedOff = (await readSignOff(tx)) !== null;
    // After the sign-off a new account is active, unless it sits under an inactive group.
    const status: Status =
      signedOff && (parent === null || parent.status === 'active') ? 'active' : 'inactive';
    const created = await tx.account
      .create({
        data: {
          parentId,
          code: b.code,
          name: b.name,
          accountType: type,
          accountSubtype: shape.account_subtype,
          normalBalance: b.normal_balance ?? normalBalanceOf(type),
          isPostable,
          isControlAccount: shape.is_control_account,
          controlSubledger: shape.control_subledger,
          isBankOrCash: shape.is_bank_or_cash,
          currencyId: idIn(shape.currency_id),
          requiresCostCentre: b.requires_cost_centre ?? (isPostable && type === 'expense'),
          requiresEstate: b.requires_estate ?? false,
          isClearing: b.is_clearing ?? false,
          level: parent ? parent.level + 1 : 1,
          status,
          createdBy: actorId,
        },
        select: { id: true },
      })
      .catch(duplicate('code', `Account code ${b.code}`));
    await tx.account.update({
      where: { id: created.id },
      data: { path: pathOf(parent?.path ?? null, created.id) },
    });
    const out = toAccountOut(await orNotFound(tx, created.id));
    await auditCreate(tx, ACCOUNT_AUDIT, created.id, out, { actorId });
    await recordStatusChange(tx, ACCOUNT_AUDIT.type, created.id, null, status, { actorId });
    return out;
  }

  async function updateIn(
    tx: Tx,
    id: bigint,
    expectedVersion: number | null,
    changes: PatchBody,
    actorId: bigint,
  ): Promise<AccountOutT> {
    const before = await locked(tx, id);
    if (expectedVersion !== null && before.version !== expectedVersion)
      versionConflict(before, toAccountOut(before));
    const b = toAccountOut(before);
    const next = {
      parent_id: changes.parent_id !== undefined ? idText(changes.parent_id) : b.parent_id,
      account_type: changes.account_type ?? b.account_type,
      account_subtype: changes.account_subtype !== undefined ? changes.account_subtype : b.account_subtype,
      is_postable: changes.is_postable ?? b.is_postable,
      is_control_account: changes.is_control_account ?? b.is_control_account,
      control_subledger:
        changes.control_subledger !== undefined ? changes.control_subledger : b.control_subledger,
      is_bank_or_cash: changes.is_bank_or_cash ?? b.is_bank_or_cash,
      currency_id: changes.currency_id !== undefined ? idText(changes.currency_id) : b.currency_id,
    };
    const moved = next.parent_id !== b.parent_id;
    const retyped = next.account_type !== b.account_type;
    const postableChanged = next.is_postable !== b.is_postable;
    const recoded = changes.code !== undefined && changes.code !== b.code;
    const signedOff = (await readSignOff(tx)) !== null;

    if (before.isSystem) {
      if (retyped) throw systemRecord('keeps its type');
      if (
        postableChanged ||
        next.is_control_account !== b.is_control_account ||
        next.control_subledger !== b.control_subledger
      )
        throw systemRecord('keeps its postability and control flags');
      if (recoded && signedOff) throw systemRecord('keeps its code after the sign-off');
    }
    // Stability (P8 §2.5): what refers to the account fixes its type, place and postability.
    // What refers to it (rules, budget heads, benefit types) fixes its type and postability; postings
    // also fix its place in the tree (D-3.01-8, refined in P3.03: configuration may follow a move).
    if (retyped || (postableChanged && !next.is_postable)) {
      const by = await usedBy(tx, id);
      if (by !== null) {
        throw fail(
          'REFERENCED_RECORD',
          `This account is in use by ${by}: its type and postability no longer change.`,
        );
      }
    }
    if (moved && (await hasPostings(tx, id))) {
      throw fail(
        'REFERENCED_RECORD',
        'This account has postings: it stays where it is in the chart (P8 §2.5).',
      );
    }
    if (recoded && (await hasPostings(tx, id))) {
      throw fail(
        'REFERENCED_RECORD',
        'This account has postings: its code no longer changes (P8 §2.5).',
        'code',
      );
    }
    const childCount = await tx.account.count({ where: { parentId: id } });
    if (next.is_postable && childCount > 0) {
      throw fail(
        'ACCOUNT_HAS_CHILDREN',
        `${b.code} has ${String(childCount)} account(s) under it: a group is never postable.`,
        'is_postable',
      );
    }
    if (retyped && childCount > 0) {
      throw Errors.validation([invalid('account_type', 'A group with accounts under it keeps its type.')]);
    }
    assertShape(next);
    await assertCurrency(tx, idIn(next.currency_id));

    let level = before.level;
    let path = before.path;
    if (moved) {
      const parentId = idIn(next.parent_id);
      const parent = parentId === null ? null : await locked(tx, parentId, 'parent_id');
      if (parent && (parent.id === id || (before.path !== null && parent.path?.startsWith(before.path)))) {
        throw Errors.validation([invalid('parent_id', 'An account cannot move under itself.')]);
      }
      if (parent) {
        assertParent(parent, next.account_type, subtreeHeight(before.level, await deepestLevel(tx, before)));
      }
      level = parent ? parent.level + 1 : 1;
      path = pathOf(parent?.path ?? null, id);
    } else if (retyped && before.parentId !== null) {
      throw Errors.validation([
        invalid('account_type', 'An account has its parent’s type; move it to change the type.'),
      ]);
    }

    // A contra account stays contra when its type changes; otherwise the balance follows the type.
    const normalBalance = retyped
      ? before.normalBalance === normalBalanceOf(b.account_type)
        ? normalBalanceOf(next.account_type)
        : oppositeBalance(normalBalanceOf(next.account_type))
      : before.normalBalance;

    const { count } = await tx.account
      .updateMany({
        where: { id, version: before.version },
        data: {
          ...(changes.code !== undefined ? { code: changes.code } : {}),
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          parentId: idIn(next.parent_id),
          accountType: next.account_type,
          accountSubtype: next.account_subtype,
          normalBalance,
          isPostable: next.is_postable,
          isControlAccount: next.is_control_account,
          controlSubledger: next.control_subledger,
          isBankOrCash: next.is_bank_or_cash,
          currencyId: idIn(next.currency_id),
          ...(changes.requires_cost_centre !== undefined
            ? { requiresCostCentre: changes.requires_cost_centre }
            : {}),
          ...(changes.requires_estate !== undefined ? { requiresEstate: changes.requires_estate } : {}),
          ...(changes.is_clearing !== undefined ? { isClearing: changes.is_clearing } : {}),
          ...stamp(actorId),
        },
      })
      .catch(duplicate('code', `Account code ${changes.code ?? ''}`));
    if (count !== 1) versionConflict(before, b);
    if (moved && path !== null) await repath(tx, before, path, level);
    const after = toAccountOut(await orNotFound(tx, id));
    await auditUpdate(tx, ACCOUNT_AUDIT, id, b, after, { actorId });
    return after;
  }

  async function setStatusIn(
    tx: Tx,
    id: bigint,
    expectedVersion: number,
    status: Status,
    actorId: bigint,
  ): Promise<AccountOutT> {
    const before = await locked(tx, id);
    if (before.version !== expectedVersion) versionConflict(before, toAccountOut(before));
    if (before.status === status) return toAccountOut(before);
    if (status === 'inactive') {
      if (before.isSystem) throw systemRecord('stays active');
      const active = await tx.account.count({ where: { parentId: id, status: 'active' } });
      if (active > 0) {
        throw fail(
          'INVARIANT_VIOLATED',
          `${before.code} has active accounts under it: deactivate them first.`,
        );
      }
    } else {
      if ((await readSignOff(tx)) === null) throw notSignedOff();
      if (before.parentId !== null) {
        const parent = await orNotFound(tx, before.parentId);
        if (parent.status !== 'active')
          throw Errors.validation([invalid('parent_id', `The parent ${parent.code} is inactive.`)]);
      }
    }
    await tx.account.update({ where: { id }, data: { status, ...stamp(actorId) } });
    const after = toAccountOut(await orNotFound(tx, id));
    await auditUpdate(tx, ACCOUNT_AUDIT, id, toAccountOut(before), after, { actorId });
    await recordStatusChange(tx, ACCOUNT_AUDIT.type, id, before.status, status, { actorId });
    return after;
  }

  async function removeIn(tx: Tx, id: bigint, actorId: bigint): Promise<void> {
    const a = await locked(tx, id);
    if (a.isSystem) throw systemRecord('is never deleted');
    if ((await tx.account.count({ where: { parentId: id } })) > 0)
      throw inUse('account', 'accounts under it');
    const by = await usedBy(tx, id);
    if (by !== null) throw inUse('account', by);
    await tx.account.delete({ where: { id } });
    await auditDelete(tx, ACCOUNT_AUDIT, id, toAccountOut(a), { actorId });
  }

  return {
    createIn,
    updateIn,

    async list(q: ListQuery) {
      const search = q.filters.find((f) => f.field === 'q');
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== 'q') };
      const where = toWhere(rest, ACCOUNT_LIST_FIELDS) as Prisma.AccountWhereInput;
      if (search) {
        const term = String(search.value);
        where.OR = [{ code: { startsWith: term } }, { name: { contains: term } }];
      }
      const [rows, total] = await Promise.all([
        db.account.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, ACCOUNT_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.account.count({ where }),
      ]);
      return { items: rows.map(toAccountOut), total };
    },

    /** The whole chart, nested (about two hundred rows: P8 §3). */
    async tree(filter: { status?: Status | undefined; account_type?: AccountType | undefined }) {
      const rows = await db.account.findMany({
        where: {
          ...(filter.status ? { status: filter.status } : {}),
          ...(filter.account_type ? { accountType: filter.account_type } : {}),
        },
        orderBy: { code: 'asc' },
      });
      return buildTree(rows.map(toAccountOut));
    },

    async get(id: bigint) {
      return toAccountOut(await orNotFound(db, id));
    },

    async create(b: CreateBody, actorId: bigint) {
      return withTransaction(db, (tx) => createIn(tx, b, actorId));
    },

    async update(id: bigint, expectedVersion: number, changes: PatchBody, actorId: bigint) {
      return withTransaction(db, (tx) => updateIn(tx, id, expectedVersion, changes, actorId));
    },

    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, (tx) => setStatusIn(tx, id, expectedVersion, status, actorId));
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, (tx) => removeIn(tx, id, actorId));
    },

    async status() {
      const signOff = await readSignOff(db);
      const [total, active, postable] = await Promise.all([
        db.account.count(),
        db.account.count({ where: { status: 'active' } }),
        db.account.count({ where: { isPostable: true } }),
      ]);
      return {
        signed_off: signOff !== null,
        sign_off: signOff,
        accounts: { total, active, inactive: total - active, postable, groups: total - postable },
      };
    },

    /**
     * The accountant's sign-off of P8 (P3 §31.3, D-3.01-9): recorded once, it activates every account. From
     * then on accounts activate and deactivate one by one.
     */
    async activateChart(body: SignOff, actorId: bigint) {
      return withTransaction(db, (tx) => activateChartIn(tx, body, actorId), { timeout: 30_000 });
    },

    /**
     * Before the sign-off only: removes every account that is not a system account, has no children left
     * and nothing refers to, repeatedly, so a group goes once it is empty (D-3.01-11: the estate's own
     * chart replaces the seed by import). System accounts and their groups stay until re-parented.
     */
    async removeUnused(actorId: bigint) {
      return withTransaction(
        db,
        async (tx) => {
          if ((await readSignOff(tx)) !== null) {
            throw fail(
              'INVALID_TRANSITION',
              'The chart is signed off: accounts are now deactivated, not removed in bulk.',
            );
          }
          let removed = 0;
          for (;;) {
            const leaves = await tx.account.findMany({
              where: { isSystem: false, children: { none: {} } },
              orderBy: { level: 'desc' },
            });
            let round = 0;
            for (const a of leaves) {
              if ((await usedBy(tx, a.id)) !== null) continue;
              await tx.account.delete({ where: { id: a.id } });
              await auditDelete(tx, ACCOUNT_AUDIT, a.id, toAccountOut(a), { actorId });
              round += 1;
            }
            removed += round;
            if (round === 0) break;
          }
          return { removed, remaining: await tx.account.count() };
        },
        { timeout: 60_000 },
      );
    },
  };
}
export type AccountsService = ReturnType<typeof accountsService>;
