import { getRequestContext, runWithRequestContext } from '../context/request-context.js';

/**
 * Data scope (Spec P1 §12.2, P6 §4, P3 §28.2): WHICH records a user may touch. Permission (P1.01)
 * decides WHAT they may do. Both must pass.
 *
 *   - A user holds grants; the effective scope is their UNION (P6 §4.2).
 *   - all_estates is unrestricted. A narrower grant beside it changes nothing.
 *   - self is implicit for every user (P6 §6.1): records about their own employment profile.
 *   - Expired grants confer nothing, and a disabled user has no scope at all.
 *   - Organisation-tier records (users, roles, chart of accounts, buyers…) are outside scope entirely.
 *
 * The scope is resolved lazily, at most once per request, the first time a scoped query needs it.
 */

export const SCOPE_TYPES = [
  'all_estates',
  'estate',
  'division',
  'section',
  'department',
  'factory',
  'warehouse',
  'self',
] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

/** Types that name a target record (scope_id). all_estates and self name none. */
/**
 * Facility grants name a factory or a warehouse (P6: "facility — one or more factories / warehouses").
 * They are two types, not P3's single `facility`, because factory and warehouse ids are separate
 * sequences: `facility 5` would not say which (BACKLOG D-1.08-1).
 */
export const TARGETED_SCOPE_TYPES = [
  'estate',
  'division',
  'section',
  'department',
  'factory',
  'warehouse',
] as const;
export type TargetedScopeType = (typeof TARGETED_SCOPE_TYPES)[number];

/** self is held by every user implicitly, so it is never granted (P6 §6.1). */
export const GRANTABLE_SCOPE_TYPES = ['all_estates', ...TARGETED_SCOPE_TYPES] as const;

export interface ResolvedScope {
  readonly allEstates: boolean;
  readonly estates: readonly bigint[];
  readonly divisions: readonly bigint[];
  readonly sections: readonly bigint[];
  readonly departments: readonly bigint[];
  readonly factories: readonly bigint[];
  readonly warehouses: readonly bigint[];
  /** The user's own employment profile (implicit self scope), if they are an employee. */
  readonly selfEmploymentProfileId: bigint | null;
}

export const EMPTY_SCOPE: ResolvedScope = Object.freeze({
  allEstates: false,
  estates: [],
  divisions: [],
  sections: [],
  departments: [],
  factories: [],
  warehouses: [],
  selfEmploymentProfileId: null,
});

/** Unrestricted. Tests and documentation only. */
export const ALL_ESTATES_SCOPE: ResolvedScope = Object.freeze({ ...EMPTY_SCOPE, allEstates: true });

/** The union of a user's live grants. */
export function scopeFromGrants(
  grants: readonly { scopeType: string; scopeId: bigint | null }[],
  selfEmploymentProfileId: bigint | null,
): ResolvedScope {
  const lists: Record<TargetedScopeType, Set<bigint>> = {
    estate: new Set(),
    division: new Set(),
    section: new Set(),
    department: new Set(),
    factory: new Set(),
    warehouse: new Set(),
  };
  let allEstates = false;
  for (const g of grants) {
    if (g.scopeType === 'all_estates') allEstates = true;
    else if (g.scopeId !== null && g.scopeType in lists)
      lists[g.scopeType as TargetedScopeType].add(g.scopeId);
  }
  const sorted = (s: Set<bigint>) => [...s].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.freeze({
    allEstates,
    estates: sorted(lists.estate),
    divisions: sorted(lists.division),
    sections: sorted(lists.section),
    departments: sorted(lists.department),
    factories: sorted(lists.factory),
    warehouses: sorted(lists.warehouse),
    selfEmploymentProfileId,
  });
}

/** The scope as the API shows it (`/auth/me`, `meta.applied_scope`). Ids as strings. */
export interface ScopeView {
  all_estates: boolean;
  estates: string[];
  divisions: string[];
  sections: string[];
  departments: string[];
  factories: string[];
  warehouses: string[];
  self_employment_profile_id: string | null;
}

export function scopeView(scope: ResolvedScope): ScopeView {
  const s = (ids: readonly bigint[]) => ids.map(String);
  return {
    all_estates: scope.allEstates,
    estates: s(scope.estates),
    divisions: s(scope.divisions),
    sections: s(scope.sections),
    departments: s(scope.departments),
    factories: s(scope.factories),
    warehouses: s(scope.warehouses),
    self_employment_profile_id: scope.selfEmploymentProfileId?.toString() ?? null,
  };
}

/**
 * The current request's scope. Resolved on first use and kept for the rest of the request.
 * @throws when nothing set up a scope: a route without `auth`, or code outside a request.
 */
export async function currentScope(): Promise<ResolvedScope> {
  const ctx = getRequestContext();
  if (!ctx?.loadScope) {
    throw new Error(
      'No data scope in this context: the route needs auth, or use runUnscoped() for system work',
    );
  }
  return ctx.loadScope();
}

/**
 * The scope a SERVICE checks a write against: the request's scope, or null inside runUnscoped (system
 * work: no restriction). Throws where no scope was set up, exactly like the extension.
 */
export async function scopeToCheck(): Promise<ResolvedScope | null> {
  const ctx = getRequestContext();
  if (ctx?.unscoped) return null;
  return currentScope();
}

/** The current scope as `meta.applied_scope` shows it. For list endpoints of scoped resources. */
export async function appliedScope(): Promise<ScopeView> {
  return scopeView(await currentScope());
}

/**
 * Runs `work` without scope filtering: seeders, scheduled jobs, the nightly consistency checks. Never
 * from a request handler acting for a user. The reason is required so each use is self-explaining.
 *
 * Always async, and awaits `work` INSIDE the unscoped context: Prisma queries are lazy and only run
 * when awaited, so returning an un-awaited query would run it outside the context (and be refused).
 */
export function runUnscoped<T>(reason: string, work: () => T | Promise<T>): Promise<T> {
  if (!reason.trim()) return Promise.reject(new Error('runUnscoped needs a reason'));
  const ctx = getRequestContext();
  return runWithRequestContext(
    { ...(ctx ?? { requestId: 'system' }), unscoped: reason },
    async () => await work(),
  );
}
