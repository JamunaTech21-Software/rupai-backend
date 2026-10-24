import type { Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { LookupHooks, LookupRow } from './lookup.engine.js';

/**
 * The rules of the two analysis trees served by the lookup engine (P3 §26.2, D-3.02-3 to D-3.02-5):
 * cost centres and budget heads. Both: a parent that is active, no cycles, a depth limit, no deactivation
 * while a child is active, no reactivation under an inactive parent.
 *
 *   cost_centre  a child is of its parent's estate (or under an organisation-wide parent); the manager is a
 *                profile, not separated, employed at the centre's estate; the estate does not change while
 *                the centre has children. At most 5 levels.
 *   budget_head  a child has its parent's head type; the account is of the head's type (expense → expense,
 *                revenue → revenue, capital → asset), and may be a group (the head governs its subtree).
 *                At most 4 levels.
 */

interface Tree {
  readonly table: 'cost_centre' | 'budget_head';
  readonly parentColumn: 'parent_cost_centre_id' | 'parent_head_id';
  readonly label: string;
  readonly maxDepth: number;
}
const COST_CENTRES: Tree = {
  table: 'cost_centre',
  parentColumn: 'parent_cost_centre_id',
  label: 'cost centre',
  maxDepth: 5,
};
const BUDGET_HEADS: Tree = {
  table: 'budget_head',
  parentColumn: 'parent_head_id',
  label: 'budget head',
  maxDepth: 4,
};

const invalid = (field: string, message: string) =>
  Errors.validation([{ field, code: 'VALIDATION_FAILED', message }]);
const invariant = (message: string) =>
  new AppError('INVARIANT_VIOLATED', message, [{ code: 'INVARIANT_VIOLATED', message }]);

const id = (v: unknown): bigint | null =>
  v === null || v === undefined ? null : BigInt(v as string | number | bigint);

interface Node {
  readonly id: bigint;
  readonly parent: bigint | null;
  readonly status: string;
  readonly [column: string]: unknown;
}

async function nodeOf(tx: Tx, t: Tree, nodeId: bigint): Promise<Node | null> {
  const [row] = await tx.$queryRaw<Record<string, unknown>[]>(
    Prisma.sql`SELECT * FROM ${Prisma.raw(t.table)} WHERE id = ${nodeId}`,
  );
  if (!row) return null;
  return {
    ...row,
    id: row.id as bigint,
    parent: id(row[t.parentColumn]),
    status: String(row.status),
  };
}

/** How many levels the subtree under a node spans (1 for a leaf), breadth first. */
async function subtreeHeight(tx: Tx, t: Tree, nodeId: bigint): Promise<number> {
  let level = [nodeId];
  let height = 0;
  while (level.length > 0 && height <= t.maxDepth) {
    height += 1;
    const rows = await tx.$queryRaw<{ id: bigint }[]>(
      Prisma.sql`SELECT id FROM ${Prisma.raw(t.table)} WHERE ${Prisma.raw(t.parentColumn)} IN (${Prisma.join(level)})`,
    );
    level = rows.map((r) => r.id);
  }
  return height;
}

/**
 * The parent a node may take: it exists and is active, the node is not among its ancestors, and the
 * resulting depth stays within the limit. Returns the parent row.
 */
async function checkParent(tx: Tx, t: Tree, parentId: bigint, current: LookupRow | null): Promise<Node> {
  const parent = await nodeOf(tx, t, parentId);
  if (!parent) throw invalid(t.parentColumn, `No such ${t.label}.`);
  if (parent.status !== 'active') throw invalid(t.parentColumn, `The parent ${t.label} is inactive.`);
  const self = current ? BigInt(current.id) : null;
  let depth = 1;
  for (
    let at: Node | null = parent;
    at !== null;
    at = at.parent === null ? null : await nodeOf(tx, t, at.parent)
  ) {
    if (self !== null && at.id === self)
      throw invalid(t.parentColumn, `A ${t.label} cannot sit under itself.`);
    depth += 1;
    if (depth > t.maxDepth + 1) break;
  }
  const height = self === null ? 1 : await subtreeHeight(tx, t, self);
  if (depth - 1 + height > t.maxDepth) {
    throw invalid(t.parentColumn, `The ${t.label} tree has at most ${String(t.maxDepth)} levels.`);
  }
  return parent;
}

async function activeChildren(tx: Tx, t: Tree, nodeId: string): Promise<number> {
  const [r] = await tx.$queryRaw<{ n: bigint }[]>(
    Prisma.sql`SELECT COUNT(*) AS n FROM ${Prisma.raw(t.table)} WHERE ${Prisma.raw(t.parentColumn)} = ${BigInt(nodeId)} AND status = 'active'`,
  );
  return Number(r?.n ?? 0);
}
async function children(tx: Tx, t: Tree, nodeId: string): Promise<number> {
  const [r] = await tx.$queryRaw<{ n: bigint }[]>(
    Prisma.sql`SELECT COUNT(*) AS n FROM ${Prisma.raw(t.table)} WHERE ${Prisma.raw(t.parentColumn)} = ${BigInt(nodeId)}`,
  );
  return Number(r?.n ?? 0);
}

function treeHooks(t: Tree): Pick<LookupHooks, 'beforeRetire' | 'beforeReactivate'> {
  return {
    async beforeRetire(tx, current) {
      if ((await activeChildren(tx, t, current.id)) > 0) {
        throw invariant(`This ${t.label} has active ${t.label}s under it: deactivate or move them first.`);
      }
    },
    async beforeReactivate(tx, current) {
      const parent = id(current[t.parentColumn]);
      if (parent === null) return;
      const p = await nodeOf(tx, t, parent);
      if (p?.status !== 'active') throw invalid(t.parentColumn, `The parent ${t.label} is inactive.`);
    },
  };
}

export const costCentreHooks: LookupHooks = {
  ...treeHooks(COST_CENTRES),
  async beforeSave(tx, values, current) {
    const estate = id(values.estate_id);
    const parentId = id(values.parent_cost_centre_id);
    const parentChanged = current === null || String(parentId) !== String(current.parent_cost_centre_id);
    if (parentId !== null && parentChanged) {
      const parent = await checkParent(tx, COST_CENTRES, parentId, current);
      const parentEstate = id(parent.estate_id);
      if (parentEstate !== null && parentEstate !== estate) {
        throw invalid('parent_cost_centre_id', 'The parent cost centre belongs to another estate.');
      }
    } else if (parentId !== null && current !== null && String(estate) !== String(current.estate_id)) {
      const parent = await nodeOf(tx, COST_CENTRES, parentId);
      const parentEstate = id(parent?.estate_id);
      if (parentEstate !== null && parentEstate !== estate) {
        throw invalid('estate_id', 'A cost centre has its parent’s estate.');
      }
    }
    if (current !== null && String(estate) !== String(current.estate_id)) {
      if ((await children(tx, COST_CENTRES, current.id)) > 0) {
        throw invalid('estate_id', 'A cost centre with cost centres under it keeps its estate.');
      }
    }
    if ((values.centre_type === 'estate' || values.centre_type === 'division') && estate === null) {
      throw invalid('estate_id', `A cost centre of type ${values.centre_type} names its estate.`);
    }
    const manager = id(values.manager_profile_id);
    if (manager !== null) {
      const [p] = await tx.$queryRaw<{ estate_id: bigint; status: string }[]>`
        SELECT estate_id, status FROM employment_profile WHERE id = ${manager}`;
      if (!p) throw invalid('manager_profile_id', 'No such employment profile.');
      if (p.status === 'separated') throw invalid('manager_profile_id', 'This person has separated.');
      if (estate !== null && p.estate_id !== estate) {
        throw invalid('manager_profile_id', 'The manager is employed at another estate.');
      }
    }
  },
};

/** D-3.02-5: the account type a head of each type governs. */
const ACCOUNT_TYPE_OF_HEAD: Readonly<Record<string, string>> = {
  expense: 'expense',
  revenue: 'revenue',
  capital: 'asset',
};

export const budgetHeadHooks: LookupHooks = {
  ...treeHooks(BUDGET_HEADS),
  async beforeSave(tx, values, current) {
    const type = String(values.head_type);
    const parentId = id(values.parent_head_id);
    const parentChanged = current === null || String(parentId) !== String(current.parent_head_id);
    if (parentId !== null) {
      const parent = parentChanged
        ? await checkParent(tx, BUDGET_HEADS, parentId, current)
        : await nodeOf(tx, BUDGET_HEADS, parentId);
      if (parent && parent.head_type !== type) {
        throw invalid('head_type', `Must be ${String(parent.head_type)}, the type of its parent.`);
      }
    }
    if (
      current !== null &&
      type !== current.head_type &&
      (await children(tx, BUDGET_HEADS, current.id)) > 0
    ) {
      throw invalid('head_type', 'A budget head with heads under it keeps its type.');
    }
    const account = id(values.account_id);
    if (account !== null) {
      const [a] = await tx.$queryRaw<{ account_type: string }[]>`
        SELECT account_type FROM account WHERE id = ${account}`;
      const wanted = ACCOUNT_TYPE_OF_HEAD[type];
      if (a && a.account_type !== wanted) {
        throw invalid('account_id', `A ${type} budget head governs a ${String(wanted)} account.`);
      }
    }
  },
};
