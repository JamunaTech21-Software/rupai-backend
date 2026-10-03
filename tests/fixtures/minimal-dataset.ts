import type { Logger } from 'pino';

import type { Database } from '../../src/core/db/prisma.js';
import { runSeeders, type Seeder } from '../../src/core/db/seed.js';

/**
 * The MINIMAL dataset (Spec P13 §7.1): small, deterministic, in version control, used by unit and
 * integration tests. Target contents, added by the epic that creates each table:
 *
 *   P1.01  the administrator role and one user per test role
 *   P1.07  one organisation, one estate, one division, two sections, three fields
 *   P1.08  one factory, one warehouse
 *   P1.09  one season and the current fiscal year with its periods
 *   P1.10  reference lookups (tea types and grades, UOMs, shifts)
 *   P2.x   ten workers with employment profiles and one team
 *   …      a month of activity as later phases arrive
 *
 * Every part is an idempotent Seeder (seedRows by business code), so loading it twice changes nothing and
 * tests may rely on the codes below. Tests never modify the fixture: they write inside withRollback()
 * or in a temporary database.
 *
 * The REALISTIC (3 estates, 4,000 workers) and YEAR-THREE (millions of rows) datasets of P13 §7.1 are
 * generated, not hand-built, and arrive with the performance work of P13.01.
 */
export const MINIMAL_DATASET: readonly Seeder[] = [];

/** Stable business codes of the minimal dataset, for assertions. Grows with MINIMAL_DATASET. */
export const MINIMAL = {} as const;

export function loadMinimalDataset(db: Database, logger: Logger) {
  return runSeeders(db, MINIMAL_DATASET, logger);
}
