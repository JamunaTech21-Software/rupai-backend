import { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { constraintViolation } from '../../core/db/errors.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { Filter, ListQuery, ListQuerySpec } from '../../core/http/list-query.js';
import { zId } from '../../core/ids/ids.js';
import { Dec, toDecimalString, zDecimal } from '../../core/money/decimal.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { Prisma } from '../../generated/prisma/client.js';
import { denyWrite } from '../organisation/common.js';
import type { LookupField, LookupType } from './lookup-types.js';

/**
 * The lookup engine (Spec P3 §5, P4 §7.3: "one controller serving every common-shape lookup"). Everything
 * here is driven by a LookupType descriptor; nothing knows a table by name except the few rules in HOOKS.
 *
 *   - is_system rows (P3 §5.1) keep their key, and reject DELETE and deactivate with 422 SYSTEM_RECORD:
 *     application logic depends on them. They may be renamed.
 *   - A row is deleted only while nothing refers to it (foreign keys RESTRICT → REFERENCED_RECORD);
 *     otherwise it is deactivated.
 *   - A reference (tea_type_id, default_uom_id, …) must name an existing row.
 *   - Lookups are organisation-tier, except a type with an estate column (shift): a row with an estate
 *     follows estate scope; an organisation-wide row is visible to all and changed only with all_estates.
 *
 * Raw SQL, because one implementation serves 25 tables; every identifier comes from the descriptors
 * (never from a request) and every value is a bound parameter.
 */

export const LOOKUP_STATUSES = ['active', 'inactive'] as const;
export type LookupStatus = (typeof LOOKUP_STATUSES)[number];
export type LookupRow = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly version: number;
  readonly status: LookupStatus;
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const col = (name: string) => Prisma.raw(`\`${name}\``);
const writable = (t: LookupType) => t.fields.filter((f) => !f.readOnly);
const isNullable = (f: LookupField) => !f.required && f.default === null;

// ---- schemas ------------------------------------------------------------------------------------------

function fieldSchema(f: LookupField): z.ZodType {
  const t = f.type;
  switch (t.kind) {
    case 'string': {
      let s = z.string().trim().min(1).max(t.max);
      if (t.pattern) s = s.regex(t.pattern, 'has an invalid format');
      return t.upper ? s.transform((v) => v.toUpperCase()) : s;
    }
    case 'int':
      return z
        .number()
        .int()
        .min(t.min ?? 0)
        .max(t.max ?? 2_147_483_647);
    case 'bool':
      return z.boolean();
    case 'decimal':
      return zDecimal(t.decimal, t.positive ? { positive: true } : { min: '0' });
    case 'enum':
      return z.enum(t.values as [string, ...string[]]);
    case 'ref':
      return zId;
    case 'time':
      return z.string().regex(TIME, 'must be a time, HH:MM');
  }
}

function outSchema(f: LookupField): z.ZodType {
  const t = f.type;
  const base: z.ZodType =
    t.kind === 'int'
      ? z.number().int()
      : t.kind === 'bool'
        ? z.boolean()
        : t.kind === 'enum'
          ? z.enum(t.values as [string, ...string[]])
          : z.string();
  return isNullable(f) ? base.nullable() : base;
}

export function lookupSchemas(type: LookupType) {
  const fields = writable(type);
  const input = (f: LookupField) => (isNullable(f) ? fieldSchema(f).nullable() : fieldSchema(f));
  const create = z.strictObject(
    Object.fromEntries(fields.map((f) => [f.name, f.required ? input(f) : input(f).optional()])),
  );
  const replace = z.strictObject(Object.fromEntries(fields.map((f) => [f.name, input(f)])));
  const patch = z.strictObject(Object.fromEntries(fields.map((f) => [f.name, input(f).optional()])));
  const out = z.object({
    id: z.string(),
    ...Object.fromEntries(type.fields.map((f) => [f.name, outSchema(f)])),
    status: z.enum(LOOKUP_STATUSES),
    version: z.number().int(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
  });

  const filters: NonNullable<ListQuerySpec['filters']> = {
    status: { type: { enum: LOOKUP_STATUSES } },
    [type.keyField]: { type: 'string', ops: ['eq', 'in', 'like'] },
    name: { type: 'string', ops: ['like'] },
    ...(type.hasSystem ? { is_system: { type: 'bool' } } : {}),
    ...Object.fromEntries(
      type.fields
        .filter((f) => f.filter)
        .map((f) => [
          f.name,
          f.type.kind === 'ref'
            ? { type: 'id', ops: ['eq', 'in', 'null'] }
            : f.type.kind === 'bool'
              ? { type: 'bool' }
              : f.type.kind === 'enum'
                ? { type: { enum: f.type.values } }
                : { type: 'string', ops: ['eq'] },
        ]),
    ),
    // "Grades filter by tea type" (P4 §7.3): the grades usable for a type are its own and the universal ones.
    ...(type.key === 'tea_grade' ? { valid_for_tea_type_id: { type: 'id', ops: ['eq'] } } : {}),
  };
  const sortable = [
    type.keyField,
    'name',
    ...(type.fields.some((f) => f.name === 'sort_order') ? ['sort_order'] : []),
  ];
  const list: ListQuerySpec = {
    pagination: 'page',
    filters,
    sorts: sortable,
    defaultSort: [...type.defaultSort],
    maxPageSize: 500,
  };
  return { create, replace, patch, out, list };
}

// ---- value conversion ---------------------------------------------------------------------------------

/** A database or request value as text: raw rows carry strings, numbers, bigints and Prisma decimals. */
function text(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') return String(v);
  if (v instanceof Prisma.Decimal) return v.toFixed();
  if (v instanceof Date) return v.toISOString();
  throw new TypeError('lookup value is not a scalar');
}

function toDb(f: LookupField, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (f.type.kind) {
    case 'decimal':
      return (v instanceof Dec ? v : new Dec(text(v))).toFixed();
    case 'ref':
      return BigInt(v as string | bigint);
    case 'time':
      return `${text(v).slice(0, 5)}:00`;
    default:
      return v;
  }
}

function fromDb(f: LookupField, raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  switch (f.type.kind) {
    case 'int':
      return Number(raw);
    case 'bool':
      return Boolean(Number(raw));
    case 'decimal':
      return toDecimalString(new Dec(text(raw)), f.type.decimal);
    case 'ref':
      return text(raw);
    case 'time':
      return raw instanceof Date ? raw.toISOString().slice(11, 16) : text(raw).slice(0, 5);
    default:
      return text(raw);
  }
}

export function toLookupRow(type: LookupType, row: Readonly<Record<string, unknown>>): LookupRow {
  return {
    id: String(row.id),
    ...Object.fromEntries(type.fields.map((f) => [f.name, fromDb(f, row[f.name])])),
    status: String(row.status) as LookupStatus,
    version: Number(row.version),
    created_at: (row.created_at as Date).toISOString(),
    updated_at: row.updated_at ? (row.updated_at as Date).toISOString() : null,
  };
}

// ---- rules of particular types ------------------------------------------------------------------------

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const invariant = (message: string) =>
  new AppError('INVARIANT_VIOLATED', message, [{ code: 'INVARIANT_VIOLATED', message }]);

interface Hooks {
  /** Before insert or update. `values` holds column → database value and may be adjusted. */
  beforeSave?(tx: Tx, values: Record<string, unknown>, current: LookupRow | null): Promise<void> | void;
  /** After an update, with the row as it was. */
  afterUpdate?(tx: Tx, before: LookupRow, after: LookupRow): Promise<void>;
  /** Before a deactivation or a delete. Throw to refuse. */
  beforeRetire?(tx: Tx, current: LookupRow): Promise<void> | void;
}

const HOOKS: Readonly<Record<string, Hooks>> = {
  benefit_type: {
    // P3.01 (P8 §11.1): a benefit's cost posts to a postable expense account.
    async beforeSave(tx, values) {
      const id = values.expense_account_id as bigint | null | undefined;
      if (id === null || id === undefined) return;
      const [a] = await tx.$queryRaw<{ account_type: string; is_postable: number | boolean }[]>`
        SELECT account_type, is_postable FROM account WHERE id = ${id}`;
      if (a && (a.account_type !== 'expense' || !a.is_postable)) {
        throw Errors.validation([invalid('expense_account_id', 'must be a postable expense account')]);
      }
    },
  },
  shift: {
    // P3 §5.2.4: where end_time is not after start_time the shift ends on the following day.
    beforeSave(_tx, values) {
      values.is_overnight = String(values.end_time) <= String(values.start_time);
    },
  },
  uom: {
    beforeSave(_tx, values, current) {
      if (!current?.is_base) return;
      // The base unit converts to itself, and its category is what makes it the base.
      if (String(values.uom_category_id) !== String(current.uom_category_id)) {
        throw Errors.validation([
          invalid('uom_category_id', 'the base unit of a category cannot move to another'),
        ]);
      }
      values.conversion_factor = '1';
    },
    beforeRetire(_tx, current) {
      if (current.is_base)
        throw invariant('This is the base unit of its category; choose another base unit first.');
    },
  },
  uom_category: {
    async beforeSave(tx, values, current) {
      const next = values.base_uom_id as bigint | null;
      if (next === null) return;
      if (!current) {
        throw Errors.validation([
          invalid('base_uom_id', 'set the base unit after creating the units of the category'),
        ]);
      }
      if (current.base_uom_id === next.toString()) return;
      const [unit] = await tx.$queryRaw<
        { uom_category_id: bigint }[]
      >`SELECT uom_category_id FROM uom WHERE id = ${next}`;
      if (unit?.uom_category_id.toString() !== current.id) {
        throw Errors.validation([invalid('base_uom_id', 'must be a unit of this category')]);
      }
      // Factors are expressed against the base. Changing it would make every existing factor wrong, the new
      // base's own included, so they must be cleared first; the old base then loses its factor of 1.
      const others = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM uom WHERE uom_category_id = ${BigInt(current.id)} AND is_base = 0
          AND conversion_factor IS NOT NULL LIMIT 1`;
      if (current.base_uom_id !== null && others.length > 0) {
        throw invariant(
          'Units of this category have conversion factors against the current base unit; clear them first.',
        );
      }
    },
    async afterUpdate(tx, before, after) {
      if (before.base_uom_id === after.base_uom_id) return;
      // Clear first: ux_uom_base allows one base per category.
      await tx.$executeRaw`UPDATE uom SET is_base = 0, conversion_factor = NULL WHERE uom_category_id = ${BigInt(after.id)} AND is_base = 1`;
      if (after.base_uom_id !== null) {
        await tx.$executeRaw`UPDATE uom SET is_base = 1, conversion_factor = 1 WHERE id = ${BigInt(after.base_uom_id as string)}`;
      }
    },
  },
  currency: {
    beforeRetire(_tx, current) {
      if (current.is_base) throw invariant('The base currency cannot be deactivated or deleted.');
    },
  },
};

// ---- service ------------------------------------------------------------------------------------------

function filterSql(type: LookupType, f: Filter): Prisma.Sql {
  if (f.field === 'valid_for_tea_type_id') {
    return Prisma.sql`(\`tea_type_id\` IS NULL OR \`tea_type_id\` = ${BigInt(String(f.value))})`;
  }
  const field = type.fields.find((x) => x.name === f.field);
  const c = col(f.field);
  const conv = (v: string | number | boolean): unknown =>
    field?.type.kind === 'ref'
      ? BigInt(String(v))
      : field?.type.kind === 'bool' || f.field === 'is_system'
        ? v === true || v === 'true'
        : v;
  switch (f.op) {
    case 'eq':
      return Prisma.sql`${c} = ${conv(f.value as string)}`;
    case 'in':
      return Prisma.sql`${c} IN (${Prisma.join((f.value as readonly (string | number)[]).map(conv))})`;
    case 'like':
      return Prisma.sql`${c} LIKE ${`${String(f.value).replace(/[\\%_]/g, '\\$&')}%`}`;
    case 'null':
      return f.value === true || f.value === 'true' ? Prisma.sql`${c} IS NULL` : Prisma.sql`${c} IS NOT NULL`;
    default:
      throw new Error(`lookup filter operator ${f.op} is not supported`);
  }
}

export function lookupService(db: Database, type: LookupType, accessLog: AccessLog) {
  const table = col(type.table);
  const hooks = HOOKS[type.key] ?? {};
  const audit: AuditedRecord = {
    type: type.key,
    class: 'master',
    fields: [...type.fields.map((f) => f.name), 'status'],
  };

  /** Rows this caller may see: all, or for an estate-scoped type the organisation-wide ones and their estates'. */
  async function visible(): Promise<Prisma.Sql> {
    if (!type.estateColumn) return Prisma.sql`(1 = 1)`;
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return Prisma.sql`(1 = 1)`;
    const c = col(type.estateColumn);
    return scope.estates.length === 0
      ? Prisma.sql`${c} IS NULL`
      : Prisma.sql`(${c} IS NULL OR ${c} IN (${Prisma.join([...scope.estates])}))`;
  }

  /** Changing a row with an estate needs that estate; an organisation-wide one needs all estates. */
  async function assertWritable(estate: unknown, id: bigint | null, operation: string): Promise<void> {
    if (!type.estateColumn) return;
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return;
    if (estate !== null && estate !== undefined && scope.estates.includes(BigInt(estate as string | bigint)))
      return;
    await denyWrite(accessLog, type.key, id, operation);
  }

  async function find(tx: Database | Tx, id: bigint): Promise<LookupRow | null> {
    const rows = await tx.$queryRaw<Record<string, unknown>[]>(
      Prisma.sql`SELECT * FROM ${table} WHERE \`id\` = ${id} AND ${await visible()}`,
    );
    return rows[0] ? toLookupRow(type, rows[0]) : null;
  }
  async function orNotFound(tx: Database | Tx, id: bigint): Promise<LookupRow> {
    const row = await find(tx, id);
    if (!row) throw Errors.notFound(`No such ${type.label}.`);
    return row;
  }

  async function assertReferences(tx: Tx, values: Record<string, unknown>, changed: ReadonlySet<string>) {
    const problems: ErrorDetail[] = [];
    for (const f of type.fields) {
      if (f.type.kind !== 'ref' || !changed.has(f.name) || values[f.name] === null) continue;
      const found = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT 1 FROM ${col(f.type.table)} WHERE \`id\` = ${values[f.name]} LIMIT 1`,
      );
      if (found.length === 0) problems.push(invalid(f.name, `No such ${f.type.label}.`));
    }
    if (problems.length > 0) throw Errors.validation(problems);
  }

  async function assertKeyFree(tx: Tx, key: unknown, exceptId: bigint | null) {
    const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT 1 FROM ${table} WHERE ${col(type.keyField)} = ${key}
      ${exceptId === null ? Prisma.empty : Prisma.sql`AND \`id\` <> ${exceptId}`} LIMIT 1`);
    if (rows.length > 0) throw duplicate(type.keyField);
  }
  const duplicate = (field: string) =>
    new AppError('DUPLICATE_KEY', `That ${type.label} ${field.replace('_', ' ')} is already in use.`, [
      { field, code: 'DUPLICATE_KEY', message: 'is already in use' },
    ]);
  /** The unique indexes are the last word (a concurrent insert, or country.iso3). */
  const onConflict = (err: unknown): never => {
    const message = err instanceof Error ? err.message : '';
    const unique = constraintViolation(err)?.kind === 'unique' || message.includes('Duplicate entry');
    if (unique) throw duplicate(/ux_\w+_(iso3)\b/.exec(message)?.[1] ?? type.keyField);
    throw err;
  };

  const system = (what: string) =>
    new AppError('SYSTEM_RECORD', `This ${type.label} is a system record and cannot be ${what}.`, [
      { code: 'SYSTEM_RECORD', message: 'The application depends on it. It may be renamed.' },
    ]);

  const service = {
    type,

    async list(q: ListQuery): Promise<{ items: LookupRow[]; total: number }> {
      const where = Prisma.join([await visible(), ...q.filters.map((f) => filterSql(type, f))], ' AND ');
      const order = Prisma.join(
        [
          ...q.sort.map(
            (s) => Prisma.sql`${col(s.field)} ${Prisma.raw(s.direction === 'desc' ? 'DESC' : 'ASC')}`,
          ),
          Prisma.sql`\`id\` ASC`,
        ],
        ', ',
      );
      const page = q.page ?? { page: 1, perPage: 25 };
      const [rows, count] = await Promise.all([
        db.$queryRaw<Record<string, unknown>[]>(
          Prisma.sql`SELECT * FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ${page.perPage} OFFSET ${(page.page - 1) * page.perPage}`,
        ),
        db.$queryRaw<{ n: bigint }[]>(Prisma.sql`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`),
      ]);
      return { items: rows.map((r) => toLookupRow(type, r)), total: Number(count[0]?.n ?? 0) };
    },

    /** Every ACTIVE row, in display order: for the bulk fetch that primes selection lists. */
    async active(): Promise<LookupRow[]> {
      const order = Prisma.join(
        type.defaultSort.map((s) => col(s)),
        ', ',
      );
      const rows = await db.$queryRaw<Record<string, unknown>[]>(
        Prisma.sql`SELECT * FROM ${table} WHERE \`status\` = 'active' AND ${await visible()} ORDER BY ${order}, \`id\``,
      );
      return rows.map((r) => toLookupRow(type, r));
    },

    async get(id: bigint): Promise<LookupRow> {
      return orNotFound(db, id);
    },

    async create(body: Readonly<Record<string, unknown>>, actorId: bigint): Promise<LookupRow> {
      return withTransaction(db, (tx) => service.createIn(tx, body, actorId));
    },

    /** create, in the caller's transaction (the import commit, P1.17). `body` is already validated. */
    async createIn(tx: Tx, body: Readonly<Record<string, unknown>>, actorId: bigint): Promise<LookupRow> {
      const values: Record<string, unknown> = {};
      for (const f of type.fields) {
        // A read-only field starts at its declared default (P2.08 payroll_treatment), else false / null.
        if (f.readOnly)
          values[f.name] = f.default !== undefined ? f.default : f.type.kind === 'bool' ? false : null;
        else values[f.name] = toDb(f, body[f.name] === undefined ? (f.default ?? null) : body[f.name]);
      }
      if (type.estateColumn) await assertWritable(values[type.estateColumn], null, 'create');
      await hooks.beforeSave?.(tx, values, null);
      await assertReferences(tx, values, new Set(type.fields.map((f) => f.name)));
      await assertKeyFree(tx, values[type.keyField], null);
      const data = { ...values, status: 'active', created_by: actorId };
      const cols = Object.keys(data);
      await tx
        .$executeRaw(
          Prisma.sql`INSERT INTO ${table} (${Prisma.join(cols.map(col))}) VALUES (${Prisma.join(cols.map((k) => (data as Record<string, unknown>)[k]))})`,
        )
        .catch(onConflict);
      const [inserted] = await tx.$queryRaw<{ id: bigint }[]>`SELECT LAST_INSERT_ID() AS id`;
      const out = await orNotFound(tx, BigInt(inserted?.id ?? 0));
      await auditCreate(tx, audit, out.id, out, { actorId });
      await recordStatusChange(tx, type.key, out.id, null, 'active', { actorId });
      return out;
    },

    /** Whether a row with this business key exists (the import's check, P1.17). */
    async keyTaken(tx: Database | Tx, key: string): Promise<boolean> {
      const rows = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT 1 FROM ${table} WHERE ${col(type.keyField)} = ${key} LIMIT 1`,
      );
      return rows.length > 0;
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: Readonly<Record<string, unknown>>,
      actorId: bigint,
    ): Promise<LookupRow> {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        if (type.estateColumn) await assertWritable(before[type.estateColumn], id, 'update');
        const values: Record<string, unknown> = {};
        const changed = new Set<string>();
        for (const f of type.fields) {
          const given = !f.readOnly && changes[f.name] !== undefined;
          values[f.name] = toDb(f, given ? changes[f.name] : before[f.name]);
          if (given && fromDb(f, values[f.name]) !== before[f.name]) changed.add(f.name);
        }
        if (type.hasSystem && before.is_system && changed.has(type.keyField)) {
          throw new AppError(
            'SYSTEM_RECORD',
            `The ${type.keyField} of a system ${type.label} cannot be changed.`,
            [
              {
                field: type.keyField,
                code: 'SYSTEM_RECORD',
                message: 'The application refers to it. The name may be changed.',
              },
            ],
          );
        }
        if (type.estateColumn && changed.has(type.estateColumn))
          await assertWritable(values[type.estateColumn], id, 'update');
        await hooks.beforeSave?.(tx, values, before);
        await assertReferences(tx, values, changed);
        if (changed.has(type.keyField)) await assertKeyFree(tx, values[type.keyField], id);
        const sets = Prisma.join(type.fields.map((f) => Prisma.sql`${col(f.name)} = ${values[f.name]}`));
        const count = await tx
          .$executeRaw(
            Prisma.sql`UPDATE ${table} SET ${sets}, \`version\` = \`version\` + 1, \`updated_at\` = ${new Date()}, \`updated_by\` = ${actorId}
                       WHERE \`id\` = ${id} AND \`version\` = ${expectedVersion}`,
          )
          .catch(onConflict);
        if (count !== 1) throw Errors.versionConflict({ version: before.version, resource: before });
        await hooks.afterUpdate?.(tx, before, await orNotFound(tx, id));
        const after = await orNotFound(tx, id);
        await auditUpdate(tx, audit, id, before, after, { actorId });
        return after;
      });
    },

    async setStatus(
      id: bigint,
      expectedVersion: number,
      status: LookupStatus,
      actorId: bigint,
    ): Promise<LookupRow> {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        if (type.estateColumn) await assertWritable(before[type.estateColumn], id, status);
        if (before.version !== expectedVersion)
          throw Errors.versionConflict({ version: before.version, resource: before });
        if (before.status === status) return before;
        if (status === 'inactive') {
          if (type.hasSystem && before.is_system) throw system('deactivated');
          await hooks.beforeRetire?.(tx, before);
        }
        await tx.$executeRaw(
          Prisma.sql`UPDATE ${table} SET \`status\` = ${status}, \`version\` = \`version\` + 1, \`updated_at\` = ${new Date()}, \`updated_by\` = ${actorId} WHERE \`id\` = ${id}`,
        );
        const after = await orNotFound(tx, id);
        await auditUpdate(tx, audit, id, before, after, { actorId });
        await recordStatusChange(tx, type.key, id, before.status, status, { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint): Promise<void> {
      await withTransaction(db, async (tx) => {
        const row = await orNotFound(tx, id);
        if (type.estateColumn) await assertWritable(row[type.estateColumn], id, 'delete');
        if (type.hasSystem && row.is_system) throw system('deleted');
        await hooks.beforeRetire?.(tx, row);
        await tx.$executeRaw(Prisma.sql`DELETE FROM ${table} WHERE \`id\` = ${id}`).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : '';
          if (
            constraintViolation(err)?.kind === 'referenced' ||
            /foreign key constraint fails/i.test(message)
          ) {
            throw new AppError(
              'REFERENCED_RECORD',
              `This ${type.label} is in use, so it cannot be deleted.`,
              [{ code: 'REFERENCED_RECORD', message: 'Deactivate it instead.' }],
            );
          }
          throw err;
        });
        await auditDelete(tx, audit, id, row, { actorId });
      });
    },
  };
  return service;
}

export type LookupService = ReturnType<typeof lookupService>;
