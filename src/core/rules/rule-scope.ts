import { Prisma } from '../../generated/prisma/client.js';
import type { AccessLog } from '../audit/access-log.js';
import { AppError } from '../errors/app-error.js';
import { scopeToCheck, type ResolvedScope } from '../scope/scope.js';
import { scopeSql } from '../scope/sql.js';

/**
 * Data scope on rule tables (Spec P1 §12.3, P3 Table 3.1: policy records are "usually" estate-scoped).
 * Rule tables are read with raw SQL (one service for every table), so the Prisma scope extension cannot
 * see them; this applies the same contract by hand:
 *
 *   - an ORGANISATION-WIDE rule (scope_estate_id NULL) is visible to everyone who may view the table
 *   - an estate rule is visible inside that estate's scope only; out of scope is 404 (P4 §4.3)
 *   - writing an estate rule needs that estate in scope; writing an organisation-wide rule needs
 *     all_estates, because it changes what every estate pays
 *   - system work (runUnscoped: payroll jobs, seeders) is unfiltered, exactly like the extension
 *
 * Division, section and department grants see organisation-wide rules only until P1.07 relates them
 * to their estate (BACKLOG D-1.06-7).
 */

/** The caller's scope, or null inside runUnscoped. Throws where no scope was set up, like the extension. */
export const ruleScope = scopeToCheck;

export function canSeeEstate(scope: ResolvedScope | null, estateId: bigint | null): boolean {
  if (scope === null || scope.allEstates || estateId === null) return true;
  return scope.estates.includes(estateId);
}

export function canWriteEstate(scope: ResolvedScope | null, estateId: bigint | null): boolean {
  if (scope === null || scope.allEstates) return true;
  return estateId !== null && scope.estates.includes(estateId);
}

/** WHERE fragment: the rows of `alias` this scope may see. */
export function visibleRulesSql(scope: ResolvedScope | null, alias = 'r'): Prisma.Sql {
  if (scope === null || scope.allEstates) return Prisma.sql`(1 = 1)`;
  const column = `${alias}.scope_estate_id`;
  return Prisma.sql`(${Prisma.raw(`\`${alias}\`.\`scope_estate_id\``)} IS NULL OR ${scopeSql(scope, { estate: column })})`;
}

export function scopeDenied(message = 'This rule is outside your data scope.'): AppError {
  return new AppError('SCOPE_DENIED', message, [{ field: 'scope.estate', code: 'SCOPE_DENIED', message }]);
}

/** Records a scope denial (P4 §4.3: logged whatever the caller was told). Never fails the request. */
export async function logRuleScopeDenied(
  accessLog: AccessLog | undefined,
  table: string,
  operation: string,
  target: unknown,
): Promise<void> {
  if (!accessLog) return;
  const reference = JSON.stringify(target, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
  await accessLog
    .record({ eventType: 'scope_denied', module: table, recordReference: reference, detail: { operation } })
    .catch(() => undefined);
}
