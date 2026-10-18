import { scopeToCheck } from '../../core/scope/scope.js';

/**
 * Who may CHANGE a person (P2.01–P2.02, D-2.01-2): access to all estates, or an estate grant on the estate
 * that registered them or on an estate where they hold a profile. A person with neither is changed only
 * with access to all estates.
 */
export async function personWritable(
  registeredEstateId: bigint | null,
  profileEstateIds: readonly bigint[] = [],
): Promise<boolean> {
  const scope = await scopeToCheck();
  if (scope === null || scope.allEstates) return true;
  return [registeredEstateId, ...profileEstateIds].some((e) => e !== null && scope.estates.includes(e));
}
