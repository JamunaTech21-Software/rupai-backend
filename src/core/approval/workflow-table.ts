import { defineRuleTable } from '../rules/rule-table.js';

/**
 * `workflow` is an effective-dated policy table (Spec P7 §15.1, P3 §28.3), so it carries the rule block
 * of core/rules and is versioned, approved and resolved by the same code as a wage rule:
 *
 *   partition   document_type          a workflow governs exactly one document type
 *   dimensions  estate (2), department (1)
 *               → estate + department 3 > estate 2 > department 1 > organisation default 0, which is the
 *                 selection order of P7 §3.2
 *   extra       condition_json         when the workflow applies at all (a list of conditions, AND)
 *
 * The block's `method` and `parameters` are unused by workflows: there is one way to run a workflow.
 */
export const WORKFLOW_TABLE = defineRuleTable({
  table: 'workflow',
  methods: ['sequential'],
  dimensions: [
    { column: 'scope_estate_id', key: 'estate', sqlType: 'BIGINT UNSIGNED' },
    { column: 'scope_department_id', key: 'department', sqlType: 'BIGINT UNSIGNED' },
  ],
  partitions: [{ column: 'document_type', key: 'document_type', sqlType: 'VARCHAR(50)' }],
  extraColumns: ['condition_json'],
});

export const WORKFLOW_METHOD = 'sequential';
