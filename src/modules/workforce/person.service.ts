import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
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
import { Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { businessDateFromDb, businessDateToDb, todayIn, type BusinessDate } from '../../core/time/dates.js';
import type { Person, PersonDependent, Prisma } from '../../generated/prisma/client.js';
import { archiveDocumentsOf } from '../documents/documents.service.js';
import {
  denyWrite,
  duplicate,
  idIn,
  idOut,
  iso,
  referenced,
  versionConflict,
} from '../organisation/common.js';
import { personWritable } from './person.access.js';
import type {
  CreateDependentBody,
  CreatePersonBody,
  DependentOut,
  PatchDependentBody,
  PatchPersonBody,
  PersonOut,
} from './person.schema.js';

/**
 * The person registry (P2.01; Spec P3 §8.1, P1 §5.5; the manager's design, BACKLOG D-2-1).
 *
 *   - A person exists once: identity, contact, payment details. No employment attribute (P2.02's).
 *   - person_code is allocated from the `person` number format; national_id is unique where present.
 *   - Scope: the registering estate decides who sees and changes the person until a profile places them
 *     (person.scope.ts). An estate-scoped user registers people in their own estates only.
 *   - Personal data: every change is audited at master depth; reads follow person.view.
 */

type PersonOutT = z.infer<typeof PersonOut>;
type DependentOutT = z.infer<typeof DependentOut>;
interface Ref {
  id: bigint;
  code: string;
  name: string;
}
type PersonRow = Person & {
  nationality: { id: bigint; name: string } | null;
  religion: Ref | null;
  educationLevel: Ref | null;
  skillLinks: { skill: Ref }[];
  languageLinks: { language: Ref }[];
  creator: { id: bigint; username: string };
  _count: { dependents: number };
};

const ref = { select: { id: true, code: true, name: true } } as const;
const include = {
  nationality: { select: { id: true, name: true } },
  religion: ref,
  educationLevel: ref,
  skillLinks: { include: { skill: ref }, orderBy: { skillId: 'asc' } },
  languageLinks: { include: { language: ref }, orderBy: { languageId: 'asc' } },
  creator: { select: { id: true, username: true } },
  _count: { select: { dependents: true } },
} as const satisfies Prisma.PersonInclude;

export const PERSON_AUDIT: AuditedRecord = {
  type: 'person',
  class: 'master',
  fields: [
    'person_code',
    'registered_estate_id',
    'title',
    'first_name',
    'middle_name',
    'last_name',
    'father_name',
    'mother_name',
    'spouse_name',
    'date_of_birth',
    'gender',
    'marital_status',
    'blood_group',
    'nationality_country_id',
    'religion_id',
    'national_id',
    'birth_certificate_no',
    'passport_no',
    'driving_license_no',
    'tin',
    'phone',
    'alternate_phone',
    'personal_email',
    'present_address',
    'present_district',
    'present_upazila',
    'present_postal_code',
    'permanent_address',
    'permanent_district',
    'permanent_upazila',
    'permanent_postal_code',
    'education_level_id',
    'skills',
    'languages',
    'experience_years',
    'emergency_contact_name',
    'emergency_contact_phone',
    'emergency_contact_alt_phone',
    'emergency_contact_relation',
    'emergency_contact_address',
    'payment_method',
    'bank_name',
    'bank_branch',
    'bank_account_number',
    'mobile_banking_provider',
    'mobile_banking_number',
    'remarks',
    'status',
  ],
};
export const DEPENDENT_AUDIT: AuditedRecord = {
  type: 'person_dependent',
  class: 'master',
  fields: ['person_id', 'name', 'relation', 'occupation', 'date_of_birth', 'gender'],
};

export const PERSON_LIST_FIELDS: ListFieldMap = {
  status: { field: 'status' },
  gender: { field: 'gender' },
  person_code: { field: 'personCode' },
  full_name: { field: 'fullName' },
  national_id: { field: 'nationalId' },
  phone: { field: 'phone' },
  registered_estate_id: { field: 'registeredEstateId', convert: (v) => BigInt(String(v)) },
  created_at: { field: 'createdAt' },
};

const refOut = (r: Ref | null) => (r ? { id: r.id.toString(), code: r.code, name: r.name } : null);

/** Whole years between a date of birth and today. */
export function ageOn(dob: BusinessDate | null, today: BusinessDate): number | null {
  if (dob === null) return null;
  const [y, m, d] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

export const fullNameOf = (first: string, middle: string | null, last: string | null) =>
  [first, middle, last]
    .filter((p): p is string => Boolean(p?.trim()))
    .join(' ')
    .slice(0, 200);

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});

export function personService(db: Database, accessLog: AccessLog, timezone: string) {
  const today = () => todayIn(timezone);

  function toOut(p: PersonRow): PersonOutT {
    const dob = p.dateOfBirth ? businessDateFromDb(p.dateOfBirth) : null;
    return {
      id: p.id.toString(),
      person_code: p.personCode,
      registered_estate_id: idOut(p.registeredEstateId),
      title: p.title as PersonOutT['title'],
      first_name: p.firstName,
      middle_name: p.middleName,
      last_name: p.lastName,
      full_name: p.fullName,
      father_name: p.fatherName,
      mother_name: p.motherName,
      spouse_name: p.spouseName,
      date_of_birth: dob,
      age: ageOn(dob, today()),
      gender: p.gender as PersonOutT['gender'],
      marital_status: p.maritalStatus as PersonOutT['marital_status'],
      blood_group: p.bloodGroup as PersonOutT['blood_group'],
      nationality_country_id: idOut(p.nationalityCountryId),
      nationality: p.nationality ? { id: p.nationality.id.toString(), name: p.nationality.name } : null,
      religion_id: idOut(p.religionId),
      religion: refOut(p.religion),
      national_id: p.nationalId,
      birth_certificate_no: p.birthCertificateNo,
      passport_no: p.passportNo,
      driving_license_no: p.drivingLicenseNo,
      tin: p.tin,
      phone: p.phone,
      alternate_phone: p.alternatePhone,
      personal_email: p.personalEmail,
      present_address: p.presentAddress,
      present_district: p.presentDistrict,
      present_upazila: p.presentUpazila,
      present_postal_code: p.presentPostalCode,
      permanent_address: p.permanentAddress,
      permanent_district: p.permanentDistrict,
      permanent_upazila: p.permanentUpazila,
      permanent_postal_code: p.permanentPostalCode,
      education_level_id: idOut(p.educationLevelId),
      education_level: refOut(p.educationLevel),
      skills: p.skillLinks.map((l) => ({
        id: l.skill.id.toString(),
        code: l.skill.code,
        name: l.skill.name,
      })),
      languages: p.languageLinks.map((l) => ({
        id: l.language.id.toString(),
        code: l.language.code,
        name: l.language.name,
      })),
      experience_years: p.experienceYears,
      emergency_contact_name: p.emergencyContactName,
      emergency_contact_phone: p.emergencyContactPhone,
      emergency_contact_alt_phone: p.emergencyContactAltPhone,
      emergency_contact_relation: p.emergencyContactRelation as PersonOutT['emergency_contact_relation'],
      emergency_contact_address: p.emergencyContactAddress,
      payment_method: p.paymentMethod as PersonOutT['payment_method'],
      bank_name: p.bankName,
      bank_branch: p.bankBranch,
      bank_account_number: p.bankAccountNumber,
      mobile_banking_provider: p.mobileBankingProvider as PersonOutT['mobile_banking_provider'],
      mobile_banking_number: p.mobileBankingNumber,
      remarks: p.remarks,
      dependent_count: p._count.dependents,
      status: p.status as PersonOutT['status'],
      created_by: { id: p.creator.id.toString(), username: p.creator.username },
      version: p.version,
      created_at: p.createdAt.toISOString(),
      updated_at: iso(p.updatedAt),
    };
  }

  function toDependentOut(d: PersonDependent): DependentOutT {
    const dob = d.dateOfBirth ? businessDateFromDb(d.dateOfBirth) : null;
    return {
      id: d.id.toString(),
      person_id: d.personId.toString(),
      name: d.name,
      relation: d.relation as DependentOutT['relation'],
      occupation: d.occupation,
      date_of_birth: dob,
      age: ageOn(dob, today()),
      gender: d.gender as DependentOutT['gender'],
      version: d.version,
      created_at: d.createdAt.toISOString(),
      updated_at: iso(d.updatedAt),
    };
  }

  async function orNotFound(tx: Database | Tx, id: bigint): Promise<PersonRow> {
    const p = await tx.person.findUnique({ where: { id }, include });
    if (!p) throw Errors.notFound('Person not found.');
    return p;
  }

  const data = (b: z.infer<typeof PatchPersonBody>): Prisma.PersonUncheckedUpdateManyInput => {
    const d: Prisma.PersonUncheckedUpdateManyInput = {};
    const set = (k: keyof Prisma.PersonUncheckedUpdateManyInput, v: unknown) => {
      if (v !== undefined) (d as Record<string, unknown>)[k] = v;
    };
    set(
      'registeredEstateId',
      b.registered_estate_id === undefined ? undefined : idIn(b.registered_estate_id),
    );
    set('title', b.title);
    set('firstName', b.first_name);
    set('middleName', b.middle_name);
    set('lastName', b.last_name);
    set('fatherName', b.father_name);
    set('motherName', b.mother_name);
    set('spouseName', b.spouse_name);
    set(
      'dateOfBirth',
      b.date_of_birth === undefined
        ? undefined
        : b.date_of_birth === null
          ? null
          : businessDateToDb(b.date_of_birth),
    );
    set('gender', b.gender);
    set('maritalStatus', b.marital_status);
    set('bloodGroup', b.blood_group);
    set(
      'nationalityCountryId',
      b.nationality_country_id === undefined ? undefined : idIn(b.nationality_country_id),
    );
    set('religionId', b.religion_id === undefined ? undefined : idIn(b.religion_id));
    set('nationalId', b.national_id);
    set('birthCertificateNo', b.birth_certificate_no);
    set('passportNo', b.passport_no);
    set('drivingLicenseNo', b.driving_license_no);
    set('tin', b.tin);
    set('phone', b.phone);
    set('alternatePhone', b.alternate_phone);
    set('personalEmail', b.personal_email);
    set('presentAddress', b.present_address);
    set('presentDistrict', b.present_district);
    set('presentUpazila', b.present_upazila);
    set('presentPostalCode', b.present_postal_code);
    set('permanentAddress', b.permanent_address);
    set('permanentDistrict', b.permanent_district);
    set('permanentUpazila', b.permanent_upazila);
    set('permanentPostalCode', b.permanent_postal_code);
    set('educationLevelId', b.education_level_id === undefined ? undefined : idIn(b.education_level_id));
    set('experienceYears', b.experience_years);
    set('emergencyContactName', b.emergency_contact_name);
    set('emergencyContactPhone', b.emergency_contact_phone);
    set('emergencyContactAltPhone', b.emergency_contact_alt_phone);
    set('emergencyContactRelation', b.emergency_contact_relation);
    set('emergencyContactAddress', b.emergency_contact_address);
    set('paymentMethod', b.payment_method);
    set('bankName', b.bank_name);
    set('bankBranch', b.bank_branch);
    set('bankAccountNumber', b.bank_account_number);
    set('mobileBankingProvider', b.mobile_banking_provider);
    set('mobileBankingNumber', b.mobile_banking_number);
    set('remarks', b.remarks);
    return d;
  };

  /** What a CHECK or a foreign key cannot say well: as field errors the form can show. */
  async function check(tx: Tx, b: z.infer<typeof PatchPersonBody>, current?: PersonRow) {
    const problems: ErrorDetail[] = [];
    if (b.date_of_birth !== undefined && b.date_of_birth !== null && b.date_of_birth > today()) {
      problems.push(invalid('date_of_birth', 'Cannot be in the future.'));
    }
    if (b.registered_estate_id !== undefined && b.registered_estate_id !== null) {
      // Read in scope: an estate the caller cannot see is "no such estate".
      if (!(await tx.estate.findUnique({ where: { id: b.registered_estate_id }, select: { id: true } }))) {
        problems.push(invalid('registered_estate_id', 'No such estate.'));
      }
    }
    if (
      b.nationality_country_id !== undefined &&
      b.nationality_country_id !== null &&
      (await tx.country.count({ where: { id: b.nationality_country_id } })) === 0
    ) {
      problems.push(invalid('nationality_country_id', 'No such country.'));
    }
    const active = async (
      field: string,
      id: bigint | null | undefined,
      kept: bigint | null | undefined,
      find: (id: bigint) => Promise<{ status: string } | null>,
      label: string,
    ) => {
      if (id === undefined || id === null || id === kept) return;
      if ((await find(id))?.status !== 'active') problems.push(invalid(field, `No such active ${label}.`));
    };
    await active(
      'religion_id',
      b.religion_id,
      current?.religionId,
      (id) => tx.religion.findUnique({ where: { id }, select: { status: true } }),
      'religion',
    );
    await active(
      'education_level_id',
      b.education_level_id,
      current?.educationLevelId,
      (id) => tx.educationLevel.findUnique({ where: { id }, select: { status: true } }),
      'education level',
    );
    const set = async (
      field: 'skill_ids' | 'language_ids',
      ids: readonly bigint[] | undefined,
      kept: readonly bigint[],
      find: (ids: bigint[]) => Promise<{ id: bigint; status: string }[]>,
      label: string,
    ) => {
      if (ids === undefined) return;
      const wanted = [...new Set(ids)];
      const found = new Map((await find(wanted)).map((r) => [r.id, r.status]));
      wanted.forEach((id, i) => {
        if (found.get(id) !== 'active' && !kept.includes(id)) {
          problems.push(invalid(`${field}.${String(i)}`, `No such active ${label}.`));
        }
      });
    };
    await set(
      'skill_ids',
      b.skill_ids,
      current?.skillLinks.map((l) => l.skill.id) ?? [],
      (ids) => tx.skill.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }),
      'skill',
    );
    await set(
      'language_ids',
      b.language_ids,
      current?.languageLinks.map((l) => l.language.id) ?? [],
      (ids) => tx.language.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } }),
      'language',
    );
    if (
      b.payment_method === 'mobile_banking' ||
      (b.payment_method === undefined && current?.paymentMethod === 'mobile_banking')
    ) {
      const number =
        b.mobile_banking_number !== undefined ? b.mobile_banking_number : current?.mobileBankingNumber;
      if (!number) problems.push(invalid('mobile_banking_number', 'Required when paid by mobile banking.'));
    }
    if (
      b.payment_method === 'bank' ||
      (b.payment_method === undefined && current?.paymentMethod === 'bank')
    ) {
      const account =
        b.bank_account_number !== undefined ? b.bank_account_number : current?.bankAccountNumber;
      if (!account) problems.push(invalid('bank_account_number', 'Required when paid by bank.'));
    }
    if (problems.length > 0) throw Errors.validation(problems);
  }

  /** Replaces a person's skill or language set. */
  async function setLinks(
    tx: Tx,
    personId: bigint,
    skills?: readonly bigint[],
    languages?: readonly bigint[],
  ) {
    if (skills !== undefined) {
      const wanted = [...new Set(skills)];
      await tx.personSkill.deleteMany({ where: { personId, skillId: { notIn: wanted } } });
      await tx.personSkill.createMany({
        data: wanted.map((skillId) => ({ personId, skillId })),
        skipDuplicates: true,
      });
    }
    if (languages !== undefined) {
      const wanted = [...new Set(languages)];
      await tx.personLanguage.deleteMany({ where: { personId, languageId: { notIn: wanted } } });
      await tx.personLanguage.createMany({
        data: wanted.map((languageId) => ({ personId, languageId })),
        skipDuplicates: true,
      });
    }
  }

  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });
  const nidTaken = duplicate('national_id', 'That national ID');
  async function assertWritable(
    p: { id: bigint | null; registeredEstateId: bigint | null },
    operation: string,
  ) {
    // Where the person is employed counts too (P2.02): the estate's HR keeps its people's records.
    const employedAt =
      p.id === null
        ? []
        : (
            await db.employmentProfile.findMany({ where: { personId: p.id }, select: { estateId: true } })
          ).map((r) => r.estateId);
    if (!(await personWritable(p.registeredEstateId, employedAt))) {
      await denyWrite(accessLog, 'person', p.id, operation);
    }
  }

  async function dependentOrNotFound(tx: Database | Tx, personId: bigint, id: bigint) {
    const d = await tx.personDependent.findFirst({ where: { id, personId } });
    if (!d) throw Errors.notFound('Dependent not found.');
    return d;
  }

  return {
    async list(q: ListQuery) {
      const search = q.filters.find((f) => f.field === 'q');
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== 'q') };
      const where = toWhere(rest, PERSON_LIST_FIELDS) as Prisma.PersonWhereInput;
      if (search) {
        const term = String(search.value);
        where.OR = [
          { fullName: { contains: term } },
          { personCode: { startsWith: term } },
          { nationalId: { startsWith: term } },
          { phone: { contains: term } },
        ];
      }
      const [rows, total] = await Promise.all([
        db.person.findMany({
          where,
          include,
          orderBy: [...toOrderBy(q.sort, PERSON_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.person.count({ where }),
      ]);
      return { items: rows.map(toOut), total };
    },

    async get(id: bigint) {
      return toOut(await orNotFound(db, id));
    },

    async create(body: z.infer<typeof CreatePersonBody>, actorId: bigint) {
      return withTransaction(db, (tx) => this.createIn(tx, body, actorId));
    },

    /** The same inside the caller's transaction (the workforce import, P2.06). */
    async createIn(tx: Tx, body: z.infer<typeof CreatePersonBody>, actorId: bigint) {
      await assertWritable({ id: null, registeredEstateId: body.registered_estate_id ?? null }, 'create');
      await check(tx, body);
      const { number } = await allocateNumber(tx, 'person', { date: today() }, 'draft');
      const { id } = await tx.person
        .create({
          data: {
            ...(data(body) as Prisma.PersonUncheckedCreateInput),
            personCode: number,
            firstName: body.first_name,
            fullName: fullNameOf(body.first_name, body.middle_name ?? null, body.last_name ?? null),
            status: 'active',
            createdBy: actorId,
          },
          select: { id: true },
        })
        .catch(nidTaken);
      await setLinks(tx, id, body.skill_ids, body.language_ids);
      const out = toOut(await orNotFound(tx, id));
      await auditCreate(tx, PERSON_AUDIT, id, out, { actorId });
      await recordStatusChange(tx, PERSON_AUDIT.type, id, null, out.status, { actorId });
      return out;
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchPersonBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        await assertWritable(before, 'update');
        // Moving a person to another registering estate needs that estate too.
        if (changes.registered_estate_id !== undefined) {
          await assertWritable({ id, registeredEstateId: changes.registered_estate_id }, 'update');
        }
        await check(tx, changes, before);
        const first = changes.first_name ?? before.firstName;
        const middle = changes.middle_name !== undefined ? changes.middle_name : before.middleName;
        const last = changes.last_name !== undefined ? changes.last_name : before.lastName;
        const { count } = await tx.person
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...data(changes), fullName: fullNameOf(first, middle, last), ...stamp(actorId) },
          })
          .catch(nidTaken);
        if (count !== 1) versionConflict(before, toOut(before));
        await setLinks(tx, id, changes.skill_ids, changes.language_ids);
        const after = toOut(await orNotFound(tx, id));
        await auditUpdate(tx, PERSON_AUDIT, id, toOut(before), after, { actorId });
        return after;
      });
    },

    async setStatus(id: bigint, expectedVersion: number, status: 'active' | 'inactive', actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        await assertWritable(before, status);
        if (before.version !== expectedVersion) versionConflict(before, toOut(before));
        if (before.status === status) return toOut(before);
        await tx.person.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toOut(await orNotFound(tx, id));
        await auditUpdate(tx, PERSON_AUDIT, id, toOut(before), after, { actorId });
        await recordStatusChange(tx, PERSON_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    /** Only a person created in error: one an employment profile refers to cannot be deleted. */
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const p = await orNotFound(tx, id);
        await assertWritable(p, 'delete');
        await archiveDocumentsOf(tx, 'person', id, actorId);
        await tx.personDependent.deleteMany({ where: { personId: id } });
        await tx.personSkill.deleteMany({ where: { personId: id } });
        await tx.personLanguage.deleteMany({ where: { personId: id } });
        await tx.person.delete({ where: { id } }).catch(referenced('person'));
        await auditDelete(tx, PERSON_AUDIT, id, toOut(p), { actorId });
      });
    },

    dependents: {
      async list(personId: bigint) {
        await orNotFound(db, personId);
        const rows = await db.personDependent.findMany({ where: { personId }, orderBy: { id: 'asc' } });
        return rows.map(toDependentOut);
      },

      async create(personId: bigint, body: z.infer<typeof CreateDependentBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const p = await orNotFound(tx, personId);
          await assertWritable(p, 'update');
          if (body.date_of_birth && body.date_of_birth > today()) {
            throw Errors.validation([invalid('date_of_birth', 'Cannot be in the future.')]);
          }
          const d = await tx.personDependent.create({
            data: {
              personId,
              name: body.name,
              relation: body.relation,
              occupation: body.occupation ?? null,
              dateOfBirth: body.date_of_birth ? businessDateToDb(body.date_of_birth) : null,
              gender: body.gender ?? null,
              createdBy: actorId,
            },
          });
          const out = toDependentOut(d);
          await auditCreate(tx, DEPENDENT_AUDIT, d.id, out, { actorId });
          return out;
        });
      },

      async update(
        personId: bigint,
        id: bigint,
        expectedVersion: number,
        b: z.infer<typeof PatchDependentBody>,
        actorId: bigint,
      ) {
        return withTransaction(db, async (tx) => {
          const p = await orNotFound(tx, personId);
          await assertWritable(p, 'update');
          const before = await dependentOrNotFound(tx, personId, id);
          if (b.date_of_birth && b.date_of_birth > today()) {
            throw Errors.validation([invalid('date_of_birth', 'Cannot be in the future.')]);
          }
          const { count } = await tx.personDependent.updateMany({
            where: { id, version: expectedVersion },
            data: {
              ...(b.name !== undefined ? { name: b.name } : {}),
              ...(b.relation !== undefined ? { relation: b.relation } : {}),
              ...(b.occupation !== undefined ? { occupation: b.occupation } : {}),
              ...(b.date_of_birth !== undefined
                ? { dateOfBirth: b.date_of_birth === null ? null : businessDateToDb(b.date_of_birth) }
                : {}),
              ...(b.gender !== undefined ? { gender: b.gender } : {}),
              ...stamp(actorId),
            },
          });
          if (count !== 1) versionConflict(before, toDependentOut(before));
          const after = toDependentOut(await dependentOrNotFound(tx, personId, id));
          await auditUpdate(tx, DEPENDENT_AUDIT, id, toDependentOut(before), after, { actorId });
          return after;
        });
      },

      async remove(personId: bigint, id: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const p = await orNotFound(tx, personId);
          await assertWritable(p, 'update');
          const d = await dependentOrNotFound(tx, personId, id);
          await tx.personDependent.delete({ where: { id } });
          await auditDelete(tx, DEPENDENT_AUDIT, id, toDependentOut(d), { actorId });
        });
      },
    },
  };
}

export type PersonService = ReturnType<typeof personService>;
