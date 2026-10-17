import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import { auditCreate, auditDelete, auditUpdate, recordStatusChange } from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec } from '../../core/money/decimal.js';
import { businessDateFromDb, businessDateToDb, todayIn } from '../../core/time/dates.js';
import type { Field, Prisma } from '../../generated/prisma/client.js';
import { archiveDocumentsOf } from '../documents/documents.service.js';
import {
  area,
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
import { FIELD_AUDIT } from './organisation.audit.js';
import type {
  CreateFieldBody,
  FieldOut,
  PatchFieldBody,
  ReassignSectionBody,
  Status,
} from './organisation.schema.js';

/**
 * Fields (Spec P3 §4.5, P1 §5.1, P4 §7.1).
 *
 *   - The SECTION decides the estate: estate_id is never sent, it is copied from the section's division
 *     and kept equal to it (P3 §4.5: denormalised for query volume, maintained by the application).
 *   - planted_area ≤ gross_area (P3 CHECK), checked here first so the caller gets a field-level error.
 *   - The section changes only through reassign-section, which is effective-dated and stays inside the
 *     estate. Transactions already captured keep the section they were recorded with, so historical
 *     production stays with the old section; the audit chain of section_id is the field's history
 *     (BACKLOG D-1.07-5).
 */

type FieldOutT = z.infer<typeof FieldOut>;
interface Ref {
  id: bigint;
  code: string;
  name: string;
}
type FieldRow = Field & {
  section: { divisionId: bigint };
  parent: { id: bigint; fieldNumber: string; name: string | null } | null;
  teaVariety: Ref | null;
  irrigationSource: Ref | null;
  soilType: Ref | null;
  drainageClass: Ref | null;
  creator: { id: bigint; username: string };
};
const ref = { select: { id: true, code: true, name: true } } as const;
const include = {
  section: { select: { divisionId: true } },
  parent: { select: { id: true, fieldNumber: true, name: true } },
  teaVariety: ref,
  irrigationSource: ref,
  soilType: ref,
  drainageClass: ref,
  creator: { select: { id: true, username: true } },
} as const satisfies Prisma.FieldInclude;

/** The R.3 reference lists a field names, by body key. */
const FIELD_LOOKUPS = [
  ['tea_variety_id', 'teaVariety', 'tea variety'],
  ['irrigation_source_id', 'irrigationSource', 'irrigation source'],
  ['soil_type_id', 'soilType', 'soil type'],
  ['drainage_class_id', 'drainageClass', 'drainage class'],
] as const;

export const FIELD_LIST_FIELDS: ListFieldMap = {
  estate_id: { field: 'estateId', convert: (v) => BigInt(String(v)) },
  section_id: { field: 'sectionId', convert: (v) => BigInt(String(v)) },
  field_status: { field: 'fieldStatus' },
  field_type: { field: 'fieldType' },
  parent_field_id: { field: 'parentFieldId', convert: (v) => BigInt(String(v)) },
  status: { field: 'status' },
  field_number: { field: 'fieldNumber' },
  gross_area: { field: 'grossArea' },
  name: { field: 'name' },
};

const refOut = (r: Ref | null) => (r ? { id: r.id.toString(), code: r.code, name: r.name } : null);

export function toFieldOut(f: FieldRow): FieldOutT {
  return {
    id: f.id.toString(),
    estate_id: f.estateId.toString(),
    division_id: f.section.divisionId.toString(),
    section_id: f.sectionId.toString(),
    field_number: f.fieldNumber,
    name: f.name,
    gross_area: area(f.grossArea) ?? '0.000',
    planted_area: area(f.plantedArea),
    field_status: f.fieldStatus as FieldOutT['field_status'],
    section_effective_from: day(f.sectionEffectiveFrom),
    status: f.status as Status,
    remarks: f.remarks,
    field_type: f.fieldType as FieldOutT['field_type'],
    parent_field_id: idOut(f.parentFieldId),
    parent_field: f.parent
      ? { id: f.parent.id.toString(), field_number: f.parent.fieldNumber, name: f.parent.name }
      : null,
    planting_year: f.plantingYear,
    tea_variety_id: idOut(f.teaVarietyId),
    tea_variety: refOut(f.teaVariety),
    spacing: f.spacing,
    altitude: f.altitude === null ? null : f.altitude.toFixed(2),
    average_slope: f.averageSlope === null ? null : f.averageSlope.toFixed(2),
    irrigation_source_id: idOut(f.irrigationSourceId),
    irrigation_source: refOut(f.irrigationSource),
    soil_type_id: idOut(f.soilTypeId),
    soil_type: refOut(f.soilType),
    drainage_class_id: idOut(f.drainageClassId),
    drainage_class: refOut(f.drainageClass),
    created_by: { id: f.creator.id.toString(), username: f.creator.username },
    version: f.version,
    created_at: f.createdAt.toISOString(),
    updated_at: iso(f.updatedAt),
  };
}

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});

function assertAreas(gross: Prisma.Decimal, planted: Prisma.Decimal | null): void {
  if (planted !== null && dec(planted).gt(dec(gross))) {
    throw Errors.validation([invalid('planted_area', 'cannot exceed gross_area')]);
  }
}

type Details = Partial<
  Readonly<Record<(typeof FIELD_LOOKUPS)[number][0] | 'parent_field_id', bigint | null | undefined>>
> & { readonly planting_year?: number | null | undefined };

/**
 * The R.3 details a CHECK cannot judge, as field errors: planting year not in the future; the parent
 * field in the same estate, not the field itself and not one of its own blocks (no cycles); each
 * reference list entry exists and is active (an inactive one the field already has may stay).
 */
async function checkDetails(
  tx: Tx,
  b: Details,
  estateId: bigint,
  timezone: string,
  current?: FieldRow,
): Promise<void> {
  const problems: ErrorDetail[] = [];
  if (
    b.planting_year !== undefined &&
    b.planting_year !== null &&
    b.planting_year > Number(todayIn(timezone).slice(0, 4))
  ) {
    problems.push(invalid('planting_year', 'cannot be in the future'));
  }
  const parentId = b.parent_field_id;
  if (parentId !== undefined && parentId !== null) {
    const parent = await tx.field.findUnique({ where: { id: parentId }, select: { estateId: true } });
    if (!parent) problems.push(invalid('parent_field_id', 'No such field.'));
    else if (parent.estateId !== estateId)
      problems.push(invalid('parent_field_id', 'The parent field must be in the same estate.'));
    else if (current && (await isWithin(tx, parentId, current.id)))
      problems.push(invalid('parent_field_id', 'A field cannot sit inside itself or one of its own blocks.'));
  }
  for (const [key, relation, label] of FIELD_LOOKUPS) {
    const id = b[key];
    if (id === undefined || id === null) continue;
    if (current?.[`${relation}Id` as const] === id) continue;
    const row = await lookupRow(tx, relation, id);
    if (row?.status !== 'active') problems.push(invalid(key, `No such active ${label}.`));
  }
  if (problems.length > 0) throw Errors.validation(problems);
}

function lookupRow(tx: Tx, relation: (typeof FIELD_LOOKUPS)[number][1], id: bigint) {
  const where = { where: { id }, select: { status: true } };
  switch (relation) {
    case 'teaVariety':
      return tx.teaVariety.findUnique(where);
    case 'irrigationSource':
      return tx.irrigationSource.findUnique(where);
    case 'soilType':
      return tx.soilType.findUnique(where);
    case 'drainageClass':
      return tx.drainageClass.findUnique(where);
  }
}

/** Whether `candidate` is `self` or lies under it (walking up candidate's parents). */
async function isWithin(tx: Tx, candidate: bigint, self: bigint): Promise<boolean> {
  const seen = new Set<bigint>();
  for (let at: bigint | null = candidate; at !== null;) {
    if (at === self) return true;
    if (seen.has(at)) return true; // a cycle already in the data: refuse rather than loop
    seen.add(at);
    const row: { parentFieldId: bigint | null } | null = await tx.field.findUnique({
      where: { id: at },
      select: { parentFieldId: true },
    });
    at = row?.parentFieldId ?? null;
  }
  return false;
}

export function fieldsService(db: Database, accessLog: AccessLog, timezone: string) {
  async function fieldOrNotFound(tx: Database | Tx, id: bigint): Promise<FieldRow> {
    const f = await tx.field.findUnique({ where: { id }, include });
    if (!f) throw Errors.notFound('Field not found.');
    return f;
  }

  /** A section named in a request body: unknown or out of scope reads as "no such section" (422). */
  async function sectionForBody(tx: Tx, id: bigint) {
    const s = await tx.section.findUnique({
      where: { id },
      select: { id: true, divisionId: true, status: true, division: { select: { estateId: true } } },
    });
    if (!s) throw Errors.validation([invalid('section_id', 'No such section.')]);
    return s;
  }

  const canWrite = (f: FieldRow) =>
    writable({ estate: f.estateId, division: f.section.divisionId, section: f.sectionId });
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  const data = (b: z.infer<typeof PatchFieldBody>): Prisma.FieldUncheckedUpdateManyInput => ({
    ...(b.field_number !== undefined ? { fieldNumber: b.field_number } : {}),
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.gross_area !== undefined ? { grossArea: b.gross_area } : {}),
    ...(b.planted_area !== undefined ? { plantedArea: b.planted_area } : {}),
    ...(b.field_status !== undefined ? { fieldStatus: b.field_status } : {}),
    ...(b.remarks !== undefined ? { remarks: b.remarks } : {}),
    ...(b.field_type !== undefined ? { fieldType: b.field_type } : {}),
    ...(b.parent_field_id !== undefined ? { parentFieldId: idIn(b.parent_field_id) } : {}),
    ...(b.planting_year !== undefined ? { plantingYear: b.planting_year } : {}),
    ...(b.tea_variety_id !== undefined ? { teaVarietyId: idIn(b.tea_variety_id) } : {}),
    ...(b.spacing !== undefined ? { spacing: b.spacing } : {}),
    ...(b.altitude !== undefined ? { altitude: b.altitude } : {}),
    ...(b.average_slope !== undefined ? { averageSlope: b.average_slope } : {}),
    ...(b.irrigation_source_id !== undefined ? { irrigationSourceId: idIn(b.irrigation_source_id) } : {}),
    ...(b.soil_type_id !== undefined ? { soilTypeId: idIn(b.soil_type_id) } : {}),
    ...(b.drainage_class_id !== undefined ? { drainageClassId: idIn(b.drainage_class_id) } : {}),
  });

  return {
    async list(q: ListQuery) {
      const divisionFilter = q.filters.find((f) => f.field === 'division_id');
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== 'division_id') };
      const where = toWhere(rest, FIELD_LIST_FIELDS) as Prisma.FieldWhereInput;
      if (divisionFilter) {
        const ids = (Array.isArray(divisionFilter.value) ? divisionFilter.value : [divisionFilter.value]).map(
          (v) => BigInt(String(v)),
        );
        where.section = { divisionId: { in: ids } };
      }
      const [rows, total] = await Promise.all([
        db.field.findMany({
          where,
          include,
          orderBy: [...toOrderBy(q.sort, FIELD_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.field.count({ where }),
      ]);
      return { items: rows.map(toFieldOut), total };
    },

    async get(id: bigint) {
      return toFieldOut(await fieldOrNotFound(db, id));
    },

    async create(body: z.infer<typeof CreateFieldBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const section = await sectionForBody(tx, body.section_id);
        const estateId = section.division.estateId;
        // Visible is not enough: a field is added under an estate, division or section grant that reaches it.
        if (!(await writable({ estate: estateId, division: section.divisionId, section: section.id }))) {
          await denyWrite(accessLog, 'field', null, 'create');
        }
        if (section.status !== 'active') throw inactiveParent('section_id', 'section');
        assertAreas(body.gross_area, body.planted_area ?? null);
        await checkDetails(tx, body, estateId, timezone);
        const { id } = await tx.field
          .create({
            data: {
              ...(data(body) as Prisma.FieldUncheckedCreateInput),
              sectionId: section.id,
              estateId,
              fieldNumber: body.field_number,
              name: body.name ?? null,
              grossArea: body.gross_area,
              plantedArea: body.planted_area ?? null,
              fieldStatus: body.field_status,
              sectionEffectiveFrom: body.section_effective_from
                ? businessDateToDb(body.section_effective_from)
                : null,
              remarks: body.remarks ?? null,
              status: 'active',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('field_number', `Field number ${body.field_number} in this estate`));
        const out = toFieldOut(await fieldOrNotFound(tx, id));
        await auditCreate(tx, FIELD_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, FIELD_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchFieldBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await fieldOrNotFound(tx, id);
        if (!(await canWrite(before))) await denyWrite(accessLog, 'field', id, 'update');
        assertAreas(
          changes.gross_area ?? before.grossArea,
          changes.planted_area === undefined ? before.plantedArea : changes.planted_area,
        );
        await checkDetails(tx, changes, before.estateId, timezone, before);
        const { count } = await tx.field
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...data(changes), ...stamp(actorId) },
          })
          .catch(duplicate('field_number', `Field number ${changes.field_number ?? ''} in this estate`));
        if (count !== 1) versionConflict(before, toFieldOut(before));
        const after = toFieldOut(await fieldOrNotFound(tx, id));
        await auditUpdate(tx, FIELD_AUDIT, id, toFieldOut(before), after, { actorId });
        return after;
      });
    },

    /**
     * POST /fields/{id}/reassign-section (P4 §7.1, P1 §5.1). Effective-dated: the date may be in the
     * past (production captured since then keeps the old section) but not the future, and not before
     * the field joined its current section. The new section must be in the same estate.
     */
    async reassignSection(
      id: bigint,
      expectedVersion: number,
      body: z.infer<typeof ReassignSectionBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await fieldOrNotFound(tx, id);
        if (!(await canWrite(before))) await denyWrite(accessLog, 'field', id, 'reassign-section');
        if (before.version !== expectedVersion) versionConflict(before, toFieldOut(before));
        const target = await sectionForBody(tx, body.section_id);
        const problems: ErrorDetail[] = [];
        if (target.id === before.sectionId)
          problems.push(invalid('section_id', 'The field is already in this section.'));
        if (target.division.estateId !== before.estateId) {
          problems.push(invalid('section_id', 'A field can only move to a section of the same estate.'));
        }
        if (target.status !== 'active') problems.push(invalid('section_id', 'The section is inactive.'));
        const effective = body.effective_from;
        if (effective > todayIn(timezone))
          problems.push(invalid('effective_from', 'cannot be in the future'));
        const since = before.sectionEffectiveFrom ? businessDateFromDb(before.sectionEffectiveFrom) : null;
        if (since !== null && effective <= since) {
          problems.push(
            invalid('effective_from', `must be after ${since}, when the field joined its current section`),
          );
        }
        if (problems.length > 0) throw Errors.validation(problems);
        if (
          !(await writable({
            estate: target.division.estateId,
            division: target.divisionId,
            section: target.id,
          }))
        ) {
          await denyWrite(accessLog, 'field', id, 'reassign-section');
        }
        await tx.field.update({
          where: { id },
          data: {
            sectionId: target.id,
            sectionEffectiveFrom: businessDateToDb(effective),
            ...stamp(actorId),
          },
        });
        const after = toFieldOut(await fieldOrNotFound(tx, id));
        await auditUpdate(tx, FIELD_AUDIT, id, toFieldOut(before), after, {
          actorId,
          reason: body.reason ?? null,
        });
        return after;
      });
    },

    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await fieldOrNotFound(tx, id);
        if (!(await canWrite(before))) await denyWrite(accessLog, 'field', id, status);
        if (before.version !== expectedVersion) versionConflict(before, toFieldOut(before));
        if (before.status === status) return toFieldOut(before);
        if (status === 'active') {
          const section = await tx.section.findUnique({
            where: { id: before.sectionId },
            select: { status: true },
          });
          if (section?.status !== 'active') throw inactiveParent('section_id', 'section');
        }
        await tx.field.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toFieldOut(await fieldOrNotFound(tx, id));
        await auditUpdate(tx, FIELD_AUDIT, id, toFieldOut(before), after, { actorId });
        await recordStatusChange(tx, FIELD_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    /** Only a field nothing refers to yet (plantation, plucking and activity records will). */
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const f = await fieldOrNotFound(tx, id);
        if (!(await canWrite(f))) await denyWrite(accessLog, 'field', id, 'delete');
        await archiveDocumentsOf(tx, 'field', id, actorId);
        await tx.field.delete({ where: { id } }).catch(referenced('field'));
        await auditDelete(tx, FIELD_AUDIT, id, toFieldOut(f), { actorId });
      });
    },
  };
}

export type FieldsService = ReturnType<typeof fieldsService>;
