import type { RuleTable } from '../core/rules/rule-table.js';

/**
 * Every effective-dated rule table (Spec P3 §17), so tests/db/rules.test.ts can check each one still
 * carries the rule block: generated specificity and active_key, the resolution index and the CHECKs.
 *
 * Empty until the first rule table arrives with its module (wage_rule and incentive_rule in Phase 7,
 * statutory_rule, charge_rule, the green-leaf rate rules). Add each one here when its migration lands.
 */
export const RULE_TABLES: readonly RuleTable[] = [];
