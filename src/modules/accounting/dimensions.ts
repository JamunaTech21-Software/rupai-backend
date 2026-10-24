import type { Tx } from '../../core/db/transaction.js';
import { Errors } from '../../core/errors/app-error.js';

/**
 * Checks the analysis dimensions that other modules' documents carry (P3.02, D-3.02-9). A document that
 * spends names an active EXPENSE budget head; budget consumption against it arrives with P3.06.
 */
export async function assertExpenseBudgetHead(tx: Tx, id: bigint | null | undefined): Promise<void> {
  if (id === null || id === undefined) return;
  const h = await tx.budgetHead.findUnique({ where: { id }, select: { status: true, headType: true } });
  if (h?.status !== 'active' || h.headType !== 'expense') {
    throw Errors.validation([
      { field: 'budget_head_id', code: 'VALIDATION_FAILED', message: 'No such active expense budget head.' },
    ]);
  }
}
