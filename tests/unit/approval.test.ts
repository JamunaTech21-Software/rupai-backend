import { describe, expect, it } from 'vitest';

import {
  checkCondition,
  CLASS_OPERATORS,
  evaluateAll,
  evaluateCondition,
  type Condition,
} from '../../src/core/approval/conditions.js';
import {
  checkDefinition,
  pathFor,
  workflowApplies,
  type StepDefinition,
  type WorkflowDefinition,
} from '../../src/core/approval/definition.js';
import {
  APPROVABLE_DOCUMENTS,
  approvableDocument,
  approvePermissionOf,
  NEVER_SELF_APPROVE,
} from '../../src/core/approval/document-types.js';
import { WORKFLOW_TABLE } from '../../src/core/approval/workflow-table.js';
import { specificityOf } from '../../src/core/rules/rule-table.js';
import { MODULES, PERMISSION_KEYS } from '../../src/modules/identity/permission-catalogue.js';

/** P1.13: the approval engine's document registry, condition grammar and definition checks (P7 §3, §5, §15.2). */

const PO = approvableDocument('purchase_order');
if (!PO) throw new Error('purchase_order is not registered');

const step = (over: Partial<StepDefinition> = {}): StepDefinition => ({
  name: null,
  approverRule: 'by_role',
  roleId: '10',
  userId: null,
  reportingLevel: null,
  condition: null,
  allowSelfApproval: false,
  ...over,
});
const amount = (operator: Condition['operator'], value: Condition['value']): Condition => ({
  field: 'total_base_amount',
  operator,
  value,
});
const def = (steps: StepDefinition[], over: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  documentType: 'purchase_order',
  conditions: [],
  steps,
  ...over,
});
const codes = (d: WorkflowDefinition) => checkDefinition(d).map((p) => p.code);

/** P7 Table 6.1: one definition covers all five expenditure tiers. */
const LADDER = [
  step({ name: 'Estate manager' }),
  step({ name: 'Accounts', condition: amount('gte', '50001') }),
  step({ name: 'General manager', condition: amount('gte', '250001') }),
  step({ name: 'Managing director', condition: amount('gte', '1000001') }),
];

describe('approvable document types (P7 §2.1, §5.1)', () => {
  it('describes each type once, with a key that fits a workflow code and a known permission module', () => {
    const keys = APPROVABLE_DOCUMENTS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    const modules = new Set(MODULES.map((m) => m.key));
    for (const d of APPROVABLE_DOCUMENTS) {
      expect(d.key, d.key).toMatch(/^[a-z][a-z0-9_]{1,26}$/);
      expect(modules.has(d.module), `${d.key}: module ${d.module}`).toBe(true);
      if (d.approvePermission) expect(PERMISSION_KEYS.has(d.approvePermission), d.key).toBe(true);
      const names = d.fields.map((f) => f.name);
      expect(new Set(names).size, `${d.key}: duplicate field`).toBe(names.length);
      expect(names).toEqual(
        expect.arrayContaining(['submitter_role', 'submitter_department', 'department_id']),
      );
      expect(names.includes('estate_id'), d.key).toBe(d.tier === 'estate');
    }
    expect(approvePermissionOf(PO)).toBe('purchase_order.approve');
    expect(approvePermissionOf(approvableDocument('receivable_write_off') ?? PO)).toBe(
      'receivable.write_off',
    );
  });

  it('never lets self-approval be configured on financial, capture, policy and leave documents', () => {
    const cls = (key: string) => approvableDocument(key)?.approvalClass;
    expect(
      [cls('payment'), cls('attendance'), cls('wage_rule'), cls('leave')].every(
        (c) => c && NEVER_SELF_APPROVE.has(c),
      ),
    ).toBe(true);
    expect(
      [cls('field_activity'), cls('employment_assignment')].some((c) => c && NEVER_SELF_APPROVE.has(c)),
    ).toBe(false);
  });

  it('ranks scope as P7 §3.2: estate and department, then estate, then department, then the default', () => {
    const s = (estate: string | null, department: string | null) =>
      specificityOf(WORKFLOW_TABLE, { estate, department });
    expect([s('1', '2'), s('1', null), s(null, '2'), s(null, null)]).toEqual([3, 2, 1, 0]);
  });
});

describe('condition grammar (P7 §5.1)', () => {
  const check = (c: Condition) => checkCondition(PO, c, 'c').map((p) => p.field);

  it('accepts each operator on the field classes it belongs to, and nothing else', () => {
    expect(check(amount('gte', '50001'))).toEqual([]);
    expect(check(amount('between', ['50001', '250000.50']))).toEqual([]);
    expect(check({ field: 'estate_id', operator: 'in', value: ['1', '2'] })).toEqual([]);
    expect(check({ field: 'budget_exceeded', operator: 'is_true', value: null })).toEqual([]);
    expect(check({ field: 'submitter_role', operator: 'eq', value: '7' })).toEqual([]);

    expect(check(amount('eq', '5'))).toEqual(['c.operator']);
    expect(check({ field: 'estate_id', operator: 'gte', value: '1' })).toEqual(['c.operator']);
    expect(check({ field: 'budget_exceeded', operator: 'eq', value: 'true' })).toEqual(['c.operator']);
    expect(CLASS_OPERATORS.quantity).not.toContain('between');
  });

  it('refuses a field the document type does not have, and a value of the wrong shape', () => {
    expect(check({ field: 'sale_channel', operator: 'eq', value: 'export' })).toEqual(['c.field']);
    expect(check(amount('gte', 'fifty'))).toEqual(['c.value']);
    expect(check(amount('gte', '-5'))).toEqual(['c.value']);
    expect(check(amount('gte', null))).toEqual(['c.value']);
    expect(check(amount('between', ['9', '1']))).toEqual(['c.value']);
    expect(check(amount('between', '5'))).toEqual(['c.value']);
    expect(check({ field: 'estate_id', operator: 'in', value: [] })).toEqual(['c.value']);
    expect(check({ field: 'estate_id', operator: 'in', value: ['1', '1'] })).toEqual(['c.value']);
    expect(check({ field: 'estate_id', operator: 'eq', value: 'north' })).toEqual(['c.value']);
    expect(check({ field: 'budget_exceeded', operator: 'is_true', value: 'yes' })).toEqual(['c.value']);
  });

  it('compares amounts as decimals, at the boundary and one unit either side (P7 §17)', () => {
    const gte = amount('gte', '50001');
    expect(evaluateCondition(gte, { total_base_amount: '50000.99' })).toBe(false);
    expect(evaluateCondition(gte, { total_base_amount: '50001' })).toBe(true);
    expect(evaluateCondition(gte, { total_base_amount: '50001.00' })).toBe(true);
    expect(evaluateCondition(amount('gt', '50000'), { total_base_amount: '50000.00' })).toBe(false);
    expect(evaluateCondition(amount('lt', '0.3'), { total_base_amount: '0.1' })).toBe(true);
    expect(
      evaluateCondition(amount('lte', '900719925474099.3'), { total_base_amount: '900719925474099.2' }),
    ).toBe(true);
    const between = amount('between', ['100', '200']);
    expect(
      ['99.99', '100', '200', '200.01'].map((v) => evaluateCondition(between, { total_base_amount: v })),
    ).toEqual([false, true, true, false]);
  });

  it('treats a missing value as satisfying nothing but not_in and is_false', () => {
    expect(evaluateCondition(amount('gte', '0'), {})).toBe(false);
    expect(evaluateCondition(amount('lt', '100'), { total_base_amount: null })).toBe(false);
    expect(evaluateCondition({ field: 'estate_id', operator: 'eq', value: '1' }, {})).toBe(false);
    expect(evaluateCondition({ field: 'estate_id', operator: 'in', value: ['1'] }, {})).toBe(false);
    expect(evaluateCondition({ field: 'estate_id', operator: 'not_in', value: ['1'] }, {})).toBe(true);
    expect(
      evaluateCondition({ field: 'estate_id', operator: 'not_in', value: ['1'] }, { estate_id: '1' }),
    ).toBe(false);
    expect(evaluateCondition({ field: 'budget_exceeded', operator: 'is_false', value: null }, {})).toBe(true);
    expect(
      evaluateCondition(
        { field: 'budget_exceeded', operator: 'is_true', value: null },
        { budget_exceeded: true },
      ),
    ).toBe(true);
  });

  it('combines conditions with AND only', () => {
    const both = [amount('gte', '1000'), { field: 'estate_id', operator: 'eq', value: '3' } as Condition];
    expect(evaluateAll(both, { total_base_amount: '5000', estate_id: '3' })).toBe(true);
    expect(evaluateAll(both, { total_base_amount: '5000', estate_id: '4' })).toBe(false);
    expect(evaluateAll([], {})).toBe(true);
    expect(workflowApplies({ conditions: both }, { total_base_amount: '10', estate_id: '3' })).toBe(false);
  });
});

describe('definition-time checks (P7 §15.2)', () => {
  it('accepts the standard expenditure ladder', () => {
    expect(checkDefinition(def(LADDER))).toEqual([]);
  });

  it('refuses a workflow whose every step is conditional', () => {
    const problems = checkDefinition(
      def([step({ condition: amount('gte', '50001') }), step({ condition: amount('lt', '50001') })]),
    );
    expect(problems.map((p) => [p.field, p.code])).toEqual([['steps', 'WORKFLOW_NO_UNCONDITIONAL_STEP']]);
  });

  it('refuses a condition on a field the document type does not have', () => {
    const problems = checkDefinition(
      def([step(), step({ condition: { field: 'sale_channel', operator: 'eq', value: 'export' } })]),
    );
    expect(problems.map((p) => [p.field, p.code])).toEqual([
      ['steps.1.condition.field', 'WORKFLOW_CONDITION_INVALID'],
    ]);
    expect(codes(def([step()], { conditions: [{ field: 'nope', operator: 'eq', value: '1' }] }))).toEqual([
      'WORKFLOW_CONDITION_INVALID',
    ]);
    expect(codes(def([step()], { documentType: 'time_machine' }))).toEqual([
      'WORKFLOW_DOCUMENT_TYPE_UNKNOWN',
    ]);
  });

  it('requires amount conditions to form a ladder or separate bands', () => {
    const ok = (a: Condition, b: Condition) =>
      codes(def([step(), step({ condition: a }), step({ condition: b })]));
    // Higher bands inside the earlier one, the same band twice, and bands that do not touch.
    expect(ok(amount('gte', '50001'), amount('gte', '250001'))).toEqual([]);
    expect(ok(amount('gte', '50001'), amount('gte', '50001'))).toEqual([]);
    expect(ok(amount('lt', '100000'), amount('gte', '100000'))).toEqual([]);
    expect(ok(amount('between', ['1', '100']), amount('between', ['101', '200']))).toEqual([]);
    expect(ok(amount('gte', '50001'), amount('between', ['60000', '70000']))).toEqual([]);
    // A later step reaching below an earlier one, and bands that partly overlap.
    expect(ok(amount('gte', '250001'), amount('gte', '50001'))).toEqual(['WORKFLOW_LADDER_INVALID']);
    expect(ok(amount('lte', '100000'), amount('gte', '100000'))).toEqual(['WORKFLOW_LADDER_INVALID']);
    expect(ok(amount('between', ['1', '100']), amount('between', ['50', '200']))).toEqual([
      'WORKFLOW_LADDER_INVALID',
    ]);
    // Different fields are never compared.
    expect(
      ok(amount('gte', '250001'), { field: 'budget_exceeded', operator: 'is_true', value: null }),
    ).toEqual([]);
  });

  it('requires each approver rule to name exactly what it needs', () => {
    const one = (s: Partial<StepDefinition>) => checkDefinition(def([step(s)])).map((p) => p.field);
    expect(one({ approverRule: 'by_role', roleId: null })).toEqual(['steps.0.role_id']);
    expect(one({ approverRule: 'by_named_user', roleId: null, userId: '5' })).toEqual([]);
    expect(one({ approverRule: 'by_named_user' })).toEqual(['steps.0.role_id', 'steps.0.user_id']);
    expect(one({ approverRule: 'by_reporting_line', roleId: null, reportingLevel: 1 })).toEqual([]);
    expect(one({ approverRule: 'by_reporting_line', roleId: null, reportingLevel: 9 })).toEqual([
      'steps.0.reporting_level',
    ]);
    expect(one({ approverRule: 'by_reporting_line', roleId: null })).toEqual(['steps.0.reporting_level']);
    expect(one({ approverRule: 'by_cost_centre_manager', roleId: null })).toEqual([]);
    expect(
      checkDefinition(
        def([step({ approverRule: 'by_cost_centre_manager', roleId: null })], { documentType: 'leave' }),
      ).map((p) => p.field),
    ).toEqual(['steps.0.approver_rule']);
    expect(codes(def([]))).toEqual(['WORKFLOW_STEP_INVALID']);
    expect(codes(def(Array.from({ length: 11 }, () => step())))).toEqual(['WORKFLOW_STEP_INVALID']);
  });

  it('refuses self-approval where P7 Table 12.1 says never, and allows it on routine records', () => {
    expect(codes(def([step({ allowSelfApproval: true })]))).toEqual(['WORKFLOW_SELF_APPROVAL_FORBIDDEN']);
    expect(codes(def([step({ allowSelfApproval: true })], { documentType: 'leave' }))).toEqual([
      'WORKFLOW_SELF_APPROVAL_FORBIDDEN',
    ]);
    expect(codes(def([step({ allowSelfApproval: true })], { documentType: 'field_activity' }))).toEqual([]);
  });
});

describe('the path of a document (P7 §3.3, §6.2)', () => {
  const path = (value: string) => pathFor(LADDER, { total_base_amount: value }).map((i) => i + 1);

  it('gives each expenditure tier its steps, at the boundary and one unit either side', () => {
    expect(path('40000')).toEqual([1]);
    expect(path('50000')).toEqual([1]);
    expect(path('50001')).toEqual([1, 2]);
    expect(path('250000')).toEqual([1, 2]);
    expect(path('250001')).toEqual([1, 2, 3]);
    expect(path('1000000')).toEqual([1, 2, 3]);
    expect(path('1000001')).toEqual([1, 2, 3, 4]);
    expect(path('3000000')).toEqual([1, 2, 3, 4]);
    expect(pathFor(LADDER, {})).toEqual([0]);
  });
});
