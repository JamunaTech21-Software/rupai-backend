import type { Seeder } from '../../src/core/db/seed.js';
import { identitySeeders, type BootstrapAdmin } from '../../src/modules/identity/identity.seed.js';

/**
 * Seeders, run in this order. Each epic adds its own (Spec P3 §31):
 *   P1.01  permission catalogue, Administrator role, bootstrap admin user
 *   P1.10  reference lookups, UOM, currency, country, tea types and grades
 *   …
 * Statutory rules, the chart of accounts and posting rules ship INACTIVE (Spec P3 §31.3).
 */
export function buildSeeders(env: Record<string, string | undefined>): readonly Seeder[] {
  const admin: BootstrapAdmin = {
    username: env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
    // Empty means none (Docker Compose passes an unset variable as ""), never an empty email.
    email: env.BOOTSTRAP_ADMIN_EMAIL?.trim() ? env.BOOTSTRAP_ADMIN_EMAIL.trim() : null,
    password: env.BOOTSTRAP_ADMIN_PASSWORD,
  };
  return [...identitySeeders(admin)];
}
