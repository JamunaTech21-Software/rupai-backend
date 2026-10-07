import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors/app-error.js';
import { pickRule, type RuleCandidate } from '../../src/core/rules/resolve.js';
import { ruleTableSql, specificitySql } from '../../src/core/rules/rule-sql.js';
import { defineRuleTable, specificityOf, STANDARD_DIMENSIONS } from '../../src/core/rules/rule-table.js';
import { planActivation, type Span } from '../../src/core/rules/versions.js';
import type { BusinessDate } from '../../src/core/time/dates.js';

/**
 * Rule engine core (P1.06): the resolver's decision and the version timeline, as pure functions.
 * P9 §3 asks for resolver tests on specificity, transaction date and ambiguity; the worked examples of
 * P1 Figure 3.1 and P9 §3.2 are reproduced. tests/db/rules.test.ts checks the SQL agrees.
 */

const wage = defineRuleTable({ table: 'test_wage_rule', methods: ['daily', 'monthly'] });
const statutory = defineRuleTable({
  table: 'test_statutory_rule',
  methods: ['percentage'],
  partitions: [{ column: 'statutory_type', key: 'statutory_type', sqlType: 'VARCHAR(30)' }],
});

const d = (s: string) => s as BusinessDate;
let nextId = 1n;
function rule(
  scope: Partial<Record<'estate' | 'category' | 'activity_type' | 'season' | 'department', string>>,
  from: string,
  to: string | null = null,
  extra: Partial<RuleCandidate> = {},
): RuleCandidate {
  const full = Object.fromEntries(
    STANDARD_DIMENSIONS.map((dim) => [dim.key, scope[dim.key as keyof typeof scope] ?? null]),
  );
  const id = nextId++;
  return {
    id,
    ruleCode: `R${id.toString()}`,
    name: `rule ${id.toString()}`,
    specificity: specificityOf(wage, full),
    effectiveFrom: d(from),
    effectiveTo: to === null ? null : d(to),
    scope: full,
    partitions: {},
    ...extra,
  };
}

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error('expected an AppError');
}

describe('specificity (P1 §10.2, P9 Table 3.1)', () => {
  const rank = (scope: Record<string, string>) => specificityOf(wage, scope);

  it('orders the six P9 ranks exactly', () => {
    const ranks = [
      rank({ estate: '1', category: '2', activity_type: '3', season: '4' }), // 6
      rank({ estate: '1', category: '2', activity_type: '3' }), // 5
      rank({ estate: '1', category: '2' }), // 4
      rank({ category: '2', activity_type: '3' }), // 3
      rank({ category: '2' }), // 2
      rank({}), // 1: organisation default
    ];
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
    expect(new Set(ranks).size).toBe(6);
    expect(ranks.at(-1)).toBe(0);
  });

  it('gives every combination of dimensions its own rank, and the estate outweighs all others together', () => {
    const keys = STANDARD_DIMENSIONS.map((x) => x.key);
    const all = Array.from({ length: 2 ** keys.length }, (_, mask) =>
      rank(Object.fromEntries(keys.filter((_k, i) => mask & (1 << i)).map((k) => [k, '1']))),
    );
    expect(new Set(all).size).toBe(32);
    expect(rank({ estate: '1' })).toBeGreaterThan(
      rank({ category: '1', activity_type: '1', season: '1', department: '1' }),
    );
  });

  it('is the same expression the database generates', () => {
    expect(specificitySql(wage)).toBe(
      '(`scope_estate_id` IS NOT NULL) * 16 + (`scope_category_id` IS NOT NULL) * 8 + ' +
        '(`scope_activity_type_id` IS NOT NULL) * 4 + (`scope_season_id` IS NOT NULL) * 2 + ' +
        '(`scope_department_id` IS NOT NULL) * 1',
    );
  });
});

describe('rule resolution (P9 §3.1)', () => {
  it('resolves the version in force on the TRANSACTION date, not today (P1 Figure 3.1)', () => {
    const v1 = rule({ estate: '1', category: '7' }, '2024-01-01', '2025-03-31');
    const v2 = rule({ estate: '1', category: '7' }, '2025-04-01', '2026-02-28');
    const v3 = rule({ estate: '1', category: '7' }, '2026-03-01');
    const ctx = { estate: 1n, category: 7n };
    // January 2026 payroll resolves version 2, whether run in January or recomputed in September.
    expect(pickRule(wage, [v1, v2, v3], ctx, d('2026-01-15')).rule.id).toBe(v2.id);
    expect(pickRule(wage, [v1, v2, v3], ctx, d('2024-06-30')).rule.id).toBe(v1.id);
    expect(pickRule(wage, [v1, v2, v3], ctx, d('2026-09-01')).rule.id).toBe(v3.id);
  });

  it('includes both ends of an effective range', () => {
    const v = rule({}, '2025-04-01', '2026-02-28');
    expect(pickRule(wage, [v], {}, d('2025-04-01')).rule.id).toBe(v.id);
    expect(pickRule(wage, [v], {}, d('2026-02-28')).rule.id).toBe(v.id);
    expect(errorOf(() => pickRule(wage, [v], {}, d('2025-03-31'))).code).toBe('RULE_NOT_FOUND');
    expect(errorOf(() => pickRule(wage, [v], {}, d('2026-03-01'))).code).toBe('RULE_NOT_FOUND');
  });

  it('a more specific rule wins regardless of its effective date (P9 §3.2)', () => {
    const estateRuleLastYear = rule({ estate: '1', category: '7' }, '2025-01-01');
    const generalRuleYesterday = rule({ category: '7' }, '2026-06-01');
    const r = pickRule(
      wage,
      [generalRuleYesterday, estateRuleLastYear],
      { estate: 1n, category: 7n },
      d('2026-06-02'),
    );
    expect(r.rule.id).toBe(estateRuleLastYear.id);
    expect(r.candidates.map((c) => c.id)).toEqual([estateRuleLastYear.id, generalRuleYesterday.id]);
  });

  it('walks down the specificity order to the organisation default', () => {
    const def = rule({}, '2020-01-01');
    const cat = rule({ category: '7' }, '2020-01-01');
    const catAct = rule({ category: '7', activity_type: '3' }, '2020-01-01');
    const est = rule({ estate: '1', category: '7' }, '2020-01-01');
    const all = [def, cat, catAct, est];
    const on = d('2026-01-01');
    expect(pickRule(wage, all, { estate: 1n, category: 7n, activity_type: 3n }, on).rule.id).toBe(est.id);
    expect(pickRule(wage, all, { estate: 2n, category: 7n, activity_type: 3n }, on).rule.id).toBe(catAct.id);
    expect(pickRule(wage, all, { estate: 2n, category: 7n, activity_type: 9n }, on).rule.id).toBe(cat.id);
    expect(pickRule(wage, all, { estate: 2n, category: 8n }, on).rule.id).toBe(def.id);
  });

  it('never matches a rule naming a value the context does not have', () => {
    const seasonal = rule({ estate: '1', season: '2026' }, '2026-01-01');
    const def = rule({}, '2026-01-01');
    expect(pickRule(wage, [seasonal, def], { estate: 1n }, d('2026-03-01')).rule.id).toBe(def.id);
    expect(pickRule(wage, [seasonal, def], { estate: 2n, season: 2026n }, d('2026-03-01')).rule.id).toBe(
      def.id,
    );
    expect(pickRule(wage, [seasonal, def], { estate: 1n, season: 2026n }, d('2026-03-01')).rule.id).toBe(
      seasonal.id,
    );
  });

  it('RULE_NOT_FOUND names the table, the date and the context', () => {
    const err = errorOf(() =>
      pickRule(wage, [rule({ estate: '9' }, '2026-01-01')], { estate: 1n }, d('2026-03-01')),
    );
    expect(err.code).toBe('RULE_NOT_FOUND');
    expect(err.status).toBe(422);
    expect(err.details[0]?.context).toMatchObject({
      rule_table: 'test_wage_rule',
      date: '2026-03-01',
      context: { estate: '1' },
    });
  });

  it('RULE_AMBIGUOUS when two versions at the same specificity cover the date, naming both', () => {
    const a = rule({ estate: '1', category: '7' }, '2026-01-01');
    const b = rule({ estate: '1', category: '7' }, '2026-02-01'); // a never closed: an overlap
    const err = errorOf(() => pickRule(wage, [a, b], { estate: 1n, category: 7n }, d('2026-03-01')));
    expect(err.code).toBe('RULE_AMBIGUOUS');
    expect(err.status).toBe(422);
    expect(err.details.map((x) => x.context?.rule_id)).toEqual([b.id.toString(), a.id.toString()]);
    expect(err.details[0]?.context).toMatchObject({
      effective_from: '2026-02-01',
      scope: { estate: '1', category: '7' },
    });
  });

  it('is not ambiguous when the tie is below the winner', () => {
    const general1 = rule({ category: '7' }, '2026-01-01');
    const general2 = rule({ category: '7' }, '2026-01-01');
    const specific = rule({ estate: '1', category: '7' }, '2026-01-01');
    expect(
      pickRule(wage, [general1, general2, specific], { estate: 1n, category: 7n }, d('2026-03-01')).rule.id,
    ).toBe(specific.id);
  });

  it('only rules of the same partition compete, and the partition must be named', () => {
    const pf = rule({}, '2026-01-01', null, { partitions: { statutory_type: 'provident_fund' } });
    const gratuity = rule({}, '2026-01-01', null, { partitions: { statutory_type: 'gratuity' } });
    expect(pickRule(statutory, [pf, gratuity], { statutory_type: 'gratuity' }, d('2026-03-01')).rule.id).toBe(
      gratuity.id,
    );
    expect(() => pickRule(statutory, [pf], {}, d('2026-03-01'))).toThrow(/must name statutory_type/);
  });

  it('refuses context keys the table does not have, and dates that are not dates', () => {
    expect(() => pickRule(wage, [], { estat: 1n }, d('2026-03-01'))).toThrow(/unknown context keys estat/);
    expect(() => pickRule(wage, [], {}, d('2026-02-30'))).toThrow(RangeError);
  });
});

describe('version timeline on approval (P1 §3.2, P2 §2.10)', () => {
  const span = (id: bigint, from: string, to: string | null = null): Span => ({
    id,
    effectiveFrom: d(from),
    effectiveTo: to === null ? null : d(to),
  });
  const next = (from: string, to: string | null, supersedesId: bigint | null) => ({
    ...span(99n, from, to),
    supersedesId,
  });

  it('a first version with nothing around it changes nothing', () => {
    expect(planActivation(next('2026-03-01', null, null), [])).toEqual({
      closes: [],
      supersedes: [],
      conflicts: [],
    });
  });

  it('closes the superseded version the day before the new one starts (the P1 Figure 3.1 chain)', () => {
    const v2 = span(2n, '2025-04-01');
    expect(planActivation(next('2026-03-01', null, 2n), [span(1n, '2024-01-01', '2025-03-31'), v2])).toEqual({
      closes: [{ id: 2n, effectiveTo: '2026-02-28' }],
      supersedes: [],
      conflicts: [],
    });
  });

  it('marks the superseded version superseded when the new one covers it entirely (a correction from the same date)', () => {
    expect(planActivation(next('2025-04-01', null, 2n), [span(2n, '2025-04-01')]).supersedes).toEqual([2n]);
    expect(
      planActivation(next('2025-03-01', '2025-12-31', 2n), [span(2n, '2025-04-01', '2025-10-31')]).supersedes,
    ).toEqual([2n]);
  });

  it('refuses any other overlap at the same scope', () => {
    const p = planActivation(next('2026-03-01', null, null), [span(2n, '2025-04-01')]);
    expect(p.conflicts).toEqual([{ span: span(2n, '2025-04-01'), reason: 'overlaps' }]);
    // Superseding the latest version from before its start also overlaps its predecessor.
    const q = planActivation(next('2025-01-01', null, 2n), [
      span(1n, '2024-01-01', '2025-03-31'),
      span(2n, '2025-04-01'),
    ]);
    expect(q.supersedes).toEqual([2n]);
    expect(q.conflicts.map((c) => [c.span.id, c.reason])).toEqual([[1n, 'overlaps']]);
  });

  it('refuses to split the superseded version, or to replace only part of it', () => {
    expect(
      planActivation(next('2026-04-10', '2026-04-16', 2n), [span(2n, '2025-04-01')]).conflicts[0]?.reason,
    ).toBe('split_required');
    expect(
      planActivation(next('2025-04-01', '2025-12-31', 2n), [span(2n, '2025-04-01')]).conflicts[0]?.reason,
    ).toBe('partial_replacement');
  });

  it('a bounded new version may close a bounded one that ends inside it', () => {
    expect(
      planActivation(next('2026-03-01', '2026-12-31', 2n), [span(2n, '2026-01-01', '2026-06-30')]).closes,
    ).toEqual([{ id: 2n, effectiveTo: '2026-02-28' }]);
  });

  it('adjacent and earlier-closed versions do not overlap', () => {
    expect(planActivation(next('2026-03-01', null, null), [span(2n, '2025-04-01', '2026-02-28')])).toEqual({
      closes: [],
      supersedes: [],
      conflicts: [],
    });
  });
});

describe('the rule block DDL (P3 §17.1)', () => {
  it('generates specificity and the active scope key, and grants UPDATE only', () => {
    const sql = ruleTableSql(statutory);
    expect(sql).toContain('`specificity` SMALLINT UNSIGNED GENERATED ALWAYS AS (');
    expect(sql).toContain(
      "`active_key` VARCHAR(255) GENERATED ALWAYS AS (CASE WHEN `state` = 'active' THEN CONCAT_WS('|', `statutory_type`, IFNULL(`scope_estate_id`, '*')",
    );
    expect(sql).toContain('UNIQUE INDEX `ux_test_statutory_rule_scope_from`(`active_key`)');
    expect(sql).toContain(
      'INDEX `ix_test_statutory_rule_resolution`(`statutory_type`, `specificity`, `effective_from`, `effective_to`, `state`)',
    );
    expect(sql).toContain("CHECK (`method` IN ('percentage'))");
    expect(sql).toContain("GRANT UPDATE ON `test_statutory_rule` TO 'rupai_app'@'%';");
    expect(sql).not.toMatch(/GRANT[^;]*DELETE/);
    expect(sql).not.toContain('deleted_at');
  });

  it('requires the module columns to match extraColumns exactly', () => {
    const t = defineRuleTable({ table: 'test_x_rule', methods: ['daily'], extraColumns: ['base_rate'] });
    expect(ruleTableSql(t, ['`base_rate` DECIMAL(18,4) NOT NULL'])).toContain(
      '`base_rate` DECIMAL(18,4) NOT NULL,',
    );
    expect(() => ruleTableSql(t)).toThrow(/missing base_rate/);
    expect(() => ruleTableSql(t, ['`base_rate` DECIMAL(18,4)', '`other` INT'])).toThrow(/unexpected other/);
  });

  it('refuses a table definition the block cannot serve', () => {
    expect(() => defineRuleTable({ table: 'Bad-Name', methods: ['x'] })).toThrow(/snake_case/);
    expect(() => defineRuleTable({ table: 'x_rule', methods: [] })).toThrow(/at least one method/);
    expect(() =>
      defineRuleTable({
        table: 'x_rule',
        methods: ['x'],
        dimensions: [{ column: 'scope_broker_id', key: 'broker', sqlType: 'BIGINT UNSIGNED' }],
      }),
    ).toThrow(/scope_estate_id must be a dimension/);
  });

  it('audits every field of a policy record', () => {
    expect(wage.audit.class).toBe('policy');
    expect(wage.audit.fields).toEqual(
      expect.arrayContaining([
        'effective_from',
        'effective_to',
        'parameters',
        'scope_estate_id',
        'is_retrospective',
      ]),
    );
  });
});
