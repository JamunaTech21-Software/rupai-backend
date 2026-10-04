import type { Filter, ListQuery, SortTerm } from '../http/list-query.js';

/**
 * Turns a validated list query (src/core/http/list-query.ts) into Prisma `where` / `orderBy` / paging.
 * Only fields the endpoint declared reach here, so the mapping is a plain rename: API field → model field,
 * with an optional value conversion (e.g. id strings → bigint).
 */
export type ListFieldMap = Readonly<
  Record<
    string,
    {
      readonly field: string;
      readonly convert?: (value: string | number | boolean) => unknown;
    }
  >
>;

function fieldOf(map: ListFieldMap, name: string) {
  const f = map[name];
  if (!f) throw new Error(`list field "${name}" is declared on the route but not mapped`);
  return f;
}

function condition(map: ListFieldMap, f: Filter): Record<string, unknown> {
  const { field, convert = (v) => v } = fieldOf(map, f.field);
  const one = (v: string | number | boolean) => convert(v);
  switch (f.op) {
    case 'eq':
      return { [field]: one(f.value as string) };
    case 'in':
      return { [field]: { in: (f.value as readonly (string | number)[]).map(one) } };
    case 'from':
      return { [field]: { gte: one(f.value as string) } };
    case 'to':
      return { [field]: { lte: one(f.value as string) } };
    case 'like':
      return { [field]: { startsWith: String(f.value) } };
    case 'null':
      return { [field]: f.value === true || f.value === 'true' ? null : { not: null } };
  }
}

/** AND of every filter. Conditions on the same field (from + to) are combined, not overwritten. */
export function toWhere(query: ListQuery, map: ListFieldMap): Record<string, unknown> {
  if (query.filters.length === 0) return {};
  return { AND: query.filters.map((f) => condition(map, f)) };
}

export function toOrderBy(sort: readonly SortTerm[], map: ListFieldMap): Record<string, 'asc' | 'desc'>[] {
  return sort.map((s) => ({ [fieldOf(map, s.field).field]: s.direction }));
}

/** skip / take for a page-paginated list. */
export function toPaging(query: ListQuery): { skip: number; take: number } {
  const page = query.page ?? { page: 1, perPage: 25 };
  return { skip: (page.page - 1) * page.perPage, take: page.perPage };
}
