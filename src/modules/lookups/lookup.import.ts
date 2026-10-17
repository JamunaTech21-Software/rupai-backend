import type { AccessLog } from '../../core/audit/access-log.js';
import type { Database } from '../../core/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { quoteIdentifier, type Tx } from '../../core/db/transaction.js';
import {
  registerImportType,
  type ImportColumn,
  type ImportType,
  type RowError,
} from '../../core/imports/registry.js';
import { lookupSchemas, lookupService } from './lookup.engine.js';
import { LOOKUP_TYPES, type LookupField, type LookupType } from './lookup-types.js';

/**
 * The first importers (P1.17): every reference list, as `lookup.{type}` (e.g. lookup.amenity). A row
 * becomes a new entry through the lookup engine itself (createIn), so an imported entry is checked,
 * audited and given its status history exactly as one typed in.
 *
 *   - new entries only: a code already in the list is refused (an import never overwrites, D-1.17-6)
 *   - a reference is written as the referenced entry's code (tea_type for tea_type_id, uom for
 *     default_uom_id), never as an id
 *   - estate-scoped lists (shift) are not importable yet: a row would need an estate grant check
 */

const MAX_ROWS = 5000;
const TRUE = new Set(['yes', 'y', 'true', '1']);
const FALSE = new Set(['no', 'n', 'false', '0']);

/** The file's column for a field: a reference drops its _id ("tea_type" holds the tea type's code). */
const columnOf = (f: LookupField) => (f.type.kind === 'ref' ? f.name.replace(/_id$/, '') : f.name);

function describe(f: LookupField, type: LookupType): string {
  const t = f.type;
  const base =
    f.name === type.keyField
      ? 'Unique in the list; letters, digits, . _ - /'
      : t.kind === 'string'
        ? `Text, up to ${String(t.max)} characters`
        : t.kind === 'int'
          ? 'A whole number'
          : t.kind === 'bool'
            ? 'yes or no'
            : t.kind === 'decimal'
              ? 'A number, e.g. 12.5'
              : t.kind === 'enum'
                ? `One of: ${t.values.join(', ')}`
                : t.kind === 'ref'
                  ? `The code of the ${t.label}`
                  : 'A time, HH:MM';
  return f.default !== undefined && f.default !== null && !f.required
    ? `${base}. Default ${String(f.default)}`
    : base;
}

function example(f: LookupField, type: LookupType): string {
  if (f.name === type.keyField) return 'EXAMPLE-1';
  if (f.name === 'name') return `Example ${type.label}`;
  const t = f.type;
  if (t.kind === 'int') return '10';
  if (t.kind === 'bool') return 'no';
  if (t.kind === 'decimal') return '1.5';
  if (t.kind === 'enum') return t.values[0] ?? '';
  if (t.kind === 'time') return '06:00';
  return '';
}

function lookupImport(
  db: Database,
  type: LookupType,
  accessLog: AccessLog,
): ImportType<Record<string, unknown>> {
  const svc = lookupService(db, type, accessLog);
  const fields = type.fields.filter((f) => !f.readOnly);
  const schema = lookupSchemas(type).create;
  const columns: ImportColumn[] = fields.map((f) => ({
    name: columnOf(f),
    required: f.required === true,
    description: describe(f, type),
    example: example(f, type),
  }));

  /** The id of the referenced entry with this code (its own key field), or null. */
  async function refId(tx: Tx, f: LookupField, code: string): Promise<string | null> {
    if (f.type.kind !== 'ref') return null;
    const table = f.type.table;
    const target = LOOKUP_TYPES.find((t) => t.table === table);
    const key = target?.keyField ?? 'code';
    const rows = await tx.$queryRaw<{ id: bigint }[]>(
      Prisma.sql`SELECT id FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(key)} = ${code} LIMIT 1`,
    );
    return rows[0]?.id.toString() ?? null;
  }

  return {
    key: `lookup.${type.key}`,
    label: type.label.charAt(0).toUpperCase() + type.label.slice(1),
    permission: type.permission,
    columns,
    maxRows: MAX_ROWS,

    async check(row, tx) {
      const errors: RowError[] = [];
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        const column = columnOf(f);
        const text = row[column] ?? '';
        if (text === '') continue; // omitted: required fields are reported by the schema below
        const t = f.type;
        if (t.kind === 'int') {
          if (/^-?\d+$/.test(text)) body[f.name] = Number(text);
          else errors.push({ column, code: 'VALIDATION_FAILED', message: 'Must be a whole number.' });
        } else if (t.kind === 'bool') {
          const v = text.toLowerCase();
          if (TRUE.has(v)) body[f.name] = true;
          else if (FALSE.has(v)) body[f.name] = false;
          else errors.push({ column, code: 'VALIDATION_FAILED', message: 'Must be yes or no.' });
        } else if (t.kind === 'enum') body[f.name] = text.toLowerCase();
        else if (t.kind === 'ref') {
          const id = await refId(tx, f, text);
          if (id === null)
            errors.push({
              column,
              code: 'VALIDATION_FAILED',
              message: `No ${t.label} with the code ${text}.`,
            });
          else body[f.name] = id;
        } else body[f.name] = text;
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const name = String(issue.path[0] ?? '');
          const f = fields.find((x) => x.name === name);
          const column = f ? columnOf(f) : null;
          if (errors.some((e) => e.column === column)) continue;
          errors.push({
            column,
            code: 'VALIDATION_FAILED',
            message: (row[column ?? ''] ?? '') === '' ? 'Required.' : issue.message,
          });
        }
      }
      const key = row[type.keyField] ?? '';
      if (errors.length === 0 && (await svc.keyTaken(tx, key))) {
        errors.push({
          column: type.keyField,
          code: 'DUPLICATE_KEY',
          message: `${key} is already in the list. An import adds new entries only.`,
        });
      }
      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, value: parsed.data as Record<string, unknown>, key: key.toUpperCase() };
    },

    async commit(value, tx, actorId) {
      // The engine checks again (the code may have been taken since validation) and audits the entry.
      return (await svc.createIn(tx, value, actorId)).id;
    },
  };
}

/** Registers lookup.{type} for every reference list without an estate column. */
export function registerLookupImports(db: Database, accessLog: AccessLog): void {
  for (const type of LOOKUP_TYPES) {
    if (type.estateColumn) continue;
    registerImportType(lookupImport(db, type, accessLog));
  }
}
