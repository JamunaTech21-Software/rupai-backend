import { describe, expect, it } from 'vitest';

import { runWithRequestContext, getRequestContext } from '../../src/core/context/request-context.js';
import { AppError } from '../../src/core/errors/app-error.js';
import { applyScope } from '../../src/core/scope/extension.js';
import {
  ALL_ESTATES_SCOPE,
  EMPTY_SCOPE,
  runUnscoped,
  scopeFromGrants,
  scopeView,
  type ResolvedScope,
} from '../../src/core/scope/scope.js';
import {
  byColumn,
  canCreate,
  NOTHING,
  ScopeRegistry,
  scopeWhere,
  type ScopeMapping,
} from '../../src/core/scope/scoped-models.js';
import { scopeSql } from '../../src/core/scope/sql.js';

const scope = (s: Partial<ResolvedScope>): ResolvedScope => ({ ...EMPTY_SCOPE, ...s });

const ESTATE_TIER: ScopeMapping = {
  estate: byColumn('estateId'),
  division: byColumn('divisionId'),
  section: byColumn('sectionId'),
  department: byColumn('departmentId'),
  self: byColumn('employmentProfileId'),
};
const FACILITY_TIER: ScopeMapping = {
  facility: byColumn('factoryId'),
  // Estate users see the part of a factory's work that came from their estates (P6 §4.2).
  estate: (ids) => ({ consumption: { some: { originEstateId: { in: [...ids] } } } }),
};

describe('scope resolution (P6 §4.2)', () => {
  it('is the union of the grants, de-duplicated and sorted', () => {
    const s = scopeFromGrants(
      [
        { scopeType: 'estate', scopeId: 3n },
        { scopeType: 'estate', scopeId: 1n },
        { scopeType: 'estate', scopeId: 3n },
        { scopeType: 'facility', scopeId: 9n },
        { scopeType: 'division', scopeId: 4n },
      ],
      77n,
    );
    expect(s).toMatchObject({ allEstates: false, estates: [1n, 3n], divisions: [4n], facilities: [9n] });
    expect(s.selfEmploymentProfileId).toBe(77n);
    expect(scopeView(s)).toEqual({
      all_estates: false,
      estates: ['1', '3'],
      divisions: ['4'],
      sections: [],
      departments: [],
      facilities: ['9'],
      self_employment_profile_id: '77',
    });
  });

  it('all_estates subsumes everything', () => {
    const s = scopeFromGrants(
      [
        { scopeType: 'all_estates', scopeId: null },
        { scopeType: 'estate', scopeId: 1n },
      ],
      null,
    );
    expect(s.allEstates).toBe(true);
    expect(scopeWhere(s, ESTATE_TIER)).toBeNull();
  });
});

describe('scopeWhere: the filter a scope imposes on a model', () => {
  it('matches nothing without a grant that reaches the model', () => {
    expect(scopeWhere(EMPTY_SCOPE, ESTATE_TIER)).toEqual(NOTHING);
    // A facility grant is no way into estate-tier records that do not map facilities.
    expect(scopeWhere(scope({ facilities: [1n] }), ESTATE_TIER)).toEqual(NOTHING);
  });

  it('ORs every granted dimension the model maps', () => {
    expect(scopeWhere(scope({ estates: [1n, 2n], sections: [7n] }), ESTATE_TIER)).toEqual({
      OR: [{ estateId: { in: [1n, 2n] } }, { sectionId: { in: [7n] } }],
    });
  });

  it('applies a department grant only within the user’s estates', () => {
    expect(scopeWhere(scope({ departments: [5n] }), ESTATE_TIER)).toEqual(NOTHING);
    expect(scopeWhere(scope({ departments: [5n], estates: [1n] }), ESTATE_TIER)).toEqual({
      OR: [{ estateId: { in: [1n] } }, { AND: [{ departmentId: { in: [5n] } }, { estateId: { in: [1n] } }] }],
    });
  });

  it('gives every user their own records through implicit self', () => {
    expect(scopeWhere(scope({ selfEmploymentProfileId: 42n }), ESTATE_TIER)).toEqual({
      OR: [{ employmentProfileId: { in: [42n] } }],
    });
  });

  it('scopes facility-tier records by facility grant, or by the origin of the material', () => {
    expect(scopeWhere(scope({ estates: [1n] }), FACILITY_TIER)).toEqual({
      OR: [{ consumption: { some: { originEstateId: { in: [1n] } } } }],
    });
    expect(scopeWhere(scope({ facilities: [8n] }), FACILITY_TIER)).toEqual({
      OR: [{ factoryId: { in: [8n] } }],
    });
  });
});

describe('canCreate', () => {
  const s = scope({ estates: [1n], departments: [5n], selfEmploymentProfileId: 42n });
  it('allows a record inside the scope and refuses one outside it', () => {
    expect(canCreate(s, ESTATE_TIER, { estateId: 1n })).toBe(true);
    expect(canCreate(s, ESTATE_TIER, { estateId: '1' })).toBe(true);
    expect(canCreate(s, ESTATE_TIER, { estateId: 2n })).toBe(false);
    expect(canCreate(s, ESTATE_TIER, { estateId: 2n, employmentProfileId: 42n })).toBe(true);
    expect(canCreate(s, ESTATE_TIER, {})).toBe(false);
    expect(canCreate(ALL_ESTATES_SCOPE, ESTATE_TIER, { estateId: 999n })).toBe(true);
  });

  it('cannot judge a relation-based mapping from the data, so refuses (the service checks instead)', () => {
    expect(canCreate(scope({ estates: [1n] }), FACILITY_TIER, { factoryId: 8n })).toBe(false);
  });
});

describe('applyScope: rewriting each Prisma operation', () => {
  const s = scope({ estates: [1n] });
  const filter = { OR: [{ estateId: { in: [1n] } }] };

  it('filters reads, aggregates and bulk writes', () => {
    for (const op of ['findMany', 'findFirst', 'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany']) {
      expect(applyScope('M', op, { where: { status: 'x' } }, s, ESTATE_TIER)).toEqual({
        where: { status: 'x', AND: [filter] },
      });
    }
    expect(applyScope('M', 'findMany', {}, s, ESTATE_TIER)).toEqual({ where: { AND: [filter] } });
  });

  it('keeps a unique selector at the top level and merges an existing AND', () => {
    expect(applyScope('M', 'findUnique', { where: { id: 5n, AND: { a: 1 } } }, s, ESTATE_TIER)).toEqual({
      where: { id: 5n, AND: [{ a: 1 }, filter] },
    });
    expect(applyScope('M', 'update', { where: { id: 5n }, data: { x: 1 } }, s, ESTATE_TIER)).toEqual({
      where: { id: 5n, AND: [filter] },
      data: { x: 1 },
    });
  });

  it('puts "nothing" at the top level, where Prisma honours an empty OR', () => {
    expect(
      applyScope('M', 'findMany', { where: { status: 'x', OR: [{ a: 1 }] } }, EMPTY_SCOPE, ESTATE_TIER),
    ).toEqual({
      where: { status: 'x', AND: [{ OR: [{ a: 1 }] }], OR: [] },
    });
    expect(applyScope('M', 'findUnique', { where: { id: 1n } }, EMPTY_SCOPE, ESTATE_TIER)).toEqual({
      where: { id: 1n, OR: [] },
    });
  });

  it('leaves the query alone for all_estates', () => {
    const args = { where: { id: 1n } };
    expect(applyScope('M', 'findUnique', args, ALL_ESTATES_SCOPE, ESTATE_TIER)).toBe(args);
  });

  it('refuses a create outside the scope with 403 SCOPE_DENIED', () => {
    expect(() => applyScope('M', 'create', { data: { estateId: 2n } }, s, ESTATE_TIER)).toThrow(AppError);
    try {
      applyScope('M', 'createMany', { data: [{ estateId: 1n }, { estateId: 2n }] }, s, ESTATE_TIER);
    } catch (e) {
      expect((e as AppError).code).toBe('SCOPE_DENIED');
      expect((e as AppError).status).toBe(403);
    }
    expect(applyScope('M', 'create', { data: { estateId: 1n } }, s, ESTATE_TIER)).toEqual({
      data: { estateId: 1n },
    });
  });

  it('checks both halves of an upsert', () => {
    expect(() =>
      applyScope('M', 'upsert', { where: { id: 1n }, create: { estateId: 2n }, update: {} }, s, ESTATE_TIER),
    ).toThrow(/outside your data scope/);
  });

  it('fails closed on an operation it does not understand', () => {
    expect(() => applyScope('M', 'findRaw', {}, s, ESTATE_TIER)).toThrow(/not supported/);
  });
});

describe('scopeSql: the filter for raw queries', () => {
  it('builds a parameterised OR, and constant fragments for all and nothing', () => {
    const q = scopeSql(scope({ estates: [1n, 2n], selfEmploymentProfileId: 9n }), {
      estate: 'pwr.estate_id',
      self: 'pwr.employment_profile_id',
    });
    expect(q.sql).toBe('(`pwr`.`estate_id` IN (?,?) OR `pwr`.`employment_profile_id` = ?)');
    expect(q.values).toEqual([1n, 2n, 9n]);
    expect(scopeSql(ALL_ESTATES_SCOPE, { estate: 'estate_id' }).sql).toBe('(1 = 1)');
    expect(scopeSql(EMPTY_SCOPE, { estate: 'estate_id' }).sql).toBe('(1 = 0)');
  });

  it('refuses an unsafe column reference', () => {
    expect(() => scopeSql(scope({ estates: [1n] }), { estate: 'estate_id; DROP TABLE x' })).toThrow(/unsafe/);
  });
});

describe('registry and runUnscoped', () => {
  it('registers each model once, with at least one dimension', () => {
    const r = new ScopeRegistry().register('A', { estate: byColumn('estateId') });
    expect(r.get('A')).toBeDefined();
    expect(() => r.register('A', { estate: byColumn('estateId') })).toThrow(/already/);
    expect(() => r.register('B', {})).toThrow(/no dimension/);
  });

  it('runUnscoped needs a reason and marks the context', async () => {
    await expect(runUnscoped(' ', () => 1)).rejects.toThrow(/reason/);
    await runWithRequestContext({ requestId: 'r1' }, async () => {
      await runUnscoped('nightly check', () => {
        expect(getRequestContext()).toMatchObject({ requestId: 'r1', unscoped: 'nightly check' });
      });
      expect(getRequestContext()?.unscoped).toBeUndefined();
    });
  });

  it('runUnscoped runs a lazy (thenable) query inside the context', async () => {
    let seen: string | undefined;
    const lazy = {
      then: (resolve: (v: number) => void) => {
        seen = getRequestContext()?.unscoped;
        resolve(1);
      },
    };
    expect(await runUnscoped('lazy', () => lazy as unknown as Promise<number>)).toBe(1);
    expect(seen).toBe('lazy');
  });
});
