import type { Seeder } from '../../core/db/seed.js';
import { BOOTSTRAP_ADMIN_ID } from '../identity/identity.seed.js';
import { ACCOUNT_AUDIT } from './accounts.service.js';
import { P8_CHART, pathOf, resolveChart } from './chart.js';

/**
 * The P8 proposed chart (D-3.01-1), INACTIVE until the accountant's sign-off (P3 §31.2–§31.3).
 *
 * Loaded once, into an empty table. After that the chart is the client's: they correct it, or replace it
 * with their own (remove-unused + import, D-3.01-11), and a later deploy must not bring back an account
 * they removed. Running it again therefore changes nothing.
 */
export const chartOfAccountsSeeder: Seeder = {
  name: 'accounting: the P8 chart of accounts, inactive (once, into an empty chart)',
  async run(tx) {
    if ((await tx.account.count()) > 0) return { inserted: 0, updated: 0 };
    const ids = new Map<string, { id: bigint; path: string }>();
    for (const a of resolveChart(P8_CHART)) {
      const parent = a.parent === null ? null : ids.get(a.parent);
      const { id } = await tx.account.create({
        data: {
          parentId: parent?.id ?? null,
          code: a.code,
          name: a.name,
          accountType: a.account_type,
          accountSubtype: a.account_subtype,
          normalBalance: a.normal_balance,
          isPostable: a.is_postable,
          isControlAccount: a.is_control_account,
          controlSubledger: a.control_subledger,
          isBankOrCash: a.is_bank_or_cash,
          requiresCostCentre: a.requires_cost_centre,
          requiresEstate: a.requires_estate,
          isClearing: a.is_clearing,
          systemKey: a.system_key,
          isSystem: a.system_key !== null,
          level: a.level,
          status: 'inactive',
          createdBy: BOOTSTRAP_ADMIN_ID,
        },
        select: { id: true },
      });
      const path = pathOf(parent?.path ?? null, id);
      await tx.account.update({ where: { id }, data: { path } });
      ids.set(a.code, { id, path });
    }
    await tx.statusHistory.createMany({
      data: [...ids.values()].map(({ id }) => ({
        recordType: ACCOUNT_AUDIT.type,
        recordId: id.toString(),
        fromState: null,
        toState: 'inactive',
        changedBy: BOOTSTRAP_ADMIN_ID,
        comment: 'Seeded from P8; inactive until the accountant signs off',
      })),
    });
    return { inserted: ids.size, updated: 0 };
  },
};
