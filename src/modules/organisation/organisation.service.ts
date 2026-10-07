import type { z } from 'zod';

import { auditUpdate } from '../../core/audit/audit.js';
import type { Seeder } from '../../core/db/seed.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import type { Organisation, Prisma } from '../../generated/prisma/client.js';
import { BOOTSTRAP_ADMIN_ID } from '../identity/identity.seed.js';
import { idOut, iso, versionConflict } from './common.js';
import { ORGANISATION_AUDIT } from './organisation.audit.js';
import type { OrganisationOut, PatchOrganisationBody, Status } from './organisation.schema.js';

/**
 * The organisation (Spec P3 §4.1): one row per deployment. The database refuses a second row (generated
 * singleton key), the seed creates the first, and the API refuses to start without exactly one.
 *
 * country_id and base_currency_id stay NULL until P1.10 creates country and currency; base_currency_id
 * becomes immutable once any journal exists (P3 §4.1), which P3 accounting enforces.
 */

type OrganisationOutT = z.infer<typeof OrganisationOut>;

export function toOrganisationOut(o: Organisation): OrganisationOutT {
  return {
    id: o.id.toString(),
    name: o.name,
    short_name: o.shortName,
    registration_number: o.registrationNumber,
    tin: o.tin,
    vat_registration: o.vatRegistration,
    address_line1: o.addressLine1,
    address_line2: o.addressLine2,
    city: o.city,
    postal_code: o.postalCode,
    country_id: idOut(o.countryId),
    phone: o.phone,
    email: o.email,
    website: o.website,
    logo_path: o.logoPath,
    base_currency_id: idOut(o.baseCurrencyId),
    fiscal_year_start_month: o.fiscalYearStartMonth,
    status: o.status as Status,
    version: o.version,
    updated_at: iso(o.updatedAt),
  };
}

async function theOrganisation(tx: Database | Tx): Promise<Organisation> {
  const org = await tx.organisation.findFirst();
  if (!org) throw new Error('the organisation row is missing: run the seed (npm run db:seed)');
  return org;
}

export function organisationService(db: Database) {
  return {
    async get(): Promise<OrganisationOutT> {
      return toOrganisationOut(await theOrganisation(db));
    },

    async update(
      expectedVersion: number,
      b: z.infer<typeof PatchOrganisationBody>,
      actorId: bigint,
    ): Promise<OrganisationOutT> {
      return withTransaction(db, async (tx) => {
        const before = await theOrganisation(tx);
        const data: Prisma.OrganisationUncheckedUpdateManyInput = {
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.short_name !== undefined ? { shortName: b.short_name } : {}),
          ...(b.registration_number !== undefined ? { registrationNumber: b.registration_number } : {}),
          ...(b.tin !== undefined ? { tin: b.tin } : {}),
          ...(b.vat_registration !== undefined ? { vatRegistration: b.vat_registration } : {}),
          ...(b.address_line1 !== undefined ? { addressLine1: b.address_line1 } : {}),
          ...(b.address_line2 !== undefined ? { addressLine2: b.address_line2 } : {}),
          ...(b.city !== undefined ? { city: b.city } : {}),
          ...(b.postal_code !== undefined ? { postalCode: b.postal_code } : {}),
          ...(b.phone !== undefined ? { phone: b.phone } : {}),
          ...(b.email !== undefined ? { email: b.email } : {}),
          ...(b.website !== undefined ? { website: b.website } : {}),
          ...(b.fiscal_year_start_month !== undefined
            ? { fiscalYearStartMonth: b.fiscal_year_start_month }
            : {}),
        };
        const { count } = await tx.organisation.updateMany({
          where: { id: before.id, version: expectedVersion },
          data: { ...data, version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId },
        });
        if (count !== 1) versionConflict(before, toOrganisationOut(before));
        const after = toOrganisationOut(await theOrganisation(tx));
        await auditUpdate(tx, ORGANISATION_AUDIT, before.id, toOrganisationOut(before), after, { actorId });
        return after;
      });
    },
  };
}

/** Why the API must not start, or null (P3 §4.1: "refuses to start with zero or more than one row"). */
export async function organisationStartupProblem(db: Database): Promise<string | null> {
  const count = await db.organisation.count();
  if (count === 1) return null;
  return count === 0
    ? 'No organisation row: run the seed (npm run db:seed) before starting the API.'
    : `Found ${String(count)} organisation rows; exactly one is allowed.`;
}

/**
 * Creates the organisation row if there is none, with placeholders an administrator replaces through
 * PUT /organisation (BACKLOG D-1.07-3). Never changes an existing row.
 */
export const organisationSeeder: Seeder = {
  name: 'organisation: the singleton row',
  async run(tx) {
    if ((await tx.organisation.count()) > 0) return { inserted: 0, updated: 0 };
    await tx.organisation.create({
      data: {
        name: 'Organisation',
        shortName: 'ORG',
        // July–June, Bangladesh's fiscal year; confirmed or changed during implementation.
        fiscalYearStartMonth: 7,
        status: 'active',
        createdBy: BOOTSTRAP_ADMIN_ID,
      },
    });
    return { inserted: 1, updated: 0 };
  },
};
