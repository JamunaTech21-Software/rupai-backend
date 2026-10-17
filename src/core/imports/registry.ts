import type { Tx } from '../db/transaction.js';

/**
 * What an import type is (P1.17; Spec P4 §6.7, P5 §7.6). One framework carries every import: a module
 * describes its columns, how one row is checked and how a checked row is saved, and the framework does
 * the template, the upload, the validation job, the error report and the commit job.
 *
 * The first importers are the reference lists (lookups). Workforce, attendance and opening balances
 * follow with their phases, each as another registered type.
 */

export interface ImportColumn {
  /** The header in the file, e.g. "code". Matched without regard to case or surrounding spaces. */
  readonly name: string;
  readonly required: boolean;
  /** For the template's instructions, e.g. "Unique; letters, digits, . _ - /". */
  readonly description: string;
  readonly example: string;
}

export interface RowError {
  /** The column at fault; null for the row as a whole. */
  readonly column: string | null;
  readonly code: string;
  readonly message: string;
}

/** A row checked: its errors, or the value commit will save. */
export type RowCheck<V> =
  | { readonly ok: true; readonly value: V; readonly key?: string }
  | { readonly ok: false; readonly errors: readonly RowError[] };

export interface ImportType<V = unknown> {
  /** module.thing, e.g. lookup.amenity. Appears in paths: /imports/templates/{key}. */
  readonly key: string;
  readonly label: string;
  /** The module whose .create allows uploading and committing, and whose .view allows reading batches. */
  readonly permission: string;
  readonly columns: readonly ImportColumn[];
  /** Rows per file. */
  readonly maxRows: number;
  /**
   * Checks one row (text per column; an empty cell is ""). Reads the database but never writes.
   * `key`, when given, must be unique within the file: a second row with the same key is refused.
   */
  check(row: Readonly<Record<string, string>>, tx: Tx): Promise<RowCheck<V>>;
  /**
   * Saves one checked row in the caller's transaction and returns the new record's id. Checks again
   * whatever may have changed since validation; a refusal (an AppError) fails that row only.
   */
  commit(value: V, tx: Tx, actorId: bigint): Promise<string>;
}

const types = new Map<string, ImportType>();
const KEY = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export function registerImportType<V>(t: ImportType<V>): void {
  if (!KEY.test(t.key)) throw new Error(`import type "${t.key}" must look like module.thing`);
  const names = t.columns.map((c) => c.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error(`import type ${t.key}: a column is listed twice`);
  types.set(t.key, t);
}

export function importType(key: string): ImportType | undefined {
  return types.get(key);
}

export function importTypes(): readonly ImportType[] {
  return [...types.values()].sort((a, b) => a.key.localeCompare(b.key));
}
