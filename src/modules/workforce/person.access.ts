import { scopeToCheck } from '../../core/scope/scope.js';

/**
 * Who may CHANGE a person (P2.01, D-2.01-2): access to all estates, or an estate grant on the estate that
 * registered them. A person with no registering estate is changed only with access to all estates.
 */
export async function personWritable(registeredEstateId: bigint | null): Promise<boolean> {
  const scope = await scopeToCheck();
  if (scope === null || scope.allEstates) return true;
  return registeredEstateId !== null && scope.estates.includes(registeredEstateId);
}
