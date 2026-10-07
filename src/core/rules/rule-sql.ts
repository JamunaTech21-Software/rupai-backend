import { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../db/transaction.js';
import type { Database } from '../db/prisma.js';
import { dimensionWeight, ROUNDING_MODES, RULE_STATES, type RuleTable } from './rule-table.js';

/**
 * The rule block in SQL (Spec P3 §17.1, P2 §2.10): the migration helper every rule table is created from,
 * and the shape check that keeps it honest afterwards.
 *
 *   npx tsx scripts/rule-table-sql.ts <table>        prints a standard table, to paste into migration.sql
 *
 * What the block guarantees in the database itself:
 *   - specificity   STORED generated from the scope columns (rule-table.ts), so it cannot drift from them
 *   - active_key    STORED generated: partitions + scope + effective_from while the version is ACTIVE,
 *                   else NULL. Its unique index is P3's ux_rule_scope_from, and it also covers
 *                   organisation-wide rules (MySQL lets NULL scope columns repeat in a plain unique key)
 *   - CHECKs        effective_to ≥ effective_from, known state and rounding mode, a reason with a rejection
 *   - grants        UPDATE only. Versions are superseded, never deleted (P3 §17.1: no deleted_at)
 *
 * Overlapping ranges at the same scope cannot be a constraint in MySQL; versions.ts prevents them.
 * Foreign keys to scope targets (estate, season, …) are added by the module once those tables exist.
 */

const q = (name: string) => `\`${name}\``;
const list = (values: readonly string[]) => values.map((v) => `'${v}'`).join(', ');

/** The generated specificity expression for this table's dimensions. */
export function specificitySql(table: RuleTable): string {
  return table.dimensions
    .map((d, i) => `(${q(d.column)} IS NOT NULL) * ${String(dimensionWeight(table, i))}`)
    .join(' + ');
}

function activeKeySql(table: RuleTable): string {
  const parts = [
    ...table.partitions.map((p) => q(p.column)),
    ...table.dimensions.map((d) => `IFNULL(${q(d.column)}, '*')`),
    q('effective_from'),
  ];
  return `CASE WHEN ${q('state')} = 'active' THEN CONCAT_WS('|', ${parts.join(', ')}) END`;
}

const USER_COLUMNS = ['created_by', 'updated_by', 'submitted_by', 'approved_by', 'rejected_by'] as const;

/**
 * CREATE TABLE … for a rule table, with its foreign keys, CHECKs and grant.
 * @param extraColumnSql the module's own columns, one SQL definition each, e.g. "`base_rate` DECIMAL(18,4) NOT NULL".
 *   Every name in `table.extraColumns` must be defined here, and nothing else.
 */
export function ruleTableSql(table: RuleTable, extraColumnSql: readonly string[] = []): string {
  const t = table.table;
  const defined = extraColumnSql.map((c) => /^`([a-z][a-z0-9_]*)`/.exec(c.trim())?.[1]);
  const missing = table.extraColumns.filter((c) => !defined.includes(c));
  const unknown = defined.filter((c) => c === undefined || !table.extraColumns.includes(c));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${t}: extra columns must match extraColumns (missing ${missing.join(', ')}; unexpected ${unknown.join(', ')})`,
    );
  }
  const resolutionIndex = [
    ...table.partitions.map((p) => p.column),
    'specificity',
    'effective_from',
    'effective_to',
    'state',
  ];
  const lines = [
    `${q('id')} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT`,
    `${q('rule_code')} VARCHAR(30) NOT NULL`,
    `${q('name')} VARCHAR(150) NOT NULL`,
    ...table.partitions.map((p) => `${q(p.column)} ${p.sqlType} NOT NULL`),
    ...table.dimensions.map((d) => `${q(d.column)} ${d.sqlType} NULL`),
    `${q('specificity')} SMALLINT UNSIGNED GENERATED ALWAYS AS (${specificitySql(table)}) STORED`,
    `${q('method')} VARCHAR(30) NOT NULL`,
    `${q('parameters')} JSON NOT NULL`,
    `${q('currency_id')} BIGINT UNSIGNED NULL`,
    `${q('rounding_mode')} VARCHAR(30) NULL`,
    `${q('rounding_precision')} SMALLINT NULL`,
    `${q('effective_from')} DATE NOT NULL`,
    `${q('effective_to')} DATE NULL`,
    `${q('is_retrospective')} BOOLEAN NOT NULL DEFAULT false`,
    `${q('supersedes_id')} BIGINT UNSIGNED NULL`,
    `${q('notes')} VARCHAR(500) NULL`,
    ...extraColumnSql.map((c) => c.trim()),
    `${q('state')} VARCHAR(30) NOT NULL DEFAULT 'draft'`,
    `${q('state_changed_at')} DATETIME(0) NULL`,
    `${q('submitted_at')} DATETIME(0) NULL`,
    `${q('submitted_by')} BIGINT UNSIGNED NULL`,
    `${q('approved_at')} DATETIME(0) NULL`,
    `${q('approved_by')} BIGINT UNSIGNED NULL`,
    `${q('rejected_at')} DATETIME(0) NULL`,
    `${q('rejected_by')} BIGINT UNSIGNED NULL`,
    `${q('rejection_reason')} VARCHAR(500) NULL`,
    `${q('version')} INTEGER NOT NULL DEFAULT 1`,
    `${q('created_at')} DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0)`,
    `${q('created_by')} BIGINT UNSIGNED NOT NULL`,
    `${q('updated_at')} DATETIME(0) NULL`,
    `${q('updated_by')} BIGINT UNSIGNED NULL`,
    `-- generated: see core/rules/rule-sql.ts`,
    `${q('active_key')} VARCHAR(255) GENERATED ALWAYS AS (${activeKeySql(table)}) STORED`,
    '',
    `UNIQUE INDEX ${q(`ux_${t}_scope_from`)}(${q('active_key')})`,
    `INDEX ${q(`ix_${t}_resolution`)}(${resolutionIndex.map(q).join(', ')})`,
    `INDEX ${q(`ix_${t}_code`)}(${q('rule_code')}, ${q('effective_from')})`,
    `INDEX ${q(`ix_${t}_state`)}(${q('state')})`,
    `INDEX ${q(`ix_${t}_retrospective`)}(${q('is_retrospective')})`,
    `INDEX ${q(`ix_${t}_supersedes`)}(${q('supersedes_id')})`,
    ...USER_COLUMNS.map((c) => `INDEX ${q(`ix_${t}_${c}`)}(${q(c)})`),
    `PRIMARY KEY (${q('id')})`,
  ];
  // Blank and comment lines carry no comma.
  const body = lines
    .map((l, i) => {
      if (l === '' || l.startsWith('--')) return l === '' ? '' : `    ${l}`;
      const last = lines.slice(i + 1).every((x) => x === '' || x.startsWith('--'));
      return `    ${l}${last ? '' : ','}`;
    })
    .join('\n');

  const fks = [
    `ALTER TABLE ${q(t)} ADD CONSTRAINT ${q(`fk_${t}_supersedes`)} FOREIGN KEY (${q('supersedes_id')}) REFERENCES ${q(t)}(${q('id')}) ON DELETE RESTRICT ON UPDATE RESTRICT;`,
    ...USER_COLUMNS.map(
      (c) =>
        `ALTER TABLE ${q(t)} ADD CONSTRAINT ${q(`fk_${t}_${c}`)} FOREIGN KEY (${q(c)}) REFERENCES ${q('user')}(${q('id')}) ON DELETE RESTRICT ON UPDATE RESTRICT;`,
    ),
  ];
  const checks = [
    `ADD CONSTRAINT ${q(`ck_${t}_range`)} CHECK (${q('effective_to')} IS NULL OR ${q('effective_to')} >= ${q('effective_from')})`,
    `ADD CONSTRAINT ${q(`ck_${t}_state`)} CHECK (${q('state')} IN (${list(RULE_STATES)}))`,
    `ADD CONSTRAINT ${q(`ck_${t}_method`)} CHECK (${q('method')} IN (${list(table.methods)}))`,
    `ADD CONSTRAINT ${q(`ck_${t}_rounding`)} CHECK (${q('rounding_mode')} IS NULL OR ${q('rounding_mode')} IN (${list(ROUNDING_MODES)}))`,
    `ADD CONSTRAINT ${q(`ck_${t}_rejection`)} CHECK ((${q('rejected_at')} IS NULL) = (${q('rejection_reason')} IS NULL))`,
    `ADD CONSTRAINT ${q(`ck_${t}_approved`)} CHECK (${q('state')} NOT IN ('active', 'superseded') OR ${q('approved_at')} IS NOT NULL)`,
  ];

  return [
    `-- CreateTable (rule block: core/rules/rule-sql.ts)`,
    `CREATE TABLE ${q(t)} (`,
    body,
    `) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    '',
    ...fks,
    '',
    `-- HAND-EDIT: CHECK constraints (prisma/README.md).`,
    `ALTER TABLE ${q(t)}\n  ${checks.join(',\n  ')};`,
    '',
    `-- HAND-EDIT: versions are superseded, never deleted (P3 §17.1), so UPDATE only.`,
    `GRANT UPDATE ON ${q(t)} TO 'rupai_app'@'%';`,
    '',
  ].join('\n');
}

/** Every column of the block, with whether it may be NULL and whether MySQL generates it. */
function expectedColumns(table: RuleTable): { name: string; nullable: boolean; generated?: boolean }[] {
  const nn = (name: string) => ({ name, nullable: false });
  const nl = (name: string) => ({ name, nullable: true });
  return [
    nn('id'),
    nn('rule_code'),
    nn('name'),
    ...table.partitions.map((p) => nn(p.column)),
    ...table.dimensions.map((d) => nl(d.column)),
    { name: 'specificity', nullable: true, generated: true },
    nn('method'),
    nn('parameters'),
    nl('currency_id'),
    nl('rounding_mode'),
    nl('rounding_precision'),
    nn('effective_from'),
    nl('effective_to'),
    nn('is_retrospective'),
    nl('supersedes_id'),
    nl('notes'),
    nn('state'),
    nl('state_changed_at'),
    nl('submitted_at'),
    nl('submitted_by'),
    nl('approved_at'),
    nl('approved_by'),
    nl('rejected_at'),
    nl('rejected_by'),
    nl('rejection_reason'),
    nn('version'),
    nn('created_at'),
    nn('created_by'),
    nl('updated_at'),
    nl('updated_by'),
    { name: 'active_key', nullable: true, generated: true },
    ...table.extraColumns.map((c) => ({ name: c, nullable: true, extra: true })),
  ];
}

/**
 * Checks a live table against the block: every column (nullability, generated), the unique scope key,
 * the resolution index and every CHECK. Returns the problems; empty means it conforms.
 */
export async function checkRuleTable(db: Database | Tx, table: RuleTable): Promise<string[]> {
  const t = table.table;
  const cols = await db.$queryRaw<{ name: string; nullable: string; extra: string }[]>(Prisma.sql`
    SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable, EXTRA AS extra
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}`);
  if (cols.length === 0) return [`${t}: table does not exist`];
  const byName = new Map(cols.map((c) => [c.name, c]));
  const problems: string[] = [];
  for (const e of expectedColumns(table)) {
    const c = byName.get(e.name);
    if (!c) {
      problems.push(`${t}.${e.name}: missing`);
      continue;
    }
    if ('extra' in e) continue; // the module decides an extra column's nullability
    if (!e.generated && (c.nullable === 'YES') !== e.nullable) {
      problems.push(`${t}.${e.name}: must be ${e.nullable ? 'NULL' : 'NOT NULL'}`);
    }
    if (Boolean(e.generated) !== c.extra.includes('STORED GENERATED')) {
      problems.push(`${t}.${e.name}: must ${e.generated ? '' : 'not '}be a STORED generated column`);
    }
  }
  const indexes = await db.$queryRaw<
    { name: string; nonUnique: number | bigint; columns: string }[]
  >(Prisma.sql`
    SELECT INDEX_NAME AS name, MAX(NON_UNIQUE) AS nonUnique,
           GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t}
    GROUP BY INDEX_NAME`);
  const index = new Map(indexes.map((i) => [i.name, i]));
  const scopeFrom = index.get(`ux_${t}_scope_from`);
  if (!scopeFrom || Number(scopeFrom.nonUnique) !== 0 || scopeFrom.columns !== 'active_key') {
    problems.push(`${t}: needs UNIQUE ux_${t}_scope_from(active_key)`);
  }
  const resolution = [
    ...table.partitions.map((p) => p.column),
    'specificity',
    'effective_from',
    'effective_to',
    'state',
  ];
  if (index.get(`ix_${t}_resolution`)?.columns !== resolution.join(',')) {
    problems.push(`${t}: needs INDEX ix_${t}_resolution(${resolution.join(', ')})`);
  }
  const checks = await db.$queryRaw<{ name: string }[]>(Prisma.sql`
    SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${t} AND CONSTRAINT_TYPE = 'CHECK'`);
  const checkNames = new Set(checks.map((c) => c.name));
  for (const ck of ['range', 'state', 'method', 'rounding', 'rejection', 'approved']) {
    if (!checkNames.has(`ck_${t}_${ck}`)) problems.push(`${t}: missing CHECK ck_${t}_${ck}`);
  }
  return problems;
}
