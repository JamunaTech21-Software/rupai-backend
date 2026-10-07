import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import { auditCreate, auditDelete, auditUpdate, recordStatusChange } from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { businessDateToDb, type BusinessDate } from '../../core/time/dates.js';
import type { Division, Estate, Prisma, Section } from '../../generated/prisma/client.js';
import {
  area,
  assertNoScopeGrants,
  day,
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

export function toEstateOut(e: Estate): EstateOutT {
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
    established_on: day(e.establishedOn),
    ownership_type: e.ownershipType as EstateOutT['ownership_type'],
    status: e.status as Status,
    remarks: e.remarks,
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
const date = (v: string | null): Date | null => (v === null ? null : businessDateToDb(v as BusinessDate));

/** The singleton organisation's id (P3 §4.1). The API refuses to start without it, so this is a guard. */
async function organisationId(tx: Tx): Promise<bigint> {
  const org = await tx.organisation.findFirst({ select: { id: true } });
  if (!org) throw new Error('the organisation row is missing: run the seed (npm run db:seed)');
  return org.id;
}

export function hierarchyService(db: Database, accessLog: AccessLog) {
  // ---- loaders (scoped reads: out of scope is 404) ---------------------------------------------
  async function estateOrNotFound(tx: Database | Tx, id: bigint): Promise<Estate> {
    const e = await tx.estate.findUnique({ where: { id } });
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
    ...(b.established_on !== undefined ? { establishedOn: date(b.established_on) } : {}),
    ...(b.ownership_type !== undefined ? { ownershipType: b.ownership_type } : {}),
    ...(b.remarks !== undefined ? { remarks: b.remarks } : {}),
  });
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
        const { count } = await tx.estate
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...estateData(changes), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Estate code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, toEstateOut(before));
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
        await tx.estate.delete({ where: { id } }).catch(referenced('estate'));
        await auditDelete(tx, ESTATE_AUDIT, id, toEstateOut(e), { actorId });
      });
    },
  };

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

  return { estates, divisions, sections, sectionOrNotFound };
}

export type HierarchyService = ReturnType<typeof hierarchyService>;
