import type { Seeder } from '../../src/core/db/seed.js';
import { chartOfAccountsSeeder } from '../../src/modules/accounting/accounts.seed.js';
import { postingRuleSeeder } from '../../src/modules/accounting/posting-rules.seed.js';
import { identitySeeders, type BootstrapAdmin } from '../../src/modules/identity/identity.seed.js';
import { lookupSeeder } from '../../src/modules/lookups/lookup.seed.js';
import { notificationRuleSeeder } from '../../src/modules/notifications/notifications.jobs.js';
import { organisationSeeder } from '../../src/modules/organisation/organisation.service.js';
import { numberFormatSeeder } from '../../src/modules/system/system.service.js';
import { workflowSeeder } from '../../src/modules/workflows/workflows.service.js';

/**
 * Seeders, run in this order. Each epic adds its own (Spec P3 §31):
 *   P1.01  permission catalogue, Administrator role, bootstrap admin user
 *   P1.10  reference lookups, units, currencies, countries, tea types and grades (insert-only)
 *   P1.11  one number format per document type (insert-only)
 *   P1.07  the organisation row (placeholders an administrator replaces; needs BDT and Bangladesh)
 *   P1.13  a single-step workflow per approvable document type (insert-only)
 *   P1.16  one notification rule per trigger, conservative defaults (insert-only)
 *   P3.01  the P8 chart of accounts, INACTIVE (once, into an empty chart)
 *   P3.03  the indicative posting rules, INACTIVE (once, into an empty table)
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
  return [
    ...identitySeeders(admin),
    lookupSeeder,
    organisationSeeder,
    numberFormatSeeder,
    workflowSeeder,
    notificationRuleSeeder,
    chartOfAccountsSeeder,
    postingRuleSeeder,
  ];
}
