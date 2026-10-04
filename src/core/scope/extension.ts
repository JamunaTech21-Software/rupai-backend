import { Prisma } from '../../generated/prisma/client.js';
import { getRequestContext } from '../context/request-context.js';
import {
  canCreate,
  NOTHING,
  scopeDenied,
  scopeWhere,
  type ScopeMapping,
  type ScopeRegistry,
  type Where,
} from './scoped-models.js';
import type { ResolvedScope } from './scope.js';

/**
 * Scope enforcement in the data-access layer (Spec P1 §12.3, P4 §4.2): a Prisma client extension that
 * filters EVERY query on a registered model by the current request's scope. A scoped query written
 * without the filter is impossible rather than discouraged:
 *
 *   reads (findMany, findFirst, findUnique, count, aggregate, groupBy) → out-of-scope rows are absent,
 *     so a single record outside scope is "not found" → 404 (P4 §4.3), and aggregates cannot leak
 *   update / delete (one or many)  → out-of-scope rows are not matched → 404
 *   create / createMany / upsert   → a record outside scope is refused → 403 SCOPE_DENIED
 *   no scope in context            → the query THROWS (a 500, found in development), unless the code
 *                                    runs inside runUnscoped(reason) (seeders, jobs)
 *
 * Limits, by design and documented for module authors (src/modules/README.md):
 *   - nested reads (`include`/`select` of a scoped relation) and nested writes are not filtered: read a
 *     scoped model from its own top-level query
 *   - raw SQL is not filtered: use scopeSql() from ./sql.ts in every raw query on scoped tables
 */

const WHERE_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
]);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

const asList = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

function withFilter(where: unknown, filter: Where): Where {
  const base = (where ?? {}) as Where;
  if (filter === NOTHING) {
    // Prisma reads an empty OR as "no row" ONLY at the top level of a where; nested inside AND it is
    // silently dropped, which would fail open. So "nothing" goes on top, and any OR already there moves
    // into the AND.
    const { OR: existingOr, AND: existingAnd, ...rest } = base;
    const and = [...asList(existingAnd), ...(existingOr === undefined ? [] : [{ OR: existingOr }])];
    return { ...rest, ...(and.length > 0 ? { AND: and } : {}), OR: [] };
  }
  // Unique fields stay at the top level, so findUnique/update/delete keep a valid unique selector.
  return { ...base, AND: [...asList(base.AND), filter] };
}

function assertCreatable(scope: ResolvedScope, mapping: ScopeMapping, data: unknown): void {
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !canCreate(scope, mapping, row as Record<string, unknown>)) {
      throw scopeDenied();
    }
  }
}

/** Rewrites one operation's arguments for the scope. Pure, so it is unit-tested directly. */
export function applyScope(
  model: string,
  operation: string,
  args: Record<string, unknown>,
  scope: ResolvedScope,
  mapping: ScopeMapping,
): Record<string, unknown> {
  const filter = scopeWhere(scope, mapping);
  if (WHERE_OPERATIONS.has(operation)) {
    return filter ? { ...args, where: withFilter(args.where, filter) } : args;
  }
  if (CREATE_OPERATIONS.has(operation)) {
    assertCreatable(scope, mapping, args.data);
    return args;
  }
  if (operation === 'upsert') {
    assertCreatable(scope, mapping, args.create);
    return filter ? { ...args, where: withFilter(args.where, filter) } : args;
  }
  // Fail closed: an operation this extension does not understand is never run unfiltered.
  throw new Error(`scope: operation ${operation} on scoped model ${model} is not supported`);
}

export function scopeExtension(registry: ScopeRegistry) {
  return Prisma.defineExtension({
    name: 'rupai-data-scope',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const mapping = registry.get(model);
          if (!mapping) return query(args);
          const ctx = getRequestContext();
          if (ctx?.unscoped) return query(args);
          if (!ctx?.loadScope) {
            throw new Error(
              `${model}.${operation} is scoped but no data scope is set: declare auth on the route, or wrap system work in runUnscoped(reason)`,
            );
          }
          const scope = await ctx.loadScope();
          return query(applyScope(model, operation, args, scope, mapping));
        },
      },
    },
  });
}
