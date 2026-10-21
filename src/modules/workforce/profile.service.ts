import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { holdsPermission, type PermissionResolver } from '../../core/auth/authorize.js';
import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { runUnscoped } from '../../core/scope/scope.js';
import { businessDateFromDb, businessDateToDb, todayIn, type BusinessDate } from '../../core/time/dates.js';
import type { EmploymentProfile, Prisma } from '../../generated/prisma/client.js';
import {
  denyWrite,
  duplicate,
  idIn,
  idOut,
  iso,
  referenced,
  versionConflict,
  writable,
} from '../organisation/common.js';
import { currentAssignmentInclude, currentAssignmentOut, inForce } from './assignment.service.js';
import { ageOn } from './person.service.js';
import { endMembershipsOnSeparation } from './team.service.js';
import type {
  CreateProfileBody,
  LinkUserBody,
  PatchProfileBody,
  ProfileOut,
  SeparateBody,
  ServiceSummaryOut,
  WorkforceSummaryOut,
} from './profile.schema.js';

/**
 * Employment profiles (P2.02; Spec P3 §8.2, P1 §5.5, P4 §8.3; the manager's design, BACKLOG D-2-2).
 *
 *   - A profile is a person's employment at an estate for a period: worker or employee. The person,
 *     the estate and the type never change on a profile; a move between them is a new profile.
 *   - One ACTIVE profile per person and type (a generated unique key): a second is refused.
 *   - The Worker ID / Employee ID is numbered per estate unless given; unique within the estate.
 *   - Separation (employment.approve) ends the profile for good: dated, typed and explained. A separated
 *     profile is read-only. Suspension and reinstatement are employment.edit.
 *   - Scope: an estate grant reaches the estate's profiles; everyone reaches their own (self). Writes
 *     need the estate.
 */

type ProfileOutT = z.infer<typeof ProfileOut>;
interface Ref {
  id: bigint;
  code: string;
  name: string;
}
type ProfileRow = EmploymentProfile & {
  person: {
    id: bigint;
    personCode: string;
    fullName: string;
    fatherName: string | null;
    phone: string | null;
    gender: string | null;
    dateOfBirth: Date | null;
    nationalId: string | null;
  };
  estate: Ref;
  workerCategory: Ref | null;
  employeeCategory: Ref | null;
  jobGrade: Ref | null;
  supervisor: { id: bigint; profileNumber: string; person: { fullName: string } } | null;
  users: { id: bigint; username: string }[];
  creator: { id: bigint; username: string };
  assignments: Parameters<typeof currentAssignmentOut>[0];
};

const ref = { select: { id: true, code: true, name: true } } as const;
const baseInclude = {
  person: {
    select: {
      id: true,
      personCode: true,
      fullName: true,
      fatherName: true,
      phone: true,
      gender: true,
      dateOfBirth: true,
      nationalId: true,
    },
  },
  estate: ref,
  workerCategory: ref,
  employeeCategory: ref,
  jobGrade: ref,
  supervisor: { select: { id: true, profileNumber: true, person: { select: { fullName: true } } } },
  users: { select: { id: true, username: true }, orderBy: { id: 'asc' } },
  creator: { select: { id: true, username: true } },
} as const satisfies Prisma.EmploymentProfileInclude;
/** With the assignment in force on the date (the lists' Department, Designation, Section columns). */
export const profileInclude = (today: BusinessDate) =>
  ({ ...baseInclude, assignments: currentAssignmentInclude(today) }) as const;

export const PROFILE_AUDIT: AuditedRecord = {
  type: 'employment_profile',
  class: 'master',
  fields: [
    'person_id',
    'estate_id',
    'employment_type',
    'profile_number',
    'category_id',
    'engagement_type',
    'employment_basis',
    'job_nature',
    'working_location',
    'job_grade_id',
    'work_email',
    'joining_date',
    'confirmation_date',
    'probation_end_date',
    'separation_date',
    'separation_type',
    'separation_reason',
    'supervisor_profile_id',
    'is_service_continuous',
    'nominee_name',
    'nominee_relation',
    'nominee_date_of_birth',
    'nominee_national_id',
    'nominee_phone',
    'nominee_address',
    'remarks',
    'status',
    'user',
  ],
};

export const PROFILE_LIST_FIELDS: ListFieldMap = {
  estate_id: { field: 'estateId', convert: (v) => BigInt(String(v)) },
  person_id: { field: 'personId', convert: (v) => BigInt(String(v)) },
  employment_type: { field: 'employmentType' },
  engagement_type: { field: 'engagementType' },
  job_nature: { field: 'jobNature' },
  working_location: { field: 'workingLocation' },
  status: { field: 'status' },
  profile_number: { field: 'profileNumber' },
  joining_date: { field: 'joiningDate' },
  job_grade_id: { field: 'jobGradeId', convert: (v) => BigInt(String(v)) },
  supervisor_profile_id: { field: 'supervisorProfileId', convert: (v) => BigInt(String(v)) },
};

/** List filters answered by the current assignment. */
const ASSIGNED = {
  department_id: 'departmentId',
  designation_id: 'designationId',
  division_id: 'divisionId',
  section_id: 'sectionId',
  activity_type_id: 'activityTypeId',
} as const;

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const d = (v: Date | null) => (v ? businessDateFromDb(v) : null);
const toDb = (v: BusinessDate | null | undefined) =>
  v === undefined ? undefined : v === null ? null : businessDateToDb(v);
const daysBetween = (a: BusinessDate, b: BusinessDate) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface ProfileServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly authz: PermissionResolver;
  readonly timezone: string;
}

export function profileService({ db, accessLog, authz, timezone }: ProfileServiceDeps) {
  const today = () => todayIn(timezone);
  /** The latest photograph of each person, for the lists' Photo column. */
  async function photos(personIds: readonly bigint[]): Promise<Map<bigint, bigint>> {
    if (personIds.length === 0) return new Map();
    const rows = await db.documentFile.findMany({
      where: {
        ownerType: 'person',
        ownerId: { in: [...personIds] },
        status: 'active',
        isCurrent: true,
        documentType: { code: 'PHOTOGRAPH' },
      },
      select: { id: true, ownerId: true },
      orderBy: { id: 'desc' },
    });
    const out = new Map<bigint, bigint>();
    for (const r of rows) if (!out.has(r.ownerId)) out.set(r.ownerId, r.id);
    return out;
  }

  function toOut(p: ProfileRow, photo: bigint | null): ProfileOutT {
    const category = p.employmentType === 'worker' ? p.workerCategory : p.employeeCategory;
    const joined = businessDateFromDb(p.joiningDate);
    const until = p.separationDate ? businessDateFromDb(p.separationDate) : today();
    const probation = d(p.probationEndDate);
    return {
      id: p.id.toString(),
      person_id: p.personId.toString(),
      person: {
        id: p.person.id.toString(),
        person_code: p.person.personCode,
        full_name: p.person.fullName,
        father_name: p.person.fatherName,
        phone: p.person.phone,
        gender: p.person.gender as ProfileOutT['person']['gender'],
        date_of_birth: d(p.person.dateOfBirth),
        national_id: p.person.nationalId,
        photo_document_id: idOut(photo),
      },
      estate_id: p.estateId.toString(),
      estate: { id: p.estate.id.toString(), code: p.estate.code, name: p.estate.name },
      employment_type: p.employmentType as ProfileOutT['employment_type'],
      profile_number: p.profileNumber,
      category_id: category ? category.id.toString() : null,
      category: category ? { id: category.id.toString(), code: category.code, name: category.name } : null,
      engagement_type: p.engagementType as ProfileOutT['engagement_type'],
      employment_basis: p.employmentBasis as ProfileOutT['employment_basis'],
      job_nature: p.jobNature as ProfileOutT['job_nature'],
      working_location: p.workingLocation as ProfileOutT['working_location'],
      job_grade_id: idOut(p.jobGradeId),
      job_grade: p.jobGrade
        ? { id: p.jobGrade.id.toString(), code: p.jobGrade.code, name: p.jobGrade.name }
        : null,
      work_email: p.workEmail,
      joining_date: joined,
      confirmation_date: d(p.confirmationDate),
      probation_end_date: probation,
      on_probation: p.status !== 'separated' && probation !== null && today() < probation,
      separation_date: d(p.separationDate),
      separation_type: p.separationType as ProfileOutT['separation_type'],
      separation_reason: p.separationReason,
      supervisor_profile_id: idOut(p.supervisorProfileId),
      supervisor: p.supervisor
        ? {
            id: p.supervisor.id.toString(),
            profile_number: p.supervisor.profileNumber,
            full_name: p.supervisor.person.fullName,
          }
        : null,
      is_service_continuous: p.isServiceContinuous,
      service_years: Math.max(0, Math.floor((daysBetween(joined, until) / 365.25) * 10) / 10),
      nominee_name: p.nomineeName,
      nominee_relation: p.nomineeRelation as ProfileOutT['nominee_relation'],
      nominee_date_of_birth: d(p.nomineeDateOfBirth),
      nominee_national_id: p.nomineeNationalId,
      nominee_phone: p.nomineePhone,
      nominee_address: p.nomineeAddress,
      remarks: p.remarks,
      current_assignment: currentAssignmentOut(p.assignments),
      status: p.status as ProfileOutT['status'],
      user: p.users[0] ? { id: p.users[0].id.toString(), username: p.users[0].username } : null,
      created_by: { id: p.creator.id.toString(), username: p.creator.username },
      version: p.version,
      created_at: p.createdAt.toISOString(),
      updated_at: iso(p.updatedAt),
    };
  }
  async function outOf(p: ProfileRow): Promise<ProfileOutT> {
    return toOut(p, (await photos([p.personId])).get(p.personId) ?? null);
  }

  async function orNotFound(tx: Database | Tx, id: bigint): Promise<ProfileRow> {
    const p = await tx.employmentProfile.findUnique({ where: { id }, include: profileInclude(today()) });
    if (!p) throw Errors.notFound('Employment profile not found.');
    return p;
  }
  const canWrite = (p: { id: bigint | null; estateId: bigint }, operation: string) =>
    writable({ estate: p.estateId }).then((ok) =>
      ok ? undefined : denyWrite(accessLog, 'employment', p.id, operation),
    );
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  const data = (
    b: z.infer<typeof PatchProfileBody>,
    type: string,
  ): Prisma.EmploymentProfileUncheckedUpdateManyInput => {
    const out: Record<string, unknown> = {};
    const set = (k: keyof Prisma.EmploymentProfileUncheckedUpdateManyInput, v: unknown) => {
      if (v !== undefined) out[k] = v;
    };
    set('profileNumber', b.profile_number);
    if (b.category_id !== undefined) {
      set(type === 'worker' ? 'workerCategoryId' : 'employeeCategoryId', idIn(b.category_id));
    }
    set('engagementType', b.engagement_type);
    set('employmentBasis', b.employment_basis);
    set('jobNature', b.job_nature);
    set('workingLocation', b.working_location);
    set('jobGradeId', b.job_grade_id === undefined ? undefined : idIn(b.job_grade_id));
    set('workEmail', b.work_email);
    set('joiningDate', toDb(b.joining_date));
    set('confirmationDate', toDb(b.confirmation_date));
    set('probationEndDate', toDb(b.probation_end_date));
    set(
      'supervisorProfileId',
      b.supervisor_profile_id === undefined ? undefined : idIn(b.supervisor_profile_id),
    );
    set('isServiceContinuous', b.is_service_continuous);
    set('nomineeName', b.nominee_name);
    set('nomineeRelation', b.nominee_relation);
    set('nomineeDateOfBirth', toDb(b.nominee_date_of_birth));
    set('nomineeNationalId', b.nominee_national_id);
    set('nomineePhone', b.nominee_phone);
    set('nomineeAddress', b.nominee_address);
    set('remarks', b.remarks);
    return out;
  };

  /** The checks a CHECK or a key cannot word well, as field errors. */
  async function check(
    tx: Tx,
    b: z.infer<typeof PatchProfileBody>,
    ctx: { type: string; estateId: bigint; self?: ProfileRow },
  ) {
    const problems: ErrorDetail[] = [];
    const cur = ctx.self;
    const joining = b.joining_date ?? (cur ? businessDateFromDb(cur.joiningDate) : null);
    for (const [field, v] of [
      [
        'confirmation_date',
        b.confirmation_date !== undefined ? b.confirmation_date : d(cur?.confirmationDate ?? null),
      ],
      [
        'probation_end_date',
        b.probation_end_date !== undefined ? b.probation_end_date : d(cur?.probationEndDate ?? null),
      ],
    ] as const) {
      if (v !== null && joining !== null && v < joining)
        problems.push(invalid(field, 'Cannot be before the joining date.'));
    }
    // The first assignment starts on the joining date (P2.03): once one is approved, the date is fixed.
    if (cur && b.joining_date !== undefined && b.joining_date !== businessDateFromDb(cur.joiningDate)) {
      const placed = await tx.employmentAssignment.count({
        where: { employmentProfileId: cur.id, state: { in: ['submitted', 'approved'] } },
      });
      if (placed > 0) {
        problems.push(
          invalid('joining_date', 'The profile has assignments from its joining date: it is fixed.'),
        );
      }
    }
    if (b.nominee_date_of_birth && b.nominee_date_of_birth > today()) {
      problems.push(invalid('nominee_date_of_birth', 'Cannot be in the future.'));
    }
    if (b.category_id !== undefined && b.category_id !== null) {
      const kept = ctx.type === 'worker' ? cur?.workerCategoryId : cur?.employeeCategoryId;
      if (b.category_id !== kept) {
        const row =
          ctx.type === 'worker'
            ? await tx.workerCategory.findUnique({ where: { id: b.category_id }, select: { status: true } })
            : await tx.employeeCategory.findUnique({
                where: { id: b.category_id },
                select: { status: true },
              });
        if (row?.status !== 'active')
          problems.push(invalid('category_id', `No such active ${ctx.type} category.`));
      }
    }
    if (b.job_grade_id !== undefined && b.job_grade_id !== null && b.job_grade_id !== cur?.jobGradeId) {
      const g = await tx.jobGrade.findUnique({ where: { id: b.job_grade_id }, select: { status: true } });
      if (g?.status !== 'active') problems.push(invalid('job_grade_id', 'No such active job grade.'));
    }
    if (b.supervisor_profile_id !== undefined && b.supervisor_profile_id !== null) {
      const s = await tx.employmentProfile.findUnique({
        where: { id: b.supervisor_profile_id },
        select: { estateId: true, status: true, id: true },
      });
      if (s?.estateId !== ctx.estateId) {
        problems.push(invalid('supervisor_profile_id', 'No such profile in this estate.'));
      } else if (s.status === 'separated') {
        problems.push(invalid('supervisor_profile_id', 'That profile is separated.'));
      } else if (s.id === cur?.id) {
        problems.push(invalid('supervisor_profile_id', 'A profile cannot report to itself.'));
      }
    }
    if (problems.length > 0) throw Errors.validation(problems);
  }

  const onUnique =
    (number: string | undefined) =>
    (err: unknown): never => {
      const v = constraintViolation(err);
      if (v?.kind === 'unique' && v.index.includes('ux_profile_active')) {
        throw new AppError('DUPLICATE_KEY', 'This person already has an active profile of this type.', [
          { field: 'person_id', code: 'DUPLICATE_KEY', message: 'Separate the current profile first.' },
        ]);
      }
      return duplicate('profile_number', `Profile number ${number ?? ''} in this estate`)(err);
    };
  const readOnly = (p: ProfileRow) => {
    if (p.status === 'separated') {
      throw new AppError('INVALID_TRANSITION', 'A separated profile cannot be changed.', [
        { code: 'INVALID_TRANSITION', message: 'Open a new profile instead.', context: { state: p.status } },
      ]);
    }
  };

  async function transition(
    id: bigint,
    expectedVersion: number,
    actorId: bigint,
    operation: string,
    change: (p: ProfileRow) => Prisma.EmploymentProfileUncheckedUpdateInput,
    reason: string | null,
    effects?: (tx: Tx) => Promise<void>,
  ) {
    return withTransaction(db, async (tx) => {
      const before = await orNotFound(tx, id);
      await canWrite(before, operation);
      if (before.version !== expectedVersion) versionConflict(before, await outOf(before));
      readOnly(before);
      await tx.employmentProfile.update({ where: { id }, data: { ...change(before), ...stamp(actorId) } });
      await effects?.(tx);
      const after = await orNotFound(tx, id);
      const [b, a] = [await outOf(before), await outOf(after)];
      await auditUpdate(tx, PROFILE_AUDIT, id, b, a, { actorId, reason });
      if (before.status !== after.status) {
        await recordStatusChange(tx, PROFILE_AUDIT.type, id, before.status, after.status, { actorId });
      }
      return a;
    });
  }

  return {
    async list(q: ListQuery) {
      const search = q.filters.find((f) => f.field === 'q');
      const category = q.filters.find((f) => f.field === 'category_id');
      const placed = q.filters.filter((f) => f.field in ASSIGNED);
      const rest = {
        ...q,
        filters: q.filters.filter(
          (f) => f.field !== 'q' && f.field !== 'category_id' && !(f.field in ASSIGNED),
        ),
      };
      const where = toWhere(rest, PROFILE_LIST_FIELDS) as Prisma.EmploymentProfileWhereInput;
      const and: Prisma.EmploymentProfileWhereInput[] = [where];
      if (search) {
        const term = String(search.value);
        and.push({
          OR: [
            { profileNumber: { startsWith: term } },
            { person: { fullName: { contains: term } } },
            { person: { nationalId: { startsWith: term } } },
            { person: { phone: { contains: term } } },
          ],
        });
      }
      const idsOf = (v: unknown) => (Array.isArray(v) ? v : [v]).map((x) => BigInt(String(x)));
      // Department, designation, division, section, job / task: of the assignment in force today.
      for (const f of placed) {
        const column = ASSIGNED[f.field as keyof typeof ASSIGNED];
        and.push({ assignments: { some: { ...inForce(today()), [column]: { in: idsOf(f.value) } } } });
      }
      if (category) {
        const ids = idsOf(category.value);
        and.push({ OR: [{ workerCategoryId: { in: ids } }, { employeeCategoryId: { in: ids } }] });
      }
      const filter = { AND: and };
      const [rows, total] = await Promise.all([
        db.employmentProfile.findMany({
          where: filter,
          include: profileInclude(today()),
          orderBy: [...toOrderBy(q.sort, PROFILE_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.employmentProfile.count({ where: filter }),
      ]);
      const pics = await photos([...new Set(rows.map((r) => r.personId))]);
      return { items: rows.map((r) => toOut(r, pics.get(r.personId) ?? null)), total };
    },

    async get(id: bigint) {
      return outOf(await orNotFound(db, id));
    },

    async create(body: z.infer<typeof CreateProfileBody>, actorId: bigint) {
      return withTransaction(db, (tx) => this.createIn(tx, body, actorId));
    },

    /** The same inside the caller's transaction (the workforce import, P2.06). */
    async createIn(tx: Tx, body: z.infer<typeof CreateProfileBody>, actorId: bigint) {
      const person = await tx.person.findUnique({
        where: { id: body.person_id },
        select: { id: true, status: true },
      });
      const estate = await tx.estate.findUnique({
        where: { id: body.estate_id },
        select: { id: true, code: true, status: true },
      });
      const problems: ErrorDetail[] = [];
      if (!person) problems.push(invalid('person_id', 'No such person.'));
      else if (person.status !== 'active') problems.push(invalid('person_id', 'The person is inactive.'));
      if (!estate) problems.push(invalid('estate_id', 'No such estate.'));
      else if (estate.status !== 'active') problems.push(invalid('estate_id', 'The estate is inactive.'));
      if (problems.length > 0 || !estate) throw Errors.validation(problems);
      await canWrite({ id: null, estateId: estate.id }, 'create');
      await check(tx, body, { type: body.employment_type, estateId: estate.id });
      const number =
        body.profile_number ??
        (
          await allocateNumber(
            tx,
            body.employment_type === 'worker' ? 'worker_profile' : 'employee_profile',
            { date: today(), estateCode: estate.code },
            'draft',
          )
        ).number;
      const { id } = await tx.employmentProfile
        .create({
          data: {
            ...(data(body, body.employment_type) as Prisma.EmploymentProfileUncheckedCreateInput),
            personId: body.person_id,
            estateId: estate.id,
            employmentType: body.employment_type,
            profileNumber: number,
            engagementType: body.engagement_type,
            joiningDate: businessDateToDb(body.joining_date),
            status: 'active',
            createdBy: actorId,
          },
          select: { id: true },
        })
        .catch(onUnique(number));
      const out = await outOf(await orNotFound(tx, id));
      await auditCreate(tx, PROFILE_AUDIT, id, out, { actorId });
      await recordStatusChange(tx, PROFILE_AUDIT.type, id, null, 'active', { actorId });
      return out;
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchProfileBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        await canWrite(before, 'update');
        readOnly(before);
        await check(tx, changes, { type: before.employmentType, estateId: before.estateId, self: before });
        const { count } = await tx.employmentProfile
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...data(changes, before.employmentType), ...stamp(actorId) },
          })
          .catch(onUnique(changes.profile_number));
        if (count !== 1) versionConflict(before, await outOf(before));
        const after = await outOf(await orNotFound(tx, id));
        await auditUpdate(tx, PROFILE_AUDIT, id, await outOf(before), after, { actorId });
        return after;
      });
    },

    /** POST /separate (employment.approve, P4 §8.3): dated, typed, explained; final. */
    async separate(id: bigint, expectedVersion: number, b: z.infer<typeof SeparateBody>, actorId: bigint) {
      const p = await orNotFound(db, id);
      const problems: ErrorDetail[] = [];
      if (b.separation_date > today()) problems.push(invalid('separation_date', 'Cannot be in the future.'));
      if (b.separation_date < businessDateFromDb(p.joiningDate)) {
        problems.push(invalid('separation_date', 'Cannot be before the joining date.'));
      }
      if (problems.length > 0) throw Errors.validation(problems);
      return transition(
        id,
        expectedVersion,
        actorId,
        'separate',
        () => ({
          status: 'separated',
          separationDate: businessDateToDb(b.separation_date),
          separationType: b.separation_type,
          separationReason: b.reason,
        }),
        b.reason,
        // A separated worker leaves their team on the separation date (P2.04).
        (tx) => endMembershipsOnSeparation(tx, id, b.separation_date, actorId),
      );
    },

    async suspend(id: bigint, expectedVersion: number, reason: string, actorId: bigint) {
      return transition(
        id,
        expectedVersion,
        actorId,
        'suspend',
        (p) => {
          if (p.status !== 'active' && p.status !== 'on_leave') {
            throw new AppError('INVALID_TRANSITION', `A ${p.status} profile cannot be suspended.`, [
              {
                code: 'INVALID_TRANSITION',
                message: 'Only an active profile is suspended.',
                context: { state: p.status },
              },
            ]);
          }
          return { status: 'suspended' };
        },
        reason,
      );
    },

    async reinstate(id: bigint, expectedVersion: number, reason: string, actorId: bigint) {
      return transition(
        id,
        expectedVersion,
        actorId,
        'reinstate',
        (p) => {
          if (p.status !== 'suspended') {
            throw new AppError('INVALID_TRANSITION', `A ${p.status} profile is not suspended.`, [
              {
                code: 'INVALID_TRANSITION',
                message: 'Only a suspended profile is reinstated.',
                context: { state: p.status },
              },
            ]);
          }
          return { status: 'active' };
        },
        reason,
      );
    },

    /** Links (or unlinks) the user account that signs in as this profile; needs user.edit too. */
    async linkUser(
      id: bigint,
      expectedVersion: number,
      b: z.infer<typeof LinkUserBody>,
      actorId: bigint,
      url: string,
    ) {
      if (!(await holdsPermission(authz, 'user.edit'))) {
        throw new AppError('PERMISSION_DENIED', 'You do not have permission to do this.', [
          {
            code: 'PERMISSION_DENIED',
            message: 'Requires user.edit.',
            context: { permission: 'user.edit', url },
          },
        ]);
      }
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        await canWrite(before, 'link-user');
        if (before.version !== expectedVersion) versionConflict(before, await outOf(before));
        readOnly(before);
        if (b.user_id !== null) {
          const u = await tx.user.findUnique({
            where: { id: b.user_id },
            select: { status: true, employmentProfileId: true },
          });
          if (!u) throw Errors.validation([invalid('user_id', 'No such user.')]);
          if (u.employmentProfileId !== null && u.employmentProfileId !== id) {
            throw Errors.validation([invalid('user_id', 'That user is linked to another profile.')]);
          }
        }
        await tx.user.updateMany({ where: { employmentProfileId: id }, data: { employmentProfileId: null } });
        if (b.user_id !== null) {
          await tx.user.update({
            where: { id: b.user_id },
            data: { employmentProfileId: id, personId: before.personId },
          });
        }
        await tx.employmentProfile.update({ where: { id }, data: stamp(actorId) });
        const after = await outOf(await orNotFound(tx, id));
        await auditUpdate(tx, PROFILE_AUDIT, id, await outOf(before), after, { actorId });
        return after;
      });
    },

    /** Only a profile opened in error: nothing (a user, a manager link, a report) may refer to it. */
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const p = await orNotFound(tx, id);
        await canWrite(p, 'delete');
        await tx.employmentProfile.delete({ where: { id } }).catch(referenced('employment profile'));
        await auditDelete(tx, PROFILE_AUDIT, id, await outOf(p), { actorId });
      });
    },

    /** GET /persons/{id}/employment-profiles: the person's full employment history (P4 §8.3). */
    async ofPerson(personId: bigint) {
      if (!(await db.person.findUnique({ where: { id: personId }, select: { id: true } }))) {
        throw Errors.notFound('Person not found.');
      }
      const rows = await db.employmentProfile.findMany({
        where: { personId },
        include: profileInclude(today()),
        orderBy: [{ joiningDate: 'desc' }, { id: 'desc' }],
      });
      const pics = await photos([personId]);
      return rows.map((r) => toOut(r, pics.get(personId) ?? null));
    },

    /** GET /persons/{id}/service-summary: service across profiles, for gratuity (O-11). */
    async serviceSummary(personId: bigint): Promise<z.infer<typeof ServiceSummaryOut>> {
      if (!(await db.person.findUnique({ where: { id: personId }, select: { id: true } }))) {
        throw Errors.notFound('Person not found.');
      }
      // Service counts every profile, also those in estates the caller cannot see: it is the person's.
      const rows = await runUnscoped('service summary: all of a visible person’s profiles', () =>
        db.employmentProfile.findMany({ where: { personId }, orderBy: { joiningDate: 'asc' } }),
      );
      let total = 0;
      let continuous = 0;
      for (const r of rows) {
        const days =
          daysBetween(
            businessDateFromDb(r.joiningDate),
            r.separationDate ? businessDateFromDb(r.separationDate) : today(),
          ) + 1;
        total += Math.max(0, days);
        if (r.isServiceContinuous) continuous += Math.max(0, days);
      }
      const current = rows.find((r) => r.status !== 'separated');
      return {
        person_id: personId.toString(),
        profiles: rows.length,
        continuous_service_days: continuous,
        total_service_days: total,
        first_joining_date: rows[0] ? businessDateFromDb(rows[0].joiningDate) : null,
        current_profile_id: current ? current.id.toString() : null,
      };
    },

    /** The cards and charts of Worker / Employee Management, within the caller's scope. */
    async summary(
      type: 'worker' | 'employee' | undefined,
      estateId: bigint | undefined,
    ): Promise<z.infer<typeof WorkforceSummaryOut>> {
      const base: Prisma.EmploymentProfileWhereInput = {
        ...(type ? { employmentType: type } : {}),
        ...(estateId !== undefined ? { estateId } : {}),
      };
      const t = today();
      const monthStart = `${t.slice(0, 7)}-01` as BusinessDate;
      const rows = await db.employmentProfile.findMany({
        where: base,
        select: {
          id: true,
          status: true,
          engagementType: true,
          joiningDate: true,
          separationDate: true,
          employmentType: true,
          workerCategory: ref,
          employeeCategory: ref,
          person: { select: { fullName: true, gender: true, dateOfBirth: true } },
          assignments: { where: inForce(t), select: { department: ref }, take: 1 },
        },
      });
      const current = rows.filter((r) => r.status !== 'separated');
      const count = (s: string) => current.filter((r) => r.status === s).length;
      const pct = (n: number) => (current.length === 0 ? '0.00' : ((n / current.length) * 100).toFixed(2));
      const bucket = <T>(items: T[], key: (i: T) => [string, string] | null) => {
        const m = new Map<string, { key: string; label: string; count: number }>();
        for (const i of items) {
          const k = key(i);
          if (!k) continue;
          const e = m.get(k[0]) ?? { key: k[0], label: k[1], count: 0 };
          e.count += 1;
          m.set(k[0], e);
        }
        return [...m.values()];
      };
      const years = (r: (typeof rows)[number]) =>
        daysBetween(
          businessDateFromDb(r.joiningDate),
          r.separationDate ? businessDateFromDb(r.separationDate) : t,
        ) / 365.25;
      const AGE = [
        ['under_25', '< 25', 0, 25],
        ['25_35', '25 - 35', 25, 35],
        ['35_45', '35 - 45', 35, 45],
        ['45_55', '45 - 55', 45, 55],
        ['55_plus', '55+', 55, 200],
      ] as const;
      const SERVICE = [
        ['0_1', '0 - 1 Year', 0, 1],
        ['1_3', '1 - 3 Years', 1, 3],
        ['3_5', '3 - 5 Years', 3, 5],
        ['5_10', '5 - 10 Years', 5, 10],
        ['10_plus', '10+ Years', 10, 1000],
      ] as const;
      const inMonth = (date: BusinessDate) => date.slice(5, 7) === t.slice(5, 7);
      const byAge = AGE.map(([key, label, lo, hi]) => ({
        key,
        label,
        count: current.filter((r) => {
          const a = ageOn(d(r.person.dateOfBirth), t);
          return a !== null && a >= lo && a < hi;
        }).length,
      }));
      const byService = SERVICE.map(([key, label, lo, hi]) => ({
        key,
        label,
        count: current.filter((r) => years(r) >= lo && years(r) < hi).length,
      }));
      const tenure =
        current.length === 0 ? null : (current.reduce((n, r) => n + years(r), 0) / current.length).toFixed(1);
      return {
        employment_type: type ?? null,
        estate_id: estateId?.toString() ?? null,
        as_of: new Date().toISOString(),
        total: current.length,
        active: count('active'),
        on_leave: count('on_leave'),
        suspended: count('suspended'),
        separated: rows.length - current.length,
        active_pct: pct(count('active')),
        on_leave_pct: pct(count('on_leave')),
        new_this_month: rows.filter((r) => businessDateFromDb(r.joiningDate) >= monthStart).length,
        exits_this_month: rows.filter(
          (r) => r.separationDate && businessDateFromDb(r.separationDate) >= monthStart,
        ).length,
        average_tenure_years: tenure,
        by_category: bucket(current, (r) => {
          const c = r.employmentType === 'worker' ? r.workerCategory : r.employeeCategory;
          return c ? [c.code, c.name] : ['none', 'Not set'];
        }),
        by_department: bucket(current, (r) => {
          const dep = r.assignments[0]?.department;
          return dep ? [dep.code, dep.name] : ['none', 'Not set'];
        }),
        by_engagement_type: bucket(current, (r) => [r.engagementType, r.engagementType]),
        by_gender: bucket(current, (r) => [r.person.gender ?? 'unknown', r.person.gender ?? 'Not set']),
        by_age_group: byAge,
        by_length_of_service: byService,
        birthdays_this_month: current
          .filter((r) => r.person.dateOfBirth && inMonth(businessDateFromDb(r.person.dateOfBirth)))
          .map((r) => ({
            profile_id: r.id.toString(),
            full_name: r.person.fullName,
            date: d(r.person.dateOfBirth) ?? '',
          }))
          .sort((a, b) => a.date.slice(5).localeCompare(b.date.slice(5))),
        anniversaries_this_month: current
          .filter(
            (r) =>
              inMonth(businessDateFromDb(r.joiningDate)) &&
              businessDateFromDb(r.joiningDate).slice(0, 4) < t.slice(0, 4),
          )
          .map((r) => {
            const j = businessDateFromDb(r.joiningDate);
            return {
              profile_id: r.id.toString(),
              full_name: r.person.fullName,
              date: j,
              years: Number(t.slice(0, 4)) - Number(j.slice(0, 4)),
            };
          })
          .sort((a, b) => a.date.slice(5).localeCompare(b.date.slice(5))),
      };
    },
  };
}

export type ProfileService = ReturnType<typeof profileService>;
