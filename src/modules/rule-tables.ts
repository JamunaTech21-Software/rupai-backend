import { WORKFLOW_TABLE } from '../core/approval/workflow-table.js';
import type { RuleTable } from '../core/rules/rule-table.js';

/**
 * Every effective-dated rule table (Spec P3 §17), so tests/db/rules.test.ts can check each one still
 * carries the rule block: generated specificity and active_key, the resolution index and the CHECKs.
 *
 * `workflow` (P1.13) is the first. wage_rule, incentive_rule, statutory_rule, charge_rule and the
 * green-leaf rate rules join with their modules. Add each one here when its migration lands.
 */
export const RULE_TABLES: readonly RuleTable[] = [WORKFLOW_TABLE];
