import { AppError } from '../errors/app-error.js';
import type { ResolvedScope } from './scope.js';

/**
 * How each SCOPED model maps onto the scope dimensions (Spec P1 §12.3, P4 §4.2).
 *
 * A model is registered once, by the epic that creates it, and from then on every Prisma query on it is
 * filtered by the scope extension (extension.ts). Unregistered models are organisation-tier: never
 * filtered.
 *
 *   SCOPED_MODELS.register('PluckingWorkRecord', {
 *     estate: byColumn('estateId'),
 *     division: (ids) => ({ field: { section: { divisionId: { in: ids } } } }),   // through a relation
 *     section: (ids) => ({ field: { sectionId: { in: ids } } }),
 *     self: byColumn('employmentProfileId'),
 *   });
 *
 * A dimension the model does not map is simply not a way in: a user whose only grant is a facility sees
 * no plucking records. Facility-tier models map `estate` through the origin of the material they handle
 * (P6 §4.2), which is the one place where scope is not a plain column comparison.
 */

export type Where = Record<string, unknown>;

/** Builds the Prisma `where` for a set of granted ids. `column` is set for plain-column mappings. */
export interface DimensionMapping {
  (ids: readonly bigint[]): Where;
  readonly column?: string;
}

export interface ScopeMapping {
  readonly estate?: DimensionMapping;
  readonly division?: DimensionMapping;
  readonly section?: DimensionMapping;
  /** Department grants apply within the user's estates (P1 §12.2: "across scoped estates"). */
  readonly department?: DimensionMapping;
  readonly facility?: DimensionMapping;
  /** The employment profile the record is about (implicit self scope). */
  readonly self?: DimensionMapping;
}

/** A plain column comparison: `{ [field]: { in: ids } }`. Also lets creates be checked. */
export function byColumn(field: string): DimensionMapping {
  return Object.assign((ids: readonly bigint[]) => ({ [field]: { in: [...ids] } }), { column: field });
}

export class ScopeRegistry {
  readonly #models = new Map<string, ScopeMapping>();

  register(model: string, mapping: ScopeMapping): this {
    if (this.#models.has(model)) throw new Error(`scope mapping for ${model} is already registered`);
    if (Object.keys(mapping).length === 0) throw new Error(`scope mapping for ${model} maps no dimension`);
    this.#models.set(model, mapping);
    return this;
  }

  get(model: string): ScopeMapping | undefined {
    return this.#models.get(model);
  }

  get models(): string[] {
    return [...this.#models.keys()];
  }
}

/** The application's registry. Each epic registers its scoped models at module load. */
export const SCOPED_MODELS = new ScopeRegistry();

/**
 * Matches nothing. Prisma treats an empty OR as false only at the TOP level of a where (nested inside
 * AND it is dropped), so the extension recognises this exact object and places it on top.
 */
export const NOTHING: Where = Object.freeze({ OR: [] });

/**
 * The filter a scope imposes on a model: null when unrestricted (all_estates), NOTHING when no grant
 * reaches it, otherwise the OR of every dimension the user holds and the model maps.
 */
export function scopeWhere(scope: ResolvedScope, mapping: ScopeMapping): Where | null {
  if (scope.allEstates) return null;
  const any: Where[] = [];
  if (scope.estates.length > 0 && mapping.estate) any.push(mapping.estate(scope.estates));
  if (scope.divisions.length > 0 && mapping.division) any.push(mapping.division(scope.divisions));
  if (scope.sections.length > 0 && mapping.section) any.push(mapping.section(scope.sections));
  if (scope.departments.length > 0 && mapping.department) {
    const dept = mapping.department(scope.departments);
    if (!mapping.estate) any.push(dept);
    else if (scope.estates.length > 0) any.push({ AND: [dept, mapping.estate(scope.estates)] });
  }
  if (scope.facilities.length > 0 && mapping.facility) any.push(mapping.facility(scope.facilities));
  if (scope.selfEmploymentProfileId !== null && mapping.self)
    any.push(mapping.self([scope.selfEmploymentProfileId]));
  return any.length === 0 ? NOTHING : { OR: any };
}

const toBigInt = (v: unknown): bigint | null => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return null;
};

/**
 * Whether a record about to be CREATED falls inside the scope. Only plain-column mappings can be
 * judged from the data; a model scoped through relations checks its creates in its service instead.
 */
export function canCreate(
  scope: ResolvedScope,
  mapping: ScopeMapping,
  data: Record<string, unknown>,
): boolean {
  if (scope.allEstates) return true;
  const has = (dim: DimensionMapping | undefined, ids: readonly bigint[]) => {
    if (!dim?.column || ids.length === 0) return false;
    const v = toBigInt(data[dim.column]);
    return v !== null && ids.includes(v);
  };
  const self = scope.selfEmploymentProfileId === null ? [] : [scope.selfEmploymentProfileId];
  return (
    has(mapping.estate, scope.estates) ||
    has(mapping.division, scope.divisions) ||
    has(mapping.section, scope.sections) ||
    (has(mapping.department, scope.departments) && (!mapping.estate || has(mapping.estate, scope.estates))) ||
    has(mapping.facility, scope.facilities) ||
    has(mapping.self, self)
  );
}

export function scopeDenied(): AppError {
  return new AppError('SCOPE_DENIED', 'This record is outside your data scope.', [
    { code: 'SCOPE_DENIED', message: 'Ask an administrator for access to this estate or facility.' },
  ]);
}
