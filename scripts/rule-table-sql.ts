/**
 * `npx tsx scripts/rule-table-sql.ts <table> [method ...]`: prints the CREATE TABLE for a standard rule
 * table (the P3 §17.1 rule block, from src/core/rules/rule-sql.ts), to paste into a migration.sql made
 * with `npm run db:migrate:new`. Then add the module's own columns, its Prisma model, and register the
 * table in src/modules/rule-tables.ts so the shape test covers it.
 *
 * Tables with partitions or other dimensions (statutory_rule, charge_rule) call ruleTableSql() with
 * their own defineRuleTable() instead.
 */
import { ruleTableSql } from '../src/core/rules/rule-sql.js';
import { defineRuleTable } from '../src/core/rules/rule-table.js';

const [table, ...methods] = process.argv.slice(2);
if (!table || methods.length === 0) {
  process.stderr.write('usage: tsx scripts/rule-table-sql.ts <table> <method> [method ...]\n');
  process.exit(1);
}
process.stdout.write(ruleTableSql(defineRuleTable({ table, methods })));
