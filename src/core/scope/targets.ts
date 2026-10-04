import type { Tx } from '../db/transaction.js';
import type { TargetedScopeType } from './scope.js';

/**
 * Checks that a scope grant names a record that exists. scope_id is polymorphic, so the database cannot
 * enforce it with a foreign key. The epic that creates each target table registers its check:
 *
 *   P1.07  estate, division, section, facility (factory and warehouse)
 *   P2     department
 *
 * Until then a grant's target is not checked (decision D-1.03-4).
 */
export type TargetCheck = (tx: Tx, id: bigint) => Promise<boolean>;

export const SCOPE_TARGETS = new Map<TargetedScopeType, TargetCheck>();
