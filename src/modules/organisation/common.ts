import type { AccessLog } from '../../core/audit/access-log.js';
import { constraintViolation } from '../../core/db/errors.js';
import type { Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import { toDecimalString } from '../../core/money/decimal.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ResolvedScope } from '../../core/scope/scope.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { businessDateFromDb } from '../../core/time/dates.js';

/** Shared by the organisation-hierarchy services. */

export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
export const day = (d: Date | null): string | null => (d ? businessDateFromDb(d) : null);
export const area = (d: Prisma.Decimal | null): string | null => (d ? toDecimalString(d, 'qty') : null);
export const idOut = (v: bigint | null): string | null => (v === null ? null : v.toString());
export const idIn = (v: string | bigint | null): bigint | null => (v === null ? null : BigInt(v));

/** A write the caller's grants do not reach (the record itself may be readable through a child grant). */
export async function denyWrite(
  accessLog: AccessLog,
  module: string,
  id: bigint | null,
  operation: string,
): Promise<never> {
  await accessLog
    .record({
      eventType: 'scope_denied',
      module,
      recordReference: id?.toString() ?? null,
      detail: { operation },
    })
    .catch(() => undefined);
  throw new AppError('SCOPE_DENIED', 'This record is outside the part of the hierarchy you may change.', [
    { code: 'SCOPE_DENIED', message: 'Ask an administrator for access at this level.' },
  ]);
}

/** Whether the caller's scope reaches a node, at the levels that may change it. */
export async function writable(levels: {
  estate?: bigint;
  division?: bigint;
  section?: bigint;
}): Promise<boolean> {
  const scope: ResolvedScope | null = await scopeToCheck();
  if (scope === null || scope.allEstates) return true;
  return (
    (levels.estate !== undefined && scope.estates.includes(levels.estate)) ||
    (levels.division !== undefined && scope.divisions.includes(levels.division)) ||
    (levels.section !== undefined && scope.sections.includes(levels.section))
  );
}

/** Unique-key violations → DUPLICATE_KEY on the right field. */
export function duplicate(field: string, what: string) {
  return (err: unknown): never => {
    if (constraintViolation(err)?.kind === 'unique') {
      throw new AppError('DUPLICATE_KEY', `${what} is already in use.`, [
        { field, code: 'DUPLICATE_KEY', message: 'is already in use' },
      ]);
    }
    throw err;
  };
}

/** Deleting a referenced row → REFERENCED_RECORD, telling the caller to deactivate instead. */
export function referenced(what: string) {
  return (err: unknown): never => {
    if (constraintViolation(err)?.kind === 'referenced') throw inUse(what);
    throw err;
  };
}

export function inUse(what: string, by?: string): AppError {
  return new AppError(
    'REFERENCED_RECORD',
    `This ${what} is in use${by ? ` by ${by}` : ''}, so it cannot be deleted.`,
    [{ code: 'REFERENCED_RECORD', message: 'Deactivate it instead.', ...(by ? { context: { by } } : {}) }],
  );
}

/** Scope grants name hierarchy nodes without a foreign key (P1.03), so deletion checks them here. */
export async function assertNoScopeGrants(
  tx: Tx,
  type: 'estate' | 'division' | 'section',
  id: bigint,
  what: string,
) {
  const grants = await tx.userScope.count({ where: { scopeType: type, scopeId: id } });
  if (grants > 0) throw inUse(what, 'user scope grants');
}

export function inactiveParent(field: string, what: string): AppError {
  return Errors.validation([{ field, code: 'VALIDATION_FAILED', message: `The ${what} is inactive.` }]);
}

export function versionConflict(current: { version: number }, resource: unknown): never {
  throw Errors.versionConflict({ version: current.version, resource });
}

/**
 * A manager / supervisor named on a hierarchy node or a facility (P2.02: real profiles now): it exists,
 * is not separated, and — when `estateId` is given — is employed at that estate. Throws a field error.
 */
export async function assertProfileRef(
  tx: Tx,
  field: string,
  id: bigint | null | undefined,
  estateId: bigint | null,
): Promise<void> {
  if (id === undefined || id === null) return;
  const p = await tx.employmentProfile.findUnique({
    where: { id },
    select: { estateId: true, status: true },
  });
  const message = !p
    ? 'No such employment profile.'
    : p.status === 'separated'
      ? 'That profile is separated.'
      : estateId !== null && p.estateId !== estateId
        ? 'The profile must be employed at this estate.'
        : null;
  if (message) throw Errors.validation([{ field, code: 'VALIDATION_FAILED', message }]);
}
