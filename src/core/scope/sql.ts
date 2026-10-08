import { Prisma } from '../../generated/prisma/client.js';
import type { ResolvedScope } from './scope.js';

/**
 * The scope filter for RAW SQL (Spec P1 §12.3). The Prisma extension cannot see inside `$queryRaw`, so
 * every raw query on a scoped table, especially report and dashboard aggregates (P6 §4.3), must AND
 * this fragment into its WHERE:
 *
 *   const s = scopeSql(await currentScope(), { estate: 'pwr.estate_id', self: 'pwr.employment_profile_id' });
 *   await tx.$queryRaw`SELECT SUM(pwr.total_quantity) … WHERE pwr.work_date BETWEEN ${from} AND ${to} AND ${s}`;
 *
 * Column references are checked (alias.column, snake_case) and every id is a bound parameter.
 */

export interface ScopeColumns {
  readonly estate?: string;
  readonly division?: string;
  readonly section?: string;
  readonly department?: string;
  readonly factory?: string;
  readonly warehouse?: string;
  readonly self?: string;
}

const COLUMN = /^(?:[a-z][a-z0-9_]{0,63}\.)?[a-z][a-z0-9_]{0,63}$/;

function col(name: string): Prisma.Sql {
  if (!COLUMN.test(name)) throw new Error(`unsafe column reference: ${name}`);
  return Prisma.raw(
    name
      .split('.')
      .map((p) => `\`${p}\``)
      .join('.'),
  );
}

const inList = (column: string, ids: readonly bigint[]) =>
  Prisma.sql`${col(column)} IN (${Prisma.join([...ids])})`;

export function scopeSql(scope: ResolvedScope, columns: ScopeColumns): Prisma.Sql {
  if (scope.allEstates) return Prisma.sql`(1 = 1)`;
  const any: Prisma.Sql[] = [];
  if (columns.estate && scope.estates.length > 0) any.push(inList(columns.estate, scope.estates));
  if (columns.division && scope.divisions.length > 0) any.push(inList(columns.division, scope.divisions));
  if (columns.section && scope.sections.length > 0) any.push(inList(columns.section, scope.sections));
  if (columns.department && scope.departments.length > 0) {
    const dept = inList(columns.department, scope.departments);
    if (!columns.estate) any.push(dept);
    else if (scope.estates.length > 0)
      any.push(Prisma.sql`(${dept} AND ${inList(columns.estate, scope.estates)})`);
  }
  if (columns.factory && scope.factories.length > 0) any.push(inList(columns.factory, scope.factories));
  if (columns.warehouse && scope.warehouses.length > 0) any.push(inList(columns.warehouse, scope.warehouses));
  if (columns.self && scope.selfEmploymentProfileId !== null) {
    any.push(Prisma.sql`${col(columns.self)} = ${scope.selfEmploymentProfileId}`);
  }
  return any.length === 0 ? Prisma.sql`(1 = 0)` : Prisma.sql`(${Prisma.join(any, ' OR ')})`;
}
