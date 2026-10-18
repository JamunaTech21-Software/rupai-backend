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
  assertProfileRef,
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
import {
  figuresOf,
  GeometryError,
  geometryFromKml,
  geometryFromPoints,
  parseGeometry,
  type Geometry,
} from '../../core/geo/geometry.js';
import { Prisma as P } from '../../generated/prisma/client.js';
import { DIVISION_AUDIT, ESTATE_AUDIT, SECTION_AUDIT } from './organisation.audit.js';
import { FIELD_TYPES, TEA_FIELD_TYPES, type FieldType } from './organisation.schema.js';
import type {
  BoundaryBody,
  EstateMapOut,
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
type SectionRow = Section & {
  division: { estateId: bigint };
  parent: { id: bigint; code: string; name: string } | null;
};
type DivisionRow = Division & { _count: { sections: number } };

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
    tea_area: area(e.teaArea),
    non_tea_area: area(e.nonTeaArea),
    division_count: e.divisionCount,
    section_count: e.sectionCount,
    field_count: e.fieldCount,
    worker_count: e.workerCount,
    family_count: e.familyCount,
    version: e.version,
    created_at: e.createdAt.toISOString(),
    updated_at: iso(e.updatedAt),
  };
}

export function toDivisionOut(d: DivisionRow): DivisionOutT {
  return {
    id: d.id.toString(),
    estate_id: d.estateId.toString(),
    code: d.code,
    name: d.name,
    manager_profile_id: idOut(d.managerProfileId),
    area: area(d.area),
    description: d.description,
    section_count: d._count.sections,
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
    parent_section_id: idOut(s.parentSectionId),
    parent_section: s.parent
      ? { id: s.parent.id.toString(), code: s.parent.code, name: s.parent.name }
      : null,
    description: s.description,
    has_boundary: s.boundary !== null,
    mapped_area_acres: area(s.mappedAreaAcres),
    status: s.status as Status,
    version: s.version,
    created_at: s.createdAt.toISOString(),
    updated_at: iso(s.updatedAt),
  };
}

const sectionInclude = {
  division: { select: { estateId: true } },
  parent: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.SectionInclude;
/** "Total Section" of a division: its active sections. */
const divisionInclude = {
  _count: { select: { sections: { where: { status: 'active' } } } },
} as const satisfies Prisma.DivisionInclude;

export const SECTION_LIST_FIELDS: ListFieldMap = {
  ...NODE_LIST_FIELDS,
  division_id: { field: 'divisionId', convert: (v) => BigInt(String(v)) },
  parent_section_id: { field: 'parentSectionId', convert: (v) => BigInt(String(v)) },
};

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
  async function divisionOrNotFound(tx: Database | Tx, id: bigint): Promise<DivisionRow> {
    const d = await tx.division.findUnique({ where: { id }, include: divisionInclude });
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
    ...(b.tea_area !== undefined ? { teaArea: b.tea_area } : {}),
    ...(b.non_tea_area !== undefined ? { nonTeaArea: b.non_tea_area } : {}),
    ...(b.division_count !== undefined ? { divisionCount: b.division_count } : {}),
    ...(b.section_count !== undefined ? { sectionCount: b.section_count } : {}),
    ...(b.field_count !== undefined ? { fieldCount: b.field_count } : {}),
    ...(b.worker_count !== undefined ? { workerCount: b.worker_count } : {}),
    ...(b.family_count !== undefined ? { familyCount: b.family_count } : {}),
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
    // Entered overview areas (RUP-625) fit inside the total land area, alone and together.
    const pick = (v: Prisma.Decimal | null | undefined, now: Prisma.Decimal | null | undefined) =>
      v !== undefined ? v : (now ?? null);
    const total = pick(b.total_area, current?.totalArea);
    const tea = pick(b.tea_area, current?.teaArea);
    const nonTea = pick(b.non_tea_area, current?.nonTeaArea);
    if (total !== null) {
      for (const [field, v] of [
        ['tea_area', tea],
        ['non_tea_area', nonTea],
      ] as const) {
        if (v !== null && dec(v).gt(dec(total))) {
          problems.push({ field, code: 'VALIDATION_FAILED', message: 'Cannot exceed the total land area.' });
        }
      }
      if (tea !== null && nonTea !== null && dec(tea).plus(dec(nonTea)).gt(dec(total))) {
        const field = b.non_tea_area !== undefined ? 'non_tea_area' : 'tea_area';
        problems.push({
          field,
          code: 'VALIDATION_FAILED',
          message: 'Tea and non-tea area together cannot exceed the total land area.',
        });
      }
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
    ...(b.description !== undefined ? { description: b.description } : {}),
  });
  const sectionData = (b: z.infer<typeof PatchSectionBody>): Prisma.SectionUncheckedUpdateManyInput => ({
    ...(b.code !== undefined ? { code: b.code } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.supervisor_profile_id !== undefined ? { supervisorProfileId: idIn(b.supervisor_profile_id) } : {}),
    ...(b.area !== undefined ? { area: b.area } : {}),
    ...(b.parent_section_id !== undefined ? { parentSectionId: idIn(b.parent_section_id) } : {}),
    ...(b.description !== undefined ? { description: b.description } : {}),
  });

  /**
   * A parent section: of the same division, not the section itself and not one of its own children
   * (no cycles). A CHECK cannot judge any of it.
   */
  async function checkParentSection(
    tx: Tx,
    parentId: bigint | null | undefined,
    divisionId: bigint,
    self?: bigint,
  ) {
    if (parentId === undefined || parentId === null) return;
    const bad = (message: string) =>
      Errors.validation([{ field: 'parent_section_id', code: 'VALIDATION_FAILED', message }]);
    const parent = await tx.section.findUnique({ where: { id: parentId }, select: { divisionId: true } });
    if (!parent) throw bad('No such section.');
    if (parent.divisionId !== divisionId) throw bad('The parent section must be in the same division.');
    if (self === undefined) return;
    const seen = new Set<bigint>();
    for (let at: bigint | null = parentId; at !== null;) {
      if (at === self || seen.has(at)) throw bad('A section cannot sit inside itself or one of its own.');
      seen.add(at);
      const row: { parentSectionId: bigint | null } | null = await tx.section.findUnique({
        where: { id: at },
        select: { parentSectionId: true },
      });
      at = row?.parentSectionId ?? null;
    }
  }
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
        if (body.manager_profile_id) {
          throw Errors.validation([
            {
              field: 'manager_profile_id',
              code: 'VALIDATION_FAILED',
              message: 'Name the manager once the estate exists and they are employed there.',
            },
          ]);
        }
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
        await assertProfileRef(tx, 'manager_profile_id', changes.manager_profile_id, id);
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
   * The Estate Overview (R.2, RUP-625) and the figures under the Division & Section and Field / Block
   * lists (R.3). Each overview figure is the entered one when the estate has it, otherwise computed from
   * the records. Counts follow the caller's scope like every read. Areas in acres.
   */
  async function estateSummary(id: bigint): Promise<z.infer<typeof EstateSummaryOut>> {
    const e = await estateOrNotFound(db, id);
    const activeFields = { estateId: id, status: 'active' };
    const [
      divisions,
      sections,
      fields,
      byType,
      sums,
      teaSum,
      divisionArea,
      sectionArea,
      factoryCount,
      photoCount,
    ] = await Promise.all([
      db.division.groupBy({ by: ['status'], where: { estateId: id }, _count: { _all: true } }),
      db.section.groupBy({ by: ['status'], where: { division: { estateId: id } }, _count: { _all: true } }),
      db.field.groupBy({ by: ['status'], where: { estateId: id }, _count: { _all: true } }),
      db.field.groupBy({ by: ['fieldType'], where: activeFields, _count: { _all: true } }),
      db.field.aggregate({ where: activeFields, _sum: { grossArea: true, plantedArea: true } }),
      // Tea area: tea fields still carrying tea (not uprooted, fallow or abandoned), D-R.3-3.
      db.field.aggregate({
        where: {
          ...activeFields,
          fieldType: { in: [...TEA_FIELD_TYPES] },
          fieldStatus: { notIn: ['uprooted', 'fallow', 'abandoned'] },
        },
        _sum: { plantedArea: true },
      }),
      db.division.aggregate({ where: { estateId: id, status: 'active' }, _sum: { area: true } }),
      db.section.aggregate({
        where: { division: { estateId: id }, status: 'active', area: { not: null } },
        _sum: { area: true },
        _count: { _all: true },
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
    // The estate's workforce (P2.02): its current workers (not separated) and their family members.
    const current = { estateId: id, employmentType: 'worker', status: { not: 'separated' } };
    const [workers, families] = await Promise.all([
      db.employmentProfile.count({ where: current }),
      db.personDependent.count({ where: { person: { profiles: { some: current } } } }),
    ]);
    const counts = (rows: { status: string; _count: { _all: number } }[]) => {
      const active = rows.find((r) => r.status === 'active')?._count._all ?? 0;
      const total = rows.reduce((n, r) => n + r._count._all, 0);
      return { total, active, inactive: total - active };
    };
    const acres = (v: Prisma.Decimal | null | undefined) => dec(v?.toString() ?? '0').toFixed(3);
    const d = counts(divisions);
    const sc = counts(sections);
    const f = counts(fields);

    const computedTea = dec(teaSum._sum.plantedArea?.toString() ?? '0');
    const total = e.totalArea === null ? null : dec(e.totalArea.toString());
    const tea = e.teaArea === null ? computedTea : dec(e.teaArea.toString());
    const remainder = (t: ReturnType<typeof dec>) => {
      if (total === null) return null;
      const r = total.minus(t);
      return (r.isNegative() ? dec('0') : r).toFixed(3);
    };
    const computed = {
      tea_area: computedTea.toFixed(3),
      non_tea_area: remainder(computedTea),
      division_count: d.active,
      section_count: sc.active,
      field_count: f.active,
      worker_count: workers,
      family_count: families,
    };
    const src = (v: unknown) => (v === null ? ('computed' as const) : ('entered' as const));
    const fieldTypes = Object.fromEntries(FIELD_TYPES.map((t) => [t, 0])) as Record<FieldType, number>;
    for (const r of byType) fieldTypes[r.fieldType as FieldType] = r._count._all;
    const sectionsWithArea = sectionArea._count._all;
    return {
      estate_id: id.toString(),
      total_land_area: area(e.totalArea),
      tea_area: tea.toFixed(3),
      non_tea_area: e.nonTeaArea === null ? remainder(tea) : acres(e.nonTeaArea),
      field_area: acres(sums._sum.grossArea),
      division_count: e.divisionCount ?? d.active,
      section_count: e.sectionCount ?? sc.active,
      field_count: e.fieldCount ?? f.active,
      factory_count: factoryCount,
      worker_count: e.workerCount ?? workers,
      family_count: e.familyCount ?? families,
      workforce_available: true,
      photo_count: photoCount,
      source: {
        tea_area: src(e.teaArea),
        non_tea_area: src(e.nonTeaArea),
        division_count: src(e.divisionCount),
        section_count: src(e.sectionCount),
        field_count: src(e.fieldCount),
        worker_count: src(e.workerCount),
        family_count: src(e.familyCount),
      },
      computed,
      hierarchy: {
        divisions: d,
        sections: sc,
        fields: f,
        field_types: fieldTypes,
        division_area: acres(divisionArea._sum.area),
        section_area: acres(sectionArea._sum.area),
        average_section_area:
          sectionsWithArea === 0
            ? null
            : dec(sectionArea._sum.area?.toString() ?? '0')
                .div(sectionsWithArea)
                .toFixed(2),
        field_area: acres(sums._sum.grossArea),
        planted_area: acres(sums._sum.plantedArea),
      },
    };
  }

  const divisions = {
    async listFor(estateId: bigint, q: ListQuery) {
      await estateOrNotFound(db, estateId);
      const where: Prisma.DivisionWhereInput = { AND: [{ estateId }, toWhere(q, NODE_LIST_FIELDS)] };
      const [rows, total] = await Promise.all([
        db.division.findMany({
          where,
          include: divisionInclude,
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
        await assertProfileRef(tx, 'manager_profile_id', body.manager_profile_id, estateId);
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
        await assertProfileRef(tx, 'manager_profile_id', changes.manager_profile_id, before.estateId);
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
    /** GET /sections (R.3): every section of an estate in one request; estate_id is reached through the division. */
    async list(q: ListQuery) {
      const estateFilter = q.filters.find((f) => f.field === 'estate_id');
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== 'estate_id') };
      const where = toWhere(rest, SECTION_LIST_FIELDS) as Prisma.SectionWhereInput;
      if (estateFilter) {
        const ids = (Array.isArray(estateFilter.value) ? estateFilter.value : [estateFilter.value]).map((v) =>
          BigInt(String(v)),
        );
        where.division = { estateId: { in: ids } };
      }
      const [rows, total] = await Promise.all([
        db.section.findMany({
          where,
          include: sectionInclude,
          orderBy: [...toOrderBy(q.sort, SECTION_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.section.count({ where }),
      ]);
      return { items: rows.map(toSectionOut), total };
    },

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
        await checkParentSection(tx, body.parent_section_id, divisionId);
        await assertProfileRef(tx, 'supervisor_profile_id', body.supervisor_profile_id, division.estateId);
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
        await checkParentSection(tx, changes.parent_section_id, before.divisionId, id);
        await assertProfileRef(
          tx,
          'supervisor_profile_id',
          changes.supervisor_profile_id,
          before.division.estateId,
        );
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

  /** GET/PUT /sections/{id}/boundary (R.3 GIS): the section's outline, a Polygon. */
  const sectionBoundaryOut = (sec: SectionRow) => ({
    section_id: sec.id.toString(),
    boundary: (sec.boundary as unknown as Geometry | null) ?? null,
    mapped_area_acres: area(sec.mappedAreaAcres),
    version: sec.version,
  });
  const sectionBoundaries = {
    async get(id: bigint) {
      return sectionBoundaryOut(await sectionOrNotFound(db, id));
    },
    async set(id: bigint, expectedVersion: number, body: z.infer<typeof BoundaryBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await sectionOrNotFound(tx, id);
        if (!(await canWriteSection(before))) await denyWrite(accessLog, 'section', id, 'boundary');
        if (before.version !== expectedVersion) versionConflict(before, toSectionOut(before));
        let g: Geometry | null;
        try {
          g =
            body.kml !== undefined
              ? geometryFromKml(body.kml, false)
              : body.points !== undefined
                ? geometryFromPoints(body.points, false)
                : body.boundary === null
                  ? null
                  : parseGeometry(body.boundary, false);
        } catch (err) {
          if (err instanceof GeometryError) {
            const field = body.kml !== undefined ? 'kml' : body.points !== undefined ? 'points' : 'boundary';
            throw Errors.validation([{ field, code: 'VALIDATION_FAILED', message: err.message }]);
          }
          throw err;
        }
        const fig = g === null ? null : figuresOf(g);
        await tx.section.update({
          where: { id },
          data: {
            boundary: g === null ? P.DbNull : (g as unknown as Prisma.InputJsonValue),
            mappedAreaAcres:
              fig?.areaAcres === undefined || fig.areaAcres === null ? null : fig.areaAcres.toFixed(3),
            ...stamp(actorId),
          },
        });
        const after = await sectionOrNotFound(tx, id);
        await auditUpdate(tx, SECTION_AUDIT, id, toSectionOut(before), toSectionOut(after), { actorId });
        return sectionBoundaryOut(after);
      });
    },
  };

  /**
   * GET /estates/{id}/map (R.3 GIS): every shape of the estate the caller can see, as one GeoJSON
   * FeatureCollection, layered as the design's legend (field, road, drain, section boundary).
   */
  async function estateMap(id: bigint): Promise<z.infer<typeof EstateMapOut>> {
    const e = await estateOrNotFound(db, id);
    const [fields, sections] = await Promise.all([
      db.field.findMany({
        where: { estateId: id },
        include: {
          section: { select: { id: true, name: true, division: { select: { id: true, name: true } } } },
        },
        orderBy: { fieldNumber: 'asc' },
      }),
      db.section.findMany({
        where: { division: { estateId: id }, boundary: { not: P.DbNull } },
        include: { division: { select: { id: true, name: true } } },
        orderBy: { code: 'asc' },
      }),
    ]);
    const features: z.infer<typeof EstateMapOut>['features'] = [];
    let box: [number, number, number, number] | null = null;
    const grow = (g: Geometry) => {
      const pts = g.type === 'Polygon' ? g.coordinates.flat() : g.coordinates;
      for (const [lng, lat] of pts) {
        box =
          box === null
            ? [lng, lat, lng, lat]
            : [Math.min(box[0], lng), Math.min(box[1], lat), Math.max(box[2], lng), Math.max(box[3], lat)];
      }
    };
    for (const f of fields) {
      if (f.boundary === null) continue;
      const g = f.boundary as unknown as Geometry;
      grow(g);
      const layer =
        f.fieldType === 'drain'
          ? 'drain'
          : f.fieldType === 'road_reserve' || f.fieldType === 'road_side'
            ? 'road'
            : 'field';
      features.push({
        type: 'Feature',
        id: `field-${f.id.toString()}`,
        geometry: g as unknown as z.infer<typeof EstateMapOut>['features'][number]['geometry'],
        properties: {
          layer,
          id: f.id.toString(),
          code: f.fieldNumber,
          name: f.name,
          field_type: f.fieldType,
          field_status: f.fieldStatus,
          status: f.status,
          gross_area: area(f.grossArea),
          planted_area: area(f.plantedArea),
          mapped_area_acres: area(f.mappedAreaAcres),
          section_id: f.section.id.toString(),
          section_name: f.section.name,
          division_id: f.section.division.id.toString(),
          division_name: f.section.division.name,
        },
      });
    }
    for (const sec of sections) {
      const g = sec.boundary as unknown as Geometry;
      grow(g);
      features.push({
        type: 'Feature',
        id: `section-${sec.id.toString()}`,
        geometry: g as unknown as z.infer<typeof EstateMapOut>['features'][number]['geometry'],
        properties: {
          layer: 'section',
          id: sec.id.toString(),
          code: sec.code,
          name: sec.name,
          field_type: null,
          field_status: null,
          status: sec.status,
          gross_area: area(sec.area),
          planted_area: null,
          mapped_area_acres: area(sec.mappedAreaAcres),
          section_id: sec.id.toString(),
          section_name: sec.name,
          division_id: sec.division.id.toString(),
          division_name: sec.division.name,
        },
      });
    }
    return {
      estate: {
        id: e.id.toString(),
        code: e.code,
        name: e.name,
        latitude: e.latitude === null ? null : e.latitude.toFixed(6),
        longitude: e.longitude === null ? null : e.longitude.toFixed(6),
      },
      bbox: box,
      type: 'FeatureCollection',
      features,
      unmapped_field_ids: fields.filter((f) => f.boundary === null).map((f) => f.id.toString()),
    };
  }

  return { estates, divisions, sections, sectionOrNotFound, estateSummary, sectionBoundaries, estateMap };
}

export type HierarchyService = ReturnType<typeof hierarchyService>;
