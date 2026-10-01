import type { Seeder } from '../../src/core/db/seed.js';

/**
 * Seeders, run in this order. Each epic adds its own (Spec P3 §31):
 *   P1.01  permission catalogue, Administrator role, bootstrap admin user
 *   P1.10  reference lookups, UOM, currency, country, tea types and grades
 *   …
 * Statutory rules, the chart of accounts and posting rules ship INACTIVE (Spec P3 §31.3).
 */
export const SEEDERS: readonly Seeder[] = [];
