import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import { auditCreate, auditDelete, auditUpdate, recordStatusChange } from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { Errors } from '../../core/errors/app-error.js';
import { dec } from '../../core/money/decimal.js';
import { runUnscoped } from '../../core/scope/scope.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Division, Estate, Prisma, Section } from '../../generated/prisma/client.js';
import { archiveDocumentsOf } from '../documents/documents.service.js';
import { removeContactsOf } from '../facilities/contacts.service.js';
import {
  area,
  assertNoScopeGrants,
  denyWrite,
  duplicate,
  idIn,
  idOut,
  inactiveParent,
  iso,
  referenced,
  versionConflict,
  writable,
} from './common.js';
import { DIVISION_AUDIT, ESTATE_AUDIT, SECTION_AUDIT } from './organisation.audit.js';
import type {
  CreateDivisionBody,
  CreateEstateBody,
  CreateSectionBody,
  DivisionOut,
  EstateOut,
  EstateSummaryOut,
  PatchDivisionBody,
  PatchEstateBody,
  PatchSectionBody,
  SectionOut,
  Status,
} from './organisation.schema.js';

/**
 * Estates, divisions and sections (Spec P3 §4.2–§4.4, P1 §5.1, P4 §7.1).
 *
 *   - Masters: edited with If-Match, every significant change audited, status changes in status_history.
 *   - Deactivated, never deleted, once referenced (P1 §5.1). DELETE exists for a node created in error:
 *     refused (REFERENCED_RECORD) while it has children, fields or scope grants.
 *   - A node is created or reactivated only under an ACTIVE parent.
 *   - Scope: reads follow the extension (organisation.scope.ts). Writes are checked by level: an estate
 *     needs an estate grant, a division its estate or itself, a section its estate, division or itself.
 */

type EstateOutT = z.infer<typeof EstateOut>;
type DivisionOutT = z.infer<typeof DivisionOut>;
type SectionOutT = z.infer<typeof SectionOut>;
type SectionRow = Section & { division: { estateId: bigint } };

export const ESTATE_LIST_FIELDS: ListFieldMap = {
  status: { field: 'status' },
  code: { field: 'code' },
  name: { field: 'name' },
  district: { field: 'district' },
};
export const NODE_LIST_FIELDS: ListFieldMap = {
  status: { field: 'status' },
  code: { field: 'code' },
  name: { field: 'name' },
};

/** An estate with its amenities, as every estate read loads it. */
export type EstateRow = Estate & { amenityLinks: { amenity: { id: bigint; code: string; name: string } }[] };
export const estateInclude = {
  amenityLinks: {
    include: { amenity: { select: { id: true, code: true, name: true, sortOrder: true } } },
    orderBy: [{ amenity: { sortOrder: 'asc' } }, { amenityId: 'asc' }],
  },
} as const satisfies Prisma.EstateInclude;

const LEGACY_OWNERSHIP: Record<string, EstateOutT['estate_type']> = {
  owned: 'company_owned',
  government_lease: 'government_estate',
  leased: 'private_estate',
  other: null,
};
const OWNERSHIP_OF: Record<string, EstateOutT['ownership_type']> = {
  company_owned: 'owned',
  government_estate: 'government_lease',
  private_estate: 'leased',
};

export function toEstateOut(e: EstateRow): EstateOutT {
  return {
    id: e.id.toString(),
    organisation_id: e.organisationId.toString(),
    code: e.code,
    name: e.name,
    location: e.location,
    address_line1: e.addressLine1,
    district: e.district,
    total_area: area(e.totalArea),
    manager_profile_id: idOut(e.managerProfileId),
    phone: e.phone,
    email: e.email,
    established_on: e.establishedYear === null ? null : `${String(e.establishedYear)}-01-01`,
    ownership_type: e.estateType === null ? null : (OWNERSHIP_OF[e.estateType] ?? null),
    status: e.status as Status,
    remarks: e.remarks,
    established_year: e.establishedYear,
    owner_name: e.ownerName,
    estate_type: e.estateType as EstateOutT['estate_type'],
    estate_category: e.estateCategory as EstateOutT['estate_category'],
    police_station: e.policeStation,
    admin_division: e.adminDivision,
    country_id: idOut(e.countryId),
    postal_code: e.postalCode,
    website: e.website,
    latitude: e.latitude === null ? null : e.latitude.toFixed(6),
    longitude: e.longitude === null ? null : e.longitude.toFixed(6),
    description: e.description,
    amenities: e.amenityLinks.map((l) => ({
      id: l.amenity.id.toString(),
      code: l.amenity.code,
      name: l.amenity.name,
    })),
    other_amenities: e.otherAmenities,
    version: e.version,
    created_at: e.createdAt.toISOString(),
    updated_at: iso(e.updatedAt),
  };
}

export function toDivisionOut(d: Division): DivisionOutT {
  return {
    id: d.id.toString(),
    estate_id: d.estateId.toString(),
    code: d.code,
    name: d.name,
    manager_profile_id: idOut(d.managerProfileId),
    area: area(d.area),
    status: d.status as Status,
    version: d.version,
    created_at: d.createdAt.toISOString(),
    updated_at: iso(d.updatedAt),
  };
}

export function toSectionOut(s: SectionRow): SectionOutT {
  return {
    id: s.id.toString(),
    division_id: s.divisionId.toString(),
    estate_id: s.division.estateId.toString(),
    code: s.code,
    name: s.name,
    supervisor_profile_id: idOut(s.supervisorProfileId),
    area: area(s.area),
    status: s.status as Status,
    version: s.version,
    created_at: s.createdAt.toISOString(),
    updated_at: iso(s.updatedAt),
  };
}

const sectionInclude = { division: { select: { estateId: true } } } as const;

/** The singleton organisation's id (P3 §4.1). The API refuses to start without it, so this is a guard. */
async function organisationId(tx: Tx): Promise<bigint> {
  const org = await tx.organisation.findFirst({ select: { id: true } });
  if (!org) throw new Error('the organisation row is missing: run the seed (npm run db:seed)');
  return org.id;
}

export function hierarchyService(db: Database, accessLog: AccessLog) {
  // ---- loaders (scoped reads: out of scope is 404) ---------------------------------------------
  async function estateOrNotFound(tx: Database | Tx, id: bigint): Promise<EstateRow> {
    const e = await tx.estate.findUnique({ where: { id }, include: estateInclude });
    if (!e) throw Errors.notFound('Estate not found.');
    return e;
  }
  async function divisionOrNotFound(tx: Database | Tx, id: bigint): Promise<Division> {
    const d = await tx.division.findUnique({ where: { id } });
    if (!d) throw Errors.notFound('Division not found.');
    return d;
  }
  async function sectionOrNotFound(tx: Database | Tx, id: bigint): Promise<SectionRow> {
    const s = await tx.section.findUnique({ where: { id }, include: sectionInclude });
    if (!s) throw Errors.notFound('Section not found.');
    return s;
  }

  // ---- write-level checks ------------------------------------------------------------------------
  const canWriteEstate = (e: Estate) => writable({ estate: e.id });
  const canWriteDivision = (d: Division) => writable({ estate: d.estateId, division: d.id });
  const canWriteSection = (s: SectionRow) =>
    writable({ estate: s.division.estateId, division: s.divisionId, section: s.id });

  const estateData = (b: z.infer<typeof PatchEstateBody>): Prisma.EstateUncheckedUpdateManyInput => ({
    ...(b.code !== undefined ? { code: b.code } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.location !== undefined ? { location: b.location } : {}),
    ...(b.address_line1 !== undefined ? { addressLine1: b.address_line1 } : {}),
    ...(b.district !== undefined ? { district: b.district } : {}),
    ...(b.total_area !== undefined ? { totalArea: b.total_area } : {}),
    ...(b.manager_profile_id !== undefined ? { managerProfileId: idIn(b.manager_profile_id) } : {}),
    ...(b.phone !== undefined ? { phone: b.phone } : {}),
    ...(b.email !== undefined ? { email: b.email } : {}),
    ...(b.remarks !== undefined ? { remarks: b.remarks } : {}),
    // The deprecated fields first, so the new ones win when both are sent.
    ...(b.established_on !== undefined
      ? { establishedYear: b.established_on === null ? null : Number(b.established_on.slice(0, 4)) }
      : {}),
    ...(b.ownership_type !== undefined
      ? { estateType: b.ownership_type === null ? null : (LEGACY_OWNERSHIP[b.ownership_type] ?? null) }
      : {}),
    ...(b.established_year !== undefined ? { establishedYear: b.established_year } : {}),
    ...(b.owner_name !== undefined ? { ownerName: b.owner_name } : {}),
    ...(b.estate_type !== undefined ? { estateType: b.estate_type } : {}),
    ...(b.estate_category !== undefined ? { estateCategory: b.estate_category } : {}),
    ...(b.police_station !== undefined ? { policeStation: b.police_station } : {}),
    ...(b.admin_division !== undefined ? { adminDivision: b.admin_division } : {}),
    ...(b.country_id !== undefined ? { countryId: idIn(b.country_id) } : {}),
    ...(b.postal_code !== undefined ? { postalCode: b.postal_code } : {}),
    ...(b.website !== undefined ? { website: b.website } : {}),
    ...(b.latitude !== undefined ? { latitude: b.latitude } : {}),
    ...(b.longitude !== undefined ? { longitude: b.longitude } : {}),
    ...(b.description !== undefined ? { description: b.description } : {}),
    ...(b.other_amenities !== undefined ? { otherAmenities: b.other_amenities } : {}),
  });

  /** The checks a CHECK constraint cannot make, as field errors the form can show. */
  async function checkEstate(tx: Tx, b: z.infer<typeof PatchEstateBody>, current?: EstateRow) {
    const problems: { field: string; code: string; message: string }[] = [];
    if (
      b.established_year !== undefined &&
      b.established_year !== null &&
      b.established_year > new Date().getUTCFullYear()
    ) {
      problems.push({
        field: 'established_year',
        code: 'VALIDATION_FAILED',
        message: 'Cannot be in the future.',
      });
    }
    const lat = b.latitude !== undefined ? b.latitude : (current?.latitude ?? null);
    const lng = b.longitude !== undefined ? b.longitude : (current?.longitude ?? null);
    if ((lat === null) !== (lng === null)) {
      const field = lat === null ? 'latitude' : 'longitude';
      problems.push({
        field,
        code: 'VALIDATION_FAILED',
        message: 'Give both latitude and longitude, or neither.',
      });
    }
    if (
      b.country_id !== undefined &&
      b.country_id !== null &&
      (await tx.country.count({ where: { id: b.country_id } })) === 0
    ) {
      problems.push({ field: 'country_id', code: 'VALIDATION_FAILED', message: 'No such country.' });
    }
    if (b.amenity_ids !== undefined) {
      const wanted = [...new Set(b.amenity_ids.map(String))];
      const keep = new Set((current?.amenityLinks ?? []).map((l) => l.amenity.id.toString()));
      const found = await tx.amenity.findMany({
        where: { id: { in: wanted.map((v) => BigInt(v)) } },
        select: { id: true, status: true },
      });
      const usable = new Set(
        found.filter((a) => a.status === 'active' || keep.has(a.id.toString())).map((a) => a.id.toString()),
      );
      wanted.forEach((v, i) => {
        if (!usable.has(v)) {
          problems.push({
            field: `amenity_ids.${String(i)}`,
            code: 'VALIDATION_FAILED',
            message: 'No such active facility.',
          });
        }
      });
    }
    if (problems.length > 0) throw Errors.validation(problems);
  }

  /** Replaces the estate's amenity set. */
  async function setAmenities(tx: Tx, estateId: bigint, ids: readonly bigint[] | undefined, actorId: bigint) {
    if (ids === undefined) return;
    const wanted = [...new Set(ids)];
    await tx.estateAmenity.deleteMany({ where: { estateId, amenityId: { notIn: wanted } } });
    const have = new Set(
      (await tx.estateAmenity.findMany({ where: { estateId }, select: { amenityId: true } })).map(
        (l) => l.amenityId,
      ),
    );
    const add = wanted.filter((id) => !have.has(id));
    if (add.length > 0) {
      await tx.estateAmenity.createMany({
        data: add.map((amenityId) => ({ estateId, amenityId, createdBy: actorId })),
      });
    }
  }
  const divisionData = (b: z.infer<typeof PatchDivisionBody>): Prisma.DivisionUncheckedUpdateManyInput => ({
    ...(b.code !== undefined ? { code: b.code } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.manager_profile_id !== undefined ? { managerProfileId: idIn(b.manager_profile_id) } : {}),
    ...(b.area !== undefined ? { area: b.area } : {}),
  });
  const sectionData = (b: z.infer<typeof PatchSectionBody>): Prisma.SectionUncheckedUpdateManyInput => ({
    ...(b.code !== undefined ? { code: b.code } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.supervisor_profile_id !== undefined ? { supervisorProfileId: idIn(b.supervisor_profile_id) } : {}),
    ...(b.area !== undefined ? { area: b.area } : {}),
  });
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  const estates = {
    async list(q: ListQuery) {
      const where = toWhere(q, ESTATE_LIST_FIELDS) as Prisma.EstateWhereInput;
      const [rows, total] = await Promise.all([
        db.estate.findMany({
          where,
          include: estateInclude,
          orderBy: [...toOrderBy(q.sort, ESTATE_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.estate.count({ where }),
      ]);
      return { items: rows.map(toEstateOut), total };
    },

    async get(id: bigint) {
      return toEstateOut(await estateOrNotFound(db, id));
    },

    /** Only a user with access to all estates can add one (an estate grant cannot name it yet). */
    async create(body: z.infer<typeof CreateEstateBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await checkEstate(tx, body);
        const { id } = await tx.estate
          .create({
            data: {
              ...(estateData(body) as Prisma.EstateUncheckedCreateInput),
              code: body.code,
              name: body.name,
              organisationId: await organisationId(tx),
              status: 'active',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Estate code ${body.code}`));
        await setAmenities(tx, id, body.amenity_ids, actorId);
        const out = toEstateOut(await estateOrNotFound(tx, id));
        await auditCreate(tx, ESTATE_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, ESTATE_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchEstateBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await estateOrNotFound(tx, id);
        if (!(await canWriteEstate(before))) await denyWrite(accessLog, 'estate', id, 'update');
        await checkEstate(tx, changes, before);
        const { count } = await tx.estate
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...estateData(changes), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Estate code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, toEstateOut(before));
        await setAmenities(tx, id, changes.amenity_ids, actorId);
        const after = toEstateOut(await estateOrNotFound(tx, id));
        await auditUpdate(tx, ESTATE_AUDIT, id, toEstateOut(before), after, { actorId });
        return after;
      });
    },

    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await estateOrNotFound(tx, id);
        if (!(await canWriteEstate(before))) await denyWrite(accessLog, 'estate', id, status);
        if (before.version !== expectedVersion) versionConflict(before, toEstateOut(before));
        if (before.status === status) return toEstateOut(before);
        await tx.estate.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toEstateOut(await estateOrNotFound(tx, id));
        await auditUpdate(tx, ESTATE_AUDIT, id, toEstateOut(before), after, { actorId });
        await recordStatusChange(tx, ESTATE_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const e = await estateOrNotFound(tx, id);
        if (!(await canWriteEstate(e))) await denyWrite(accessLog, 'estate', id, 'delete');
        await assertNoScopeGrants(tx, 'estate', id, 'estate');
        await archiveDocumentsOf(tx, 'estate', id, actorId);
        await tx.estateAmenity.deleteMany({ where: { estateId: id } });
        await removeContactsOf(tx, 'estate', id, actorId);
        await tx.estate.delete({ where: { id } }).catch(referenced('estate'));
        await auditDelete(tx, ESTATE_AUDIT, id, toEstateOut(e), { actorId });
      });
    },
  };

  /**
   * The Estate Overview (R.2): computed from the records, never entered. Counts follow the caller's
   * scope like every read. Areas in acres.
   */
  async function estateSummary(id: bigint): Promise<z.infer<typeof EstateSummaryOut>> {
    const e = await estateOrNotFound(db, id);
    const activeFields = { estateId: id, status: 'active' };
    const [divisionCount, sectionCount, fieldCount, sums, teaSum, factoryCount, photoCount] =
      await Promise.all([
        db.division.count({ where: { estateId: id, status: 'active' } }),
        db.section.count({ where: { division: { estateId: id }, status: 'active' } }),
        db.field.count({ where: activeFields }),
        db.field.aggregate({ where: activeFields, _sum: { grossArea: true } }),
        // Fields that carry tea: not uprooted, fallow or abandoned.
        db.field.aggregate({
          where: { ...activeFields, fieldStatus: { notIn: ['uprooted', 'fallow', 'abandoned'] } },
          _sum: { plantedArea: true },
        }),
        // Factories are scoped by factory, not estate: count those of this (visible) estate regardless.
        runUnscoped('estate overview: the factories of an estate the caller can see', () =>
          db.factory.count({ where: { primaryEstateId: id, status: 'active' } }),
        ),
        db.documentFile.count({
          where: {
            ownerType: 'estate',
            ownerId: id,
            status: 'active',
            isCurrent: true,
            documentType: { code: 'PHOTOGRAPH' },
          },
        }),
      ]);
    const tea = dec(teaSum._sum.plantedArea?.toString() ?? '0');
    const total = e.totalArea === null ? null : dec(e.totalArea.toString());
    const nonTea = total === null ? null : total.minus(tea);
    return {
      estate_id: id.toString(),
      total_land_area: area(e.totalArea),
      tea_area: tea.toFixed(3),
      non_tea_area: nonTea === null ? null : (nonTea.isNegative() ? dec('0') : nonTea).toFixed(3),
      field_area: dec(sums._sum.grossArea?.toString() ?? '0').toFixed(3),
      division_count: divisionCount,
      section_count: sectionCount,
      field_count: fieldCount,
      factory_count: factoryCount,
      worker_count: 0,
      family_count: 0,
      workforce_available: false,
      photo_count: photoCount,
    };
  }

  const divisions = {
    async listFor(estateId: bigint, q: ListQuery) {
      await estateOrNotFound(db, estateId);
      const where: Prisma.DivisionWhereInput = { AND: [{ estateId }, toWhere(q, NODE_LIST_FIELDS)] };
      const [rows, total] = await Promise.all([
        db.division.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, NODE_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.division.count({ where }),
      ]);
      return { items: rows.map(toDivisionOut), total };
    },

    async get(id: bigint) {
      return toDivisionOut(await divisionOrNotFound(db, id));
    },

    async create(estateId: bigint, body: z.infer<typeof CreateDivisionBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const estate = await estateOrNotFound(tx, estateId);
        if (!(await canWriteEstate(estate))) await denyWrite(accessLog, 'division', null, 'create');
        if (estate.status !== 'active') throw inactiveParent('estate_id', 'estate');
        const { id } = await tx.division
          .create({
            data: {
              ...(divisionData(body) as Prisma.DivisionUncheckedCreateInput),
              code: body.code,
              name: body.name,
              estateId,
              status: 'active',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Division code ${body.code}`));
        const out = toDivisionOut(await divisionOrNotFound(tx, id));
        await auditCreate(tx, DIVISION_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, DIVISION_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchDivisionBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await divisionOrNotFound(tx, id);
        if (!(await canWriteDivision(before))) await denyWrite(accessLog, 'division', id, 'update');
        const { count } = await tx.division
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...divisionData(changes), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Division code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, toDivisionOut(before));
        const after = toDivisionOut(await divisionOrNotFound(tx, id));
        await auditUpdate(tx, DIVISION_AUDIT, id, toDivisionOut(before), after, { actorId });
        return after;
      });
    },

    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await divisionOrNotFound(tx, id);
        if (!(await canWriteDivision(before))) await denyWrite(accessLog, 'division', id, status);
        if (before.version !== expectedVersion) versionConflict(before, toDivisionOut(before));
        if (before.status === status) return toDivisionOut(before);
        if (status === 'active') {
          const estate = await tx.estate.findUnique({
            where: { id: before.estateId },
            select: { status: true },
          });
          if (estate?.status !== 'active') throw inactiveParent('estate_id', 'estate');
        }
        await tx.division.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toDivisionOut(await divisionOrNotFound(tx, id));
        await auditUpdate(tx, DIVISION_AUDIT, id, toDivisionOut(before), after, { actorId });
        await recordStatusChange(tx, DIVISION_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const d = await divisionOrNotFound(tx, id);
        if (!(await canWriteDivision(d))) await denyWrite(accessLog, 'division', id, 'delete');
        await assertNoScopeGrants(tx, 'division', id, 'division');
        await tx.division.delete({ where: { id } }).catch(referenced('division'));
        await auditDelete(tx, DIVISION_AUDIT, id, toDivisionOut(d), { actorId });
      });
    },
  };

  const sections = {
    async listFor(divisionId: bigint, q: ListQuery) {
      await divisionOrNotFound(db, divisionId);
      const where: Prisma.SectionWhereInput = { AND: [{ divisionId }, toWhere(q, NODE_LIST_FIELDS)] };
      const [rows, total] = await Promise.all([
        db.section.findMany({
          where,
          include: sectionInclude,
          orderBy: [...toOrderBy(q.sort, NODE_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.section.count({ where }),
      ]);
      return { items: rows.map(toSectionOut), total };
    },

    async get(id: bigint) {
      return toSectionOut(await sectionOrNotFound(db, id));
    },

    /** The extension cannot judge a section create (no estate_id), so this checks the division. */
    async create(divisionId: bigint, body: z.infer<typeof CreateSectionBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const division = await divisionOrNotFound(tx, divisionId);
        if (!(await canWriteDivision(division))) await denyWrite(accessLog, 'section', null, 'create');
        if (division.status !== 'active') throw inactiveParent('division_id', 'division');
        const { id } = await tx.section
          .create({
            data: {
              ...(sectionData(body) as Prisma.SectionUncheckedCreateInput),
              code: body.code,
              name: body.name,
              divisionId,
              status: 'active',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Section code ${body.code}`));
        const out = toSectionOut(await sectionOrNotFound(tx, id));
        await auditCreate(tx, SECTION_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, SECTION_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchSectionBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await sectionOrNotFound(tx, id);
        if (!(await canWriteSection(before))) await denyWrite(accessLog, 'section', id, 'update');
        const { count } = await tx.section
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...sectionData(changes), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Section code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, toSectionOut(before));
        const after = toSectionOut(await sectionOrNotFound(tx, id));
        await auditUpdate(tx, SECTION_AUDIT, id, toSectionOut(before), after, { actorId });
        return after;
      });
    },

    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await sectionOrNotFound(tx, id);
        if (!(await canWriteSection(before))) await denyWrite(accessLog, 'section', id, status);
        if (before.version !== expectedVersion) versionConflict(before, toSectionOut(before));
        if (before.status === status) return toSectionOut(before);
        if (status === 'active') {
          const division = await tx.division.findUnique({
            where: { id: before.divisionId },
            select: { status: true },
          });
          if (division?.status !== 'active') throw inactiveParent('division_id', 'division');
        }
        await tx.section.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toSectionOut(await sectionOrNotFound(tx, id));
        await auditUpdate(tx, SECTION_AUDIT, id, toSectionOut(before), after, { actorId });
        await recordStatusChange(tx, SECTION_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const s = await sectionOrNotFound(tx, id);
        if (!(await canWriteSection(s))) await denyWrite(accessLog, 'section', id, 'delete');
        await assertNoScopeGrants(tx, 'section', id, 'section');
        await tx.section.delete({ where: { id } }).catch(referenced('section'));
        await auditDelete(tx, SECTION_AUDIT, id, toSectionOut(s), { actorId });
      });
    },
  };

  return { estates, divisions, sections, sectionOrNotFound, estateSummary };
}

export type HierarchyService = ReturnType<typeof hierarchyService>;
