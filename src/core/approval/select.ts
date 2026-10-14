import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../db/prisma.js';
import type { Tx } from '../db/transaction.js';
import { AppError } from '../errors/app-error.js';
import { pickRule, toCandidate, type RuleCandidate } from '../rules/resolve.js';
import type { BusinessDate } from '../time/dates.js';
import { evaluateAll, type Condition, type DocumentValues } from './conditions.js';
import { WORKFLOW_TABLE } from './workflow-table.js';

/**
 * Workflow selection (Spec P7 §3.2). Exactly one workflow governs a submitted document:
 *
 *   1. the ACTIVE versions for its document type whose effective range contains the SUBMISSION date
 *      and whose scope matches the document (a workflow naming an estate applies to that estate only)
 *   2. of those, the ones whose own condition holds for the document
 *   3. the most specific wins: estate + department, then estate, then department, then the default
 *
 * Two at the same specificity is a configuration error (422 RULE_AMBIGUOUS): the engine never chooses.
 * None at all means the document type needs no approval, and `null` is returned.
 *
 * The same resolver as every other effective-dated rule (core/rules), so "why did this workflow apply"
 * has one answer everywhere.
 */

export interface WorkflowScope {
  readonly estateId?: bigint | string | null;
  readonly departmentId?: bigint | string | null;
}

/** The stored condition list of a workflow row, whatever form the driver returned it in. */
export function readConditions(raw: unknown): Condition[] {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? (parsed as Condition[]) : [];
}

export async function selectWorkflow(
  db: Database | Tx,
  documentType: string,
  scope: WorkflowScope,
  date: BusinessDate,
  values: DocumentValues,
): Promise<RuleCandidate | null> {
  const estate = scope.estateId === null || scope.estateId === undefined ? null : String(scope.estateId);
  const department =
    scope.departmentId === null || scope.departmentId === undefined ? null : String(scope.departmentId);
  const rows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT r.id, r.rule_code, r.name, r.specificity, r.effective_from, r.effective_to, r.document_type,
           r.scope_estate_id, r.scope_department_id, r.condition_json
    FROM workflow AS r
    WHERE r.state = 'active' AND r.document_type = ${documentType}
      AND r.effective_from <= ${date} AND (r.effective_to IS NULL OR r.effective_to >= ${date})
      AND (r.scope_estate_id IS NULL OR r.scope_estate_id = ${estate})
      AND (r.scope_department_id IS NULL OR r.scope_department_id = ${department})
    ORDER BY r.specificity DESC, r.effective_from DESC, r.id
    LIMIT 100`);
  const applicable = rows
    .filter((row) => evaluateAll(readConditions(row.condition_json), values))
    .map((row) => toCandidate(WORKFLOW_TABLE, row));
  try {
    return pickRule(WORKFLOW_TABLE, applicable, { document_type: documentType, estate, department }, date)
      .rule;
  } catch (err) {
    if (err instanceof AppError && err.code === 'RULE_NOT_FOUND') return null;
    throw err;
  }
}
