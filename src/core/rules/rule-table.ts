import type { AuditedRecord } from '../audit/audit.js';

/**
 * The shape every effective-dated rule table shares (Spec P3 §17.1, the "rule block"), described once so
 * one resolver and one version service serve wage, incentive, overtime, statutory and charge rules alike.
 *
 * A concrete table (wage_rule, statutory_rule, …) arrives with its module. It declares itself with
 * `defineRuleTable`, creates its table from `ruleTableSql` (rule-sql.ts) and registers in
 * src/modules/rule-tables.ts, where a test checks the real table still has the block.
 *
 * SPECIFICITY (P1 §10.2, P9 §3.2). Each scope dimension carries a power-of-two weight, most significant
 * first: estate 16, category 8, activity type 4, season 2, department 1 for the standard block. A rule's
 * specificity is the sum of the weights of the dimensions it names. That reproduces P9 Table 3.1's order
 * exactly (estate+category+activity+season 30 > estate+category+activity 28 > estate+category 24 >
 * category+activity 12 > category 8 > organisation default 0) and extends it to every other combination
 * without a tie between two different shapes. It is a STORED generated column in MySQL, so it can never
 * disagree with the scope columns.
 */

export const RULE_STATES = ['draft', 'submitted', 'active', 'rejected', 'superseded'] as const;
export type RuleState = (typeof RULE_STATES)[number];

/** P3 §17.1 rounding_mode. */
export const ROUNDING_MODES = ['half_up', 'half_down', 'up', 'down', 'none'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

/** A scope column. NULL on a rule means "any"; a rule naming it applies only to that value. */
export interface RuleDimension {
  /** Column on the rule table, snake_case: scope_estate_id. */
  readonly column: string;
  /** Key in a resolution context and in the API: estate. */
  readonly key: string;
  /** Column type for the DDL helper. */
  readonly sqlType: string;
}

/**
 * A partition column: never a wildcard. Resolution always names it, and only rules with that exact value
 * compete (statutory_rule.statutory_type, charge_rule.charge_type_id).
 */
export type RulePartition = RuleDimension;

export const STANDARD_DIMENSIONS: readonly RuleDimension[] = [
  { column: 'scope_estate_id', key: 'estate', sqlType: 'BIGINT UNSIGNED' },
  { column: 'scope_category_id', key: 'category', sqlType: 'BIGINT UNSIGNED' },
  { column: 'scope_activity_type_id', key: 'activity_type', sqlType: 'BIGINT UNSIGNED' },
  { column: 'scope_season_id', key: 'season', sqlType: 'BIGINT UNSIGNED' },
  { column: 'scope_department_id', key: 'department', sqlType: 'BIGINT UNSIGNED' },
];

/** The estate dimension: the one that decides data scope (P3 §17.1: NULL means organisation-wide). */
export const ESTATE_DIMENSION = 'scope_estate_id';

/** Block columns a version carries besides scope and partitions, in API (snake_case) names. */
export const RULE_BLOCK_FIELDS = [
  'rule_code',
  'name',
  'method',
  'parameters',
  'currency_id',
  'rounding_mode',
  'rounding_precision',
  'effective_from',
  'effective_to',
  'is_retrospective',
  'supersedes_id',
  'notes',
] as const;

export interface RuleTable {
  readonly table: string;
  /** Scope dimensions, most significant first. Must include scope_estate_id. */
  readonly dimensions: readonly RuleDimension[];
  readonly partitions: readonly RulePartition[];
  /** The calculation methods this table permits (P1 §10.1: adding one is a deployment). */
  readonly methods: readonly string[];
  /** Columns the module adds beside the block (wage_rule.base_rate …), snake_case. */
  readonly extraColumns: readonly string[];
  /** Policy-class audit: every field (P1 Table 13.1). */
  readonly audit: AuditedRecord;
}

const IDENT = /^[a-z][a-z0-9_]{0,63}$/;

export function defineRuleTable(def: {
  table: string;
  methods: readonly string[];
  dimensions?: readonly RuleDimension[];
  partitions?: readonly RulePartition[];
  extraColumns?: readonly string[];
}): RuleTable {
  const dimensions = def.dimensions ?? STANDARD_DIMENSIONS;
  const partitions = def.partitions ?? [];
  const extraColumns = def.extraColumns ?? [];
  const columns = [...dimensions, ...partitions].map((d) => d.column);
  const problems: string[] = [];
  for (const name of [def.table, ...columns, ...extraColumns]) {
    if (!IDENT.test(name)) problems.push(`not a snake_case identifier: ${name}`);
  }
  if (!dimensions.some((d) => d.column === ESTATE_DIMENSION)) {
    problems.push(`${ESTATE_DIMENSION} must be a dimension`);
  }
  if (dimensions.length > 15) problems.push('at most 15 dimensions (specificity is a SMALLINT)');
  const keys = [...dimensions, ...partitions].map((d) => d.key);
  if (new Set(keys).size !== keys.length) problems.push('dimension and partition keys must be unique');
  if (new Set([...columns, ...extraColumns]).size !== columns.length + extraColumns.length) {
    problems.push('column names must be unique');
  }
  if (def.methods.length === 0) problems.push('at least one method');
  if (problems.length > 0) throw new Error(`rule table ${def.table}: ${problems.join('; ')}`);
  return Object.freeze({
    table: def.table,
    dimensions,
    partitions,
    methods: def.methods,
    extraColumns,
    audit: {
      type: def.table,
      class: 'policy' as const,
      fields: [
        ...RULE_BLOCK_FIELDS,
        ...partitions.map((p) => p.column),
        ...dimensions.map((d) => d.column),
        ...extraColumns,
      ],
    },
  });
}

/** The weight of dimension i: 2^(n−1−i), so the first dimension outweighs all later ones together. */
export function dimensionWeight(table: RuleTable, index: number): number {
  return 2 ** (table.dimensions.length - 1 - index);
}

/** Specificity of a scope: the sum of the weights of the dimensions it names (non-null). */
export function specificityOf(table: RuleTable, scope: Readonly<Record<string, unknown>>): number {
  return table.dimensions.reduce(
    (sum, d, i) =>
      scope[d.key] === null || scope[d.key] === undefined ? sum : sum + dimensionWeight(table, i),
    0,
  );
}
