import type { z } from 'zod';

import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { businessDateToDb } from '../../core/time/dates.js';
import type { Factory, Party, Prisma, Warehouse } from '../../generated/prisma/client.js';
import {
  area,
  day,
  duplicate,
  idIn,
  idOut,
  inUse,
  iso,
  referenced,
  versionConflict,
} from '../organisation/common.js';
import { removeContactsOf, type ContactOwner } from './contacts.service.js';
import type {
  CreateFactoryBody,
  CreatePartyBody,
  CreateWarehouseBody,
  FactoryOut,
  PartyOut,
  PatchFactoryBody,
  PatchPartyBody,
  PatchWarehouseBody,
  Status,
  WarehouseOut,
} from './facilities.schema.js';

/**
 * Factories and warehouses (Spec P3 §4.6–§4.7, facility tier) and parties (P3 §6.1, organisation tier).
 *
 *   - Masters: If-Match, every significant change audited, status history; deactivated rather than
 *     deleted once referenced. DELETE refuses while a scope grant names a facility; an owner's contacts
 *     are deleted with it.
 *   - Scope (facilities.scope.ts): a factory or warehouse grant reaches that facility only. Creating one
 *     needs all_estates; the extension refuses anyone else.
 *   - factory.primary_estate_id must be an estate the caller can see; it never decides scope.
 *   - warehouse.phone is the primary contact's phone, written only by the contacts service.
 */

type FactoryOutT = z.infer<typeof FactoryOut>;
type WarehouseOutT = z.infer<typeof WarehouseOut>;
type PartyOutT = z.infer<typeof PartyOut>;

export const FACTORY_AUDIT: AuditedRecord = {
  type: 'factory',
  class: 'master',
  fields: [
    'code',
    'name',
    'factory_type',
    'primary_estate_id',
    'location',
    'daily_capacity_kg',
    'manager_profile_id',
    'licence_number',
    'licence_expiry',
    'status',
  ],
};
export const WAREHOUSE_AUDIT: AuditedRecord = {
  type: 'warehouse',
  class: 'master',
  fields: [
    'code',
    'name',
    'warehouse_type',
    'location',
    'capacity_kg',
    'keeper_profile_id',
    'licence_number',
    'licence_expiry',
    'tin',
    'vat_registration',
    'status',
  ],
};
/** national_id is personal data: its presence is audited, never its value (P6 §11.3). */
export const PARTY_AUDIT: AuditedRecord = {
  type: 'party',
  class: 'master',
  fields: [
    'party_type',
    'code',
    'name',
    'has_national_id',
    'registration_number',
    'address_line1',
    'district',
    'phone',
    'email',
    'status',
  ],
};
const partyAuditValues = (p: PartyOutT) => ({
  ...p,
  national_id: undefined,
  has_national_id: p.national_id !== null,
});

const date = (v: string | null): Date | null => (v === null ? null : businessDateToDb(v as never));
const stamp = (actorId: bigint) => ({ version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId });

export const FACTORY_LIST_FIELDS: ListFieldMap = {
  status: { field: 'status' },
  code: { field: 'code' },
  name: { field: 'name' },
  factory_type: { field: 'factoryType' },
  licence_expiry: { field: 'licenceExpiry', convert: (v) => businessDateToDb(String(v) as never) },
};
export const WAREHOUSE_LIST_FIELDS: ListFieldMap = {
  status: { field: 'status' },
  code: { field: 'code' },
  name: { field: 'name' },
  warehouse_type: { field: 'warehouseType' },
  licence_expiry: { field: 'licenceExpiry', convert: (v) => businessDateToDb(String(v) as never) },
};
export const PARTY_LIST_FIELDS: ListFieldMap = {
  status: { field: 'status' },
  code: { field: 'code' },
  name: { field: 'name' },
  party_type: { field: 'partyType' },
  district: { field: 'district' },
};

export function toFactoryOut(f: Factory): FactoryOutT {
  return {
    id: f.id.toString(),
    code: f.code,
    name: f.name,
    factory_type: f.factoryType as FactoryOutT['factory_type'],
    primary_estate_id: idOut(f.primaryEstateId),
    location: f.location,
    daily_capacity_kg: area(f.dailyCapacityKg),
    manager_profile_id: idOut(f.managerProfileId),
    licence_number: f.licenceNumber,
    licence_expiry: day(f.licenceExpiry),
    status: f.status as Status,
    version: f.version,
    created_at: f.createdAt.toISOString(),
    updated_at: iso(f.updatedAt),
  };
}

export function toWarehouseOut(w: Warehouse): WarehouseOutT {
  return {
    id: w.id.toString(),
    code: w.code,
    name: w.name,
    warehouse_type: w.warehouseType as WarehouseOutT['warehouse_type'],
    location: w.location,
    capacity_kg: area(w.capacityKg),
    keeper_profile_id: idOut(w.keeperProfileId),
    phone: w.phone,
    licence_number: w.licenceNumber,
    licence_expiry: day(w.licenceExpiry),
    tin: w.tin,
    vat_registration: w.vatRegistration,
    status: w.status as Status,
    version: w.version,
    created_at: w.createdAt.toISOString(),
    updated_at: iso(w.updatedAt),
  };
}

export function toPartyOut(p: Party): PartyOutT {
  return {
    id: p.id.toString(),
    party_type: p.partyType as PartyOutT['party_type'],
    code: p.code,
    name: p.name,
    national_id: p.nationalId,
    registration_number: p.registrationNumber,
    address_line1: p.addressLine1,
    district: p.district,
    phone: p.phone,
    email: p.email,
    status: p.status as Status,
    version: p.version,
    created_at: p.createdAt.toISOString(),
    updated_at: iso(p.updatedAt),
  };
}

async function organisationId(tx: Tx): Promise<bigint> {
  const org = await tx.organisation.findFirst({ select: { id: true } });
  if (!org) throw new Error('the organisation row is missing: run the seed (npm run db:seed)');
  return org.id;
}

async function assertNoGrants(tx: Tx, type: 'factory' | 'warehouse', id: bigint) {
  if ((await tx.userScope.count({ where: { scopeType: type, scopeId: id } })) > 0)
    throw inUse(type, 'user scope grants');
}

/** primary_estate_id must name an estate the caller can see (it is informational, never a scope). */
async function assertEstate(tx: Tx, id: bigint | null | undefined) {
  if (id === null || id === undefined) return;
  if ((await tx.estate.count({ where: { id } })) !== 1) {
    throw Errors.validation([
      { field: 'primary_estate_id', code: 'VALIDATION_FAILED', message: 'No such estate.' },
    ]);
  }
}

export function facilitiesService(db: Database) {
  const factoryData = (b: z.infer<typeof PatchFactoryBody>): Prisma.FactoryUncheckedUpdateManyInput => ({
    ...(b.code !== undefined ? { code: b.code } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.factory_type !== undefined ? { factoryType: b.factory_type } : {}),
    ...(b.primary_estate_id !== undefined ? { primaryEstateId: idIn(b.primary_estate_id) } : {}),
    ...(b.location !== undefined ? { location: b.location } : {}),
    ...(b.daily_capacity_kg !== undefined ? { dailyCapacityKg: b.daily_capacity_kg } : {}),
    ...(b.manager_profile_id !== undefined ? { managerProfileId: idIn(b.manager_profile_id) } : {}),
    ...(b.licence_number !== undefined ? { licenceNumber: b.licence_number } : {}),
    ...(b.licence_expiry !== undefined ? { licenceExpiry: date(b.licence_expiry) } : {}),
  });
  const warehouseData = (
    b: z.infer<typeof PatchWarehouseBody>,
  ): Prisma.WarehouseUncheckedUpdateManyInput => ({
    ...(b.code !== undefined ? { code: b.code } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.warehouse_type !== undefined ? { warehouseType: b.warehouse_type } : {}),
    ...(b.location !== undefined ? { location: b.location } : {}),
    ...(b.capacity_kg !== undefined ? { capacityKg: b.capacity_kg } : {}),
    ...(b.keeper_profile_id !== undefined ? { keeperProfileId: idIn(b.keeper_profile_id) } : {}),
    ...(b.licence_number !== undefined ? { licenceNumber: b.licence_number } : {}),
    ...(b.licence_expiry !== undefined ? { licenceExpiry: date(b.licence_expiry) } : {}),
    ...(b.tin !== undefined ? { tin: b.tin } : {}),
    ...(b.vat_registration !== undefined ? { vatRegistration: b.vat_registration } : {}),
  });
  const partyData = (b: z.infer<typeof PatchPartyBody>): Prisma.PartyUncheckedUpdateManyInput => ({
    ...(b.party_type !== undefined ? { partyType: b.party_type } : {}),
    ...(b.code !== undefined ? { code: b.code } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.national_id !== undefined ? { nationalId: b.national_id } : {}),
    ...(b.registration_number !== undefined ? { registrationNumber: b.registration_number } : {}),
    ...(b.address_line1 !== undefined ? { addressLine1: b.address_line1 } : {}),
    ...(b.district !== undefined ? { district: b.district } : {}),
    ...(b.phone !== undefined ? { phone: b.phone } : {}),
    ...(b.email !== undefined ? { email: b.email } : {}),
  });

  async function factoryOrNotFound(tx: Database | Tx, id: bigint) {
    const f = await tx.factory.findUnique({ where: { id } });
    if (!f) throw Errors.notFound('Factory not found.');
    return f;
  }
  async function warehouseOrNotFound(tx: Database | Tx, id: bigint) {
    const w = await tx.warehouse.findUnique({ where: { id } });
    if (!w) throw Errors.notFound('Warehouse not found.');
    return w;
  }
  async function partyOrNotFound(tx: Database | Tx, id: bigint) {
    const p = await tx.party.findUnique({ where: { id } });
    if (!p) throw Errors.notFound('Party not found.');
    return p;
  }

  const factories = {
    async list(q: ListQuery) {
      const where = toWhere(q, FACTORY_LIST_FIELDS) as Prisma.FactoryWhereInput;
      const [rows, total] = await Promise.all([
        db.factory.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, FACTORY_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.factory.count({ where }),
      ]);
      return { items: rows.map(toFactoryOut), total };
    },
    async get(id: bigint) {
      return toFactoryOut(await factoryOrNotFound(db, id));
    },
    async create(body: z.infer<typeof CreateFactoryBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await assertEstate(tx, body.primary_estate_id);
        const { id } = await tx.factory
          .create({
            data: {
              ...(factoryData(body) as Prisma.FactoryUncheckedCreateInput),
              code: body.code,
              name: body.name,
              factoryType: body.factory_type,
              organisationId: await organisationId(tx),
              status: 'active',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Factory code ${body.code}`));
        const out = toFactoryOut(await factoryOrNotFound(tx, id));
        await auditCreate(tx, FACTORY_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, FACTORY_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },
    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchFactoryBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await factoryOrNotFound(tx, id);
        await assertEstate(tx, changes.primary_estate_id);
        const { count } = await tx.factory
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...factoryData(changes), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Factory code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, toFactoryOut(before));
        const after = toFactoryOut(await factoryOrNotFound(tx, id));
        await auditUpdate(tx, FACTORY_AUDIT, id, toFactoryOut(before), after, { actorId });
        return after;
      });
    },
    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await factoryOrNotFound(tx, id);
        if (before.version !== expectedVersion) versionConflict(before, toFactoryOut(before));
        if (before.status === status) return toFactoryOut(before);
        await tx.factory.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toFactoryOut(await factoryOrNotFound(tx, id));
        await auditUpdate(tx, FACTORY_AUDIT, id, toFactoryOut(before), after, { actorId });
        await recordStatusChange(tx, FACTORY_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const f = await factoryOrNotFound(tx, id);
        await assertNoGrants(tx, 'factory', id);
        await tx.factory.delete({ where: { id } }).catch(referenced('factory'));
        await auditDelete(tx, FACTORY_AUDIT, id, toFactoryOut(f), { actorId });
      });
    },
  };

  const warehouses = {
    async list(q: ListQuery) {
      const where = toWhere(q, WAREHOUSE_LIST_FIELDS) as Prisma.WarehouseWhereInput;
      const [rows, total] = await Promise.all([
        db.warehouse.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, WAREHOUSE_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.warehouse.count({ where }),
      ]);
      return { items: rows.map(toWarehouseOut), total };
    },
    async get(id: bigint) {
      return toWarehouseOut(await warehouseOrNotFound(db, id));
    },
    async create(body: z.infer<typeof CreateWarehouseBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const { id } = await tx.warehouse
          .create({
            data: {
              ...(warehouseData(body) as Prisma.WarehouseUncheckedCreateInput),
              code: body.code,
              name: body.name,
              warehouseType: body.warehouse_type,
              organisationId: await organisationId(tx),
              status: 'active',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Warehouse code ${body.code}`));
        const out = toWarehouseOut(await warehouseOrNotFound(tx, id));
        await auditCreate(tx, WAREHOUSE_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, WAREHOUSE_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },
    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchWarehouseBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await warehouseOrNotFound(tx, id);
        const { count } = await tx.warehouse
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...warehouseData(changes), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Warehouse code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, toWarehouseOut(before));
        const after = toWarehouseOut(await warehouseOrNotFound(tx, id));
        await auditUpdate(tx, WAREHOUSE_AUDIT, id, toWarehouseOut(before), after, { actorId });
        return after;
      });
    },
    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await warehouseOrNotFound(tx, id);
        if (before.version !== expectedVersion) versionConflict(before, toWarehouseOut(before));
        if (before.status === status) return toWarehouseOut(before);
        await tx.warehouse.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toWarehouseOut(await warehouseOrNotFound(tx, id));
        await auditUpdate(tx, WAREHOUSE_AUDIT, id, toWarehouseOut(before), after, { actorId });
        await recordStatusChange(tx, WAREHOUSE_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const w = await warehouseOrNotFound(tx, id);
        await assertNoGrants(tx, 'warehouse', id);
        await removeContactsOf(tx, 'warehouse', id, actorId);
        await tx.warehouse.delete({ where: { id } }).catch(referenced('warehouse'));
        await auditDelete(tx, WAREHOUSE_AUDIT, id, toWarehouseOut(w), { actorId });
      });
    },
  };

  const parties = {
    async list(q: ListQuery) {
      const where = toWhere(q, PARTY_LIST_FIELDS) as Prisma.PartyWhereInput;
      const [rows, total] = await Promise.all([
        db.party.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, PARTY_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.party.count({ where }),
      ]);
      return { items: rows.map(toPartyOut), total };
    },
    async get(id: bigint) {
      return toPartyOut(await partyOrNotFound(db, id));
    },
    async create(body: z.infer<typeof CreatePartyBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const { id } = await tx.party
          .create({
            data: {
              ...(partyData(body) as Prisma.PartyUncheckedCreateInput),
              code: body.code,
              name: body.name,
              partyType: body.party_type,
              status: 'active',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Party code ${body.code}`));
        const out = toPartyOut(await partyOrNotFound(tx, id));
        await auditCreate(tx, PARTY_AUDIT, id, partyAuditValues(out), { actorId });
        await recordStatusChange(tx, PARTY_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },
    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchPartyBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await partyOrNotFound(tx, id);
        const { count } = await tx.party
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...partyData(changes), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Party code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, toPartyOut(before));
        const after = toPartyOut(await partyOrNotFound(tx, id));
        await auditUpdate(
          tx,
          PARTY_AUDIT,
          id,
          partyAuditValues(toPartyOut(before)),
          partyAuditValues(after),
          { actorId },
        );
        return after;
      });
    },
    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await partyOrNotFound(tx, id);
        if (before.version !== expectedVersion) versionConflict(before, toPartyOut(before));
        if (before.status === status) return toPartyOut(before);
        await tx.party.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toPartyOut(await partyOrNotFound(tx, id));
        await auditUpdate(
          tx,
          PARTY_AUDIT,
          id,
          partyAuditValues(toPartyOut(before)),
          partyAuditValues(after),
          { actorId },
        );
        await recordStatusChange(tx, PARTY_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const p = await partyOrNotFound(tx, id);
        await removeContactsOf(tx, 'party', id, actorId);
        await tx.party.delete({ where: { id } }).catch(referenced('party'));
        await auditDelete(tx, PARTY_AUDIT, id, partyAuditValues(toPartyOut(p)), { actorId });
      });
    },
  };

  /** The contact owners that exist so far. buyer, broker, supplier, … join with their modules. */
  const owners = {
    warehouse: {
      type: 'warehouse',
      module: 'warehouse',
      exists: async (tx, id) => (await tx.warehouse.count({ where: { id } })) === 1,
      // P3 §8 note: warehouse.phone is the primary contact's. No version bump: it is a derived copy.
      syncPrimary: async (tx, ownerId, primary) => {
        await tx.warehouse.update({ where: { id: ownerId }, data: { phone: primary?.phone ?? null } });
      },
    },
    party: {
      type: 'party',
      module: 'land',
      exists: async (tx, id) => (await tx.party.count({ where: { id } })) === 1,
    },
  } satisfies Record<string, ContactOwner>;

  return { factories, warehouses, parties, owners };
}
