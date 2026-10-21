import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import type { PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/app-error.js';
import {
  registerImportType,
  type CommitRequest,
  type ImportColumn,
  type ImportType,
  type RowError,
} from '../../core/imports/registry.js';
import { CreateAssignmentBody, type PAY_COMPONENTS } from './assignment.schema.js';
import { assignmentService } from './assignment.service.js';
import {
  CONTRACTOR_TYPES,
  CreateContractorBody,
  PAYMENT_TERMS,
  RATE_BASES,
  WORK_LOCATIONS,
  WORK_TYPES,
} from './contractor.schema.js';
import { contractorService } from './contractor.service.js';
import {
  BLOOD_GROUPS,
  CreatePersonBody,
  GENDERS,
  MARITAL_STATUSES,
  MOBILE_BANKING,
  RELATIONS,
  TITLES,
} from './person.schema.js';
import { personService } from './person.service.js';
import {
  CreateProfileBody,
  EMPLOYMENT_BASES,
  ENGAGEMENT_TYPES,
  JOB_NATURES,
  WORKING_LOCATIONS,
} from './profile.schema.js';
import { profileService } from './profile.service.js';

/**
 * Workforce bulk import (P2.06; Spec P2 §11.4, BACKLOG D-2-5, D-2.06-*), on the P1.17 framework:
 *
 *   workforce.worker      one row = a person, their worker profile and the joining assignment, in the
 *                         columns of the design's Add New Worker form
 *   workforce.employee    the same for an employee, with department, designation, grade and the salary
 *                         structure of Add New Employee
 *   workforce.contractor  a contractor, its contact person and, optionally, a first (draft) contract
 *
 * Each row is saved through the same services as the forms (createIn, in the row's transaction), so it
 * is checked, numbered, audited and scoped exactly as one typed in; validation runs with the uploader's
 * data scope and commit with the committer's (actsAsUser). A national ID already registered reuses that
 * person rather than duplicating them. References are written as codes (estate, division, section,
 * category, job / task, department …), never ids.
 */

const MAX_ROWS = 5000;

type Row = Readonly<Record<string, string>>;
interface Mapped {
  /** API field → value, for the schema. */
  body: Record<string, unknown>;
  errors: RowError[];
}

const col = (name: string, required: boolean, description: string, example: string): ImportColumn => ({
  name,
  required,
  description,
  example,
});
const oneOf = (values: readonly string[]) => `One of: ${values.join(', ')}`;
const DATE_HELP = 'A date, YYYY-MM-DD (or DD/MM/YYYY)';
const err = (column: string | null, message: string, code = 'VALIDATION_FAILED'): RowError => ({
  column,
  code,
  message,
});

/** YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY → YYYY-MM-DD; anything else is returned as given (the schema refuses it). */
function isoDate(text: string): string {
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  return m ? `${m[3] ?? ''}-${(m[2] ?? '').padStart(2, '0')}-${(m[1] ?? '').padStart(2, '0')}` : text;
}
/** "Full Time" → full_time; "Private Ltd" → private_ltd. */
const enumOf = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

type Lookup =
  | 'workerCategory'
  | 'employeeCategory'
  | 'jobGrade'
  | 'religion'
  | 'educationLevel'
  | 'department'
  | 'designation'
  | 'activityType'
  | 'tradeCategory';

/** Resolves the columns of a row into API fields; collects each column's own errors. */
class RowReader {
  readonly m: Mapped = { body: {}, errors: [] };
  constructor(
    private readonly row: Row,
    private readonly tx: Tx,
  ) {}
  text(column: string) {
    return (this.row[column] ?? '').trim();
  }
  str(column: string, field = column) {
    const v = this.text(column);
    if (v !== '') this.m.body[field] = v;
    return v;
  }
  date(column: string, field = column) {
    const v = this.text(column);
    if (v !== '') this.m.body[field] = isoDate(v);
  }
  int(column: string, field = column) {
    const v = this.text(column);
    if (v === '') return;
    if (/^\d+$/.test(v)) this.m.body[field] = Number(v);
    else this.m.errors.push(err(column, 'Must be a whole number.'));
  }
  enumeration(column: string, values: readonly string[], field = column) {
    const v = this.text(column);
    if (v === '') return;
    const e = values.find((x) => x.toLowerCase() === v.toLowerCase()) ?? values.find((x) => x === enumOf(v));
    if (e) this.m.body[field] = e;
    else this.m.errors.push(err(column, oneOf(values)));
  }
  async code(column: string, model: Lookup, field: string, what: string) {
    const v = this.text(column);
    if (v === '') return null;
    const m = this.tx[model] as unknown as {
      findUnique(a: {
        where: { code: string };
        select: { id: true; status: true };
      }): Promise<{ id: bigint; status: string } | null>;
    };
    const r = await m.findUnique({ where: { code: v.toUpperCase() }, select: { id: true, status: true } });
    const hit = r ?? (await m.findUnique({ where: { code: v }, select: { id: true, status: true } }));
    if (hit?.status !== 'active') {
      this.m.errors.push(err(column, `No active ${what} with the code ${v}.`));
      return null;
    }
    this.m.body[field] = hit.id.toString();
    return hit.id;
  }
  require(column: string) {
    if (this.text(column) === '') this.m.errors.push(err(column, 'Required.'));
  }
}

/** Maps a schema's issues to the file's columns (field → column), skipping columns already reported. */
function issuesToErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  columnOf: (path: string) => string | null,
  already: readonly RowError[],
): RowError[] {
  const out: RowError[] = [];
  for (const i of issues) {
    const column = columnOf(i.path.map(String).join('.'));
    if ([...already, ...out].some((e) => e.column === column)) continue;
    out.push(err(column, i.message));
  }
  return out;
}

// ---- the person and profile columns shared by workers and employees ---------------------------------------
const PERSON_COLUMNS: readonly ImportColumn[] = [
  col('estate', true, 'The estate code (Garden): the profile is opened there', 'DEMO-A'),
  col('title', false, oneOf(TITLES), 'mr'),
  col('first_name', true, 'Text, up to 100 characters', 'Rahim'),
  col('middle_name', false, 'Text', ''),
  col('last_name', false, 'Text', 'Uddin'),
  col('father_name', false, 'Text', 'Karim Uddin'),
  col('mother_name', false, 'Text', ''),
  col('date_of_birth', false, DATE_HELP, '1988-04-12'),
  col('gender', false, oneOf(GENDERS), 'male'),
  col('marital_status', false, oneOf(MARITAL_STATUSES), 'married'),
  col('blood_group', false, oneOf(BLOOD_GROUPS), 'B+'),
  col('religion', false, 'The religion code (GET /lookups/religion)', 'ISLAM'),
  col('national_id', false, 'NID. An NID already registered reuses that person', '1990123456789'),
  col('tin', false, 'Text', ''),
  col('mobile', false, 'A phone number, e.g. +8801711000001', '+8801711000001'),
  col('alternate_mobile', false, 'A phone number', ''),
  col('personal_email', false, 'An email address', ''),
  col('present_address', false, 'Text', 'Line 4, Lalbagh division'),
  col('present_district', false, 'Text', 'Moulvibazar'),
  col('present_upazila', false, 'Text', 'Sreemangal'),
  col('present_postal_code', false, 'Text', '3210'),
  col('permanent_address', false, 'Text', ''),
  col('permanent_district', false, 'Text', ''),
  col('education_level', false, 'The education level code', 'PRIMARY'),
  col('experience_years', false, 'A whole number', '8'),
  col('emergency_contact_name', false, 'Text', 'Amena Begum'),
  col('emergency_contact_mobile', false, 'A phone number', '+8801711000011'),
  col('emergency_contact_relation', false, oneOf(RELATIONS), 'spouse'),
  col('bank_name', false, 'Text', ''),
  col('bank_account_number', false, 'Text', ''),
  col('mobile_banking_provider', false, oneOf(MOBILE_BANKING), 'bkash'),
  col('mobile_banking_number', false, 'A phone number', '+8801711000001'),
];
const PERSON_FIELD: Record<string, string> = {
  registered_estate_id: 'estate',
  phone: 'mobile',
  alternate_phone: 'alternate_mobile',
  religion_id: 'religion',
  education_level_id: 'education_level',
  emergency_contact_phone: 'emergency_contact_mobile',
};

function readPerson(r: RowReader, estateId: bigint | null) {
  if (estateId !== null) r.m.body.registered_estate_id = estateId.toString();
  r.enumeration('title', TITLES);
  for (const c of [
    'first_name',
    'middle_name',
    'last_name',
    'father_name',
    'mother_name',
    'national_id',
    'tin',
    'personal_email',
    'present_address',
    'present_district',
    'present_upazila',
    'present_postal_code',
    'permanent_address',
    'permanent_district',
    'emergency_contact_name',
    'bank_name',
    'bank_account_number',
  ]) {
    r.str(c);
  }
  r.str('mobile', 'phone');
  r.str('alternate_mobile', 'alternate_phone');
  r.str('emergency_contact_mobile', 'emergency_contact_phone');
  r.str('mobile_banking_number');
  r.date('date_of_birth');
  r.enumeration('gender', GENDERS);
  r.enumeration('marital_status', MARITAL_STATUSES);
  r.enumeration('blood_group', BLOOD_GROUPS);
  r.enumeration('emergency_contact_relation', RELATIONS);
  r.enumeration('mobile_banking_provider', MOBILE_BANKING);
  r.int('experience_years');
  if (r.text('mobile_banking_provider') !== '') r.m.body.payment_method = 'mobile_banking';
  else if (r.text('bank_account_number') !== '') r.m.body.payment_method = 'bank';
}

interface PeopleValue {
  readonly type: 'worker' | 'employee';
  readonly person: z.infer<typeof CreatePersonBody>;
  /** A person already registered under the row's NID. */
  readonly existingPersonId: bigint | null;
  readonly profile: Omit<z.infer<typeof CreateProfileBody>, 'person_id'>;
  readonly assignment: z.infer<typeof CreateAssignmentBody>;
  readonly hasPay: boolean;
}

/** The deps the importers save through. */
export interface WorkforceImportDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly authz: PermissionResolver;
  readonly timezone: string;
}

function peopleImport(type: 'worker' | 'employee', deps: WorkforceImportDeps): ImportType<PeopleValue> {
  const persons = personService(deps.db, deps.accessLog, deps.timezone);
  const profiles = profileService(deps);
  const assignments = assignmentService(deps);
  const worker = type === 'worker';
  const PAY: readonly (readonly [string, (typeof PAY_COMPONENTS)[number]])[] = [
    ['basic_salary', 'basic'],
    ['house_rent', 'house_rent'],
    ['medical_allowance', 'medical'],
    ['conveyance', 'conveyance'],
    ['other_allowance', 'other'],
  ];
  const profileColumns: ImportColumn[] = [
    col(
      worker ? 'worker_id' : 'employee_id',
      false,
      `The ${worker ? 'Worker' : 'Employee'} ID, unique in the estate. Numbered when empty`,
      '',
    ),
    col(worker ? 'worker_type' : 'employee_type', true, oneOf(ENGAGEMENT_TYPES), 'permanent'),
    col('category', false, `The ${type} category code`, worker ? 'GENERAL' : 'OFFICER'),
    col('join_date', true, DATE_HELP + '. The joining assignment starts on it', '2016-07-15'),
    col('employment_type', false, oneOf(EMPLOYMENT_BASES), 'full_time'),
    col('job_nature', false, oneOf(JOB_NATURES), worker ? 'field' : 'office'),
    col('working_location', false, oneOf(WORKING_LOCATIONS), worker ? 'field' : 'office'),
    col('reporting_to', false, 'The Worker / Employee ID of the supervisor, in the same estate', ''),
    col('probation_end_date', false, DATE_HELP, ''),
    ...(worker
      ? []
      : [
          col('job_grade', false, 'The job grade code', 'GRADE_2'),
          col('work_email', false, 'An email address', ''),
          col('confirmation_date', false, DATE_HELP, ''),
          col('nominee_name', false, 'Text', ''),
          col('nominee_relation', false, oneOf(RELATIONS), ''),
          col('nominee_mobile', false, 'A phone number', ''),
        ]),
  ];
  const assignmentColumns: ImportColumn[] = worker
    ? [
        col(
          'division',
          false,
          'The division (Garden / Unit) code in the estate. Taken from the section when empty',
          'N',
        ),
        col('section', true, 'The section code (within the division when given)', 'N1'),
        col('job_task', true, 'The job / task code (GET /lookups/activity_type), e.g. PLUCKING', 'PLUCKING'),
      ]
    : [
        col('department', true, 'The department code', 'HR_ADMIN'),
        col('designation', true, 'The designation code', 'HR_OFFICER'),
        col('division', false, 'The division code in the estate', ''),
        col('section', false, 'The section code', ''),
        ...PAY.map(([c]) =>
          col(
            c,
            false,
            `A number, e.g. 15000.00. ${c === 'basic_salary' ? 'Required when any salary line is given. ' : ''}Salary lines are approved by whoever commits the file`,
            c === 'basic_salary' ? '30000' : '',
          ),
        ),
      ];

  const PROFILE_FIELD: Record<string, string> = {
    profile_number: worker ? 'worker_id' : 'employee_id',
    engagement_type: worker ? 'worker_type' : 'employee_type',
    category_id: 'category',
    joining_date: 'join_date',
    employment_basis: 'employment_type',
    supervisor_profile_id: 'reporting_to',
    job_grade_id: 'job_grade',
    nominee_phone: 'nominee_mobile',
  };
  const ASSIGNMENT_FIELD: Record<string, string> = {
    division_id: 'division',
    section_id: 'section',
    activity_type_id: 'job_task',
    department_id: 'department',
    designation_id: 'designation',
    effective_from: 'join_date',
    pay_lines: 'basic_salary',
  };

  return {
    key: `workforce.${type}`,
    label: worker ? 'Workers' : 'Employees',
    permission: 'employment',
    columns: [...PERSON_COLUMNS, ...profileColumns, ...assignmentColumns],
    maxRows: MAX_ROWS,
    actsAsUser: true,

    async authoriseCommit(c: CommitRequest) {
      if (worker) return;
      const rows = await c.db.importRow.findMany({
        where: { importBatchId: c.batchId, state: 'valid' },
        select: { data: true },
      });
      const withPay = rows.filter((r) =>
        PAY.some(([col_]) => ((r.data as Record<string, string>)[col_] ?? '').trim() !== ''),
      ).length;
      if (withPay === 0) return;
      if (!(await c.holds('employment.approve'))) {
        throw new AppError('PERMISSION_DENIED', 'This file sets salaries: committing it approves them.', [
          {
            code: 'PERMISSION_DENIED',
            message: `Requires employment.approve (${String(withPay)} rows with salary lines).`,
            context: { permission: 'employment.approve' },
          },
        ]);
      }
      if (c.actorId === c.uploadedBy) {
        throw new AppError(
          'SELF_APPROVAL_FORBIDDEN',
          'Salaries you uploaded are committed by someone else.',
          [
            {
              code: 'SELF_APPROVAL_FORBIDDEN',
              message:
                'Committing approves the salary lines (P7 §9.6): another person with employment.approve commits this file.',
            },
          ],
        );
      }
    },

    async check(row, tx) {
      const r = new RowReader(row, tx);
      r.require('estate');
      const estateCode = r.text('estate');
      const estate = estateCode
        ? await tx.estate.findFirst({ where: { code: estateCode }, select: { id: true, status: true } })
        : null;
      if (estateCode && estate?.status !== 'active')
        r.m.errors.push(err('estate', `No active estate ${estateCode} in your scope.`));
      const estateId = estate?.status === 'active' ? estate.id : null;

      // person
      readPerson(r, estateId);
      await r.code('religion', 'religion', 'religion_id', 'religion');
      await r.code('education_level', 'educationLevel', 'education_level_id', 'education level');
      const personBody = { ...r.m.body };
      r.m.body = {};

      // profile
      r.str(worker ? 'worker_id' : 'employee_id', 'profile_number');
      r.enumeration(worker ? 'worker_type' : 'employee_type', ENGAGEMENT_TYPES, 'engagement_type');
      await r.code(
        'category',
        worker ? 'workerCategory' : 'employeeCategory',
        'category_id',
        `${type} category`,
      );
      r.date('join_date', 'joining_date');
      r.enumeration('employment_type', EMPLOYMENT_BASES, 'employment_basis');
      r.enumeration('job_nature', JOB_NATURES);
      r.enumeration('working_location', WORKING_LOCATIONS);
      r.date('probation_end_date');
      if (!worker) {
        await r.code('job_grade', 'jobGrade', 'job_grade_id', 'job grade');
        r.str('work_email');
        r.date('confirmation_date');
        r.str('nominee_name');
        r.enumeration('nominee_relation', RELATIONS);
        r.str('nominee_mobile', 'nominee_phone');
      }
      const boss = r.text('reporting_to');
      if (boss && estateId !== null) {
        const s = await tx.employmentProfile.findFirst({
          where: { estateId, profileNumber: boss },
          select: { id: true, status: true },
        });
        if (!s || s.status === 'separated')
          r.m.errors.push(err('reporting_to', `No current profile ${boss} in the estate.`));
        else r.m.body.supervisor_profile_id = s.id.toString();
      }
      const profileBody = {
        ...r.m.body,
        person_id: '1',
        estate_id: estateId?.toString() ?? '1',
        employment_type: type,
      };
      r.m.body = {};

      // assignment (the joining one)
      const divisionCode = r.text('division');
      let divisionId: bigint | null = null;
      if (divisionCode && estateId !== null) {
        const d = await tx.division.findFirst({
          where: { estateId, code: divisionCode, status: 'active' },
          select: { id: true },
        });
        if (!d) r.m.errors.push(err('division', `No active division ${divisionCode} in the estate.`));
        else {
          divisionId = d.id;
          r.m.body.division_id = d.id.toString();
        }
      }
      const sectionCode = r.text('section');
      if (sectionCode && estateId !== null) {
        const found = await tx.section.findMany({
          where: {
            code: sectionCode,
            status: 'active',
            division: { estateId, ...(divisionId !== null ? { id: divisionId } : {}) },
          },
          select: { id: true },
          take: 2,
        });
        if (found.length === 0)
          r.m.errors.push(
            err(
              'section',
              `No active section ${sectionCode} ${divisionId !== null ? 'in that division' : 'in the estate'}.`,
            ),
          );
        else if (found.length > 1)
          r.m.errors.push(
            err('section', `Section ${sectionCode} is in more than one division: give the division.`),
          );
        else r.m.body.section_id = found[0]?.id.toString();
      }
      if (worker) {
        r.require('section');
        r.require('job_task');
        await r.code('job_task', 'activityType', 'activity_type_id', 'job / task');
      } else {
        r.require('department');
        r.require('designation');
        await r.code('department', 'department', 'department_id', 'department');
        await r.code('designation', 'designation', 'designation_id', 'designation');
      }
      const lines = PAY.flatMap(([c, component]) => {
        const v = r.text(c);
        if (v === '') return [];
        if (!/^\d{1,14}(\.\d{1,4})?$/.test(v)) {
          r.m.errors.push(err(c, 'A number, e.g. 15000.00.'));
          return [];
        }
        return [{ component, amount: v }];
      });
      if (lines.length > 0) {
        if (!lines.some((l) => l.component === 'basic'))
          r.m.errors.push(err('basic_salary', 'A salary structure has a basic salary.'));
        r.m.body.pay_lines = lines;
      }
      const joining = r.text('join_date');
      const assignmentBody = {
        ...r.m.body,
        effective_from: joining ? isoDate(joining) : '',
        change_reason: 'joining',
      };

      // the schemas: every remaining rule of the forms
      const errors = [...r.m.errors];
      const person = CreatePersonBody.safeParse(personBody);
      if (!person.success)
        errors.push(...issuesToErrors(person.error.issues, (f) => PERSON_FIELD[f] ?? f, errors));
      const profile = CreateProfileBody.safeParse(profileBody);
      if (!profile.success)
        errors.push(...issuesToErrors(profile.error.issues, (f) => PROFILE_FIELD[f] ?? f, errors));
      const assignment = CreateAssignmentBody.safeParse(assignmentBody);
      if (!assignment.success)
        errors.push(
          ...issuesToErrors(
            assignment.error.issues,
            (f) => ASSIGNMENT_FIELD[f.split('.')[0] ?? f] ?? f,
            errors,
          ),
        );

      // the person: reuse one already registered under the NID, unless they are employed so already
      const nid = r.text('national_id');
      let existingPersonId: bigint | null = null;
      if (nid) {
        const p = await tx.person.findFirst({ where: { nationalId: nid }, select: { id: true } });
        if (p) {
          existingPersonId = p.id;
          const active = await tx.employmentProfile.count({
            where: { personId: p.id, employmentType: type, status: { not: 'separated' } },
          });
          if (active > 0)
            errors.push(
              err('national_id', `This person already has a current ${type} profile.`, 'DUPLICATE_KEY'),
            );
        }
      }
      const number = r.text(worker ? 'worker_id' : 'employee_id');
      if (
        number &&
        estateId !== null &&
        (await tx.employmentProfile.count({ where: { estateId, profileNumber: number } })) > 0
      ) {
        errors.push(
          err(
            worker ? 'worker_id' : 'employee_id',
            `${number} is already used in the estate.`,
            'DUPLICATE_KEY',
          ),
        );
      }
      if (errors.length > 0 || !person.success || !profile.success || !assignment.success)
        return { ok: false, errors };
      const profileValue: Omit<z.infer<typeof CreateProfileBody>, 'person_id'> = (({
        person_id: _p,
        ...rest
      }) => rest)(profile.data);
      return {
        ok: true,
        value: {
          type,
          person: person.data,
          existingPersonId,
          profile: profileValue,
          assignment: assignment.data,
          hasPay: lines.length > 0,
        },
        // The same person twice in a file is refused (by NID), as is the same ID twice in an estate.
        ...(nid ? { key: `nid:${nid}` } : number ? { key: `id:${estateCode}:${number}` } : {}),
      };
    },

    async commit(v, tx, actorId) {
      const personId = v.existingPersonId ?? BigInt((await persons.createIn(tx, v.person, actorId)).id);
      const profile = await profiles.createIn(tx, { ...v.profile, person_id: personId }, actorId);
      const a = await assignments.createIn(tx, BigInt(profile.id), v.assignment, actorId);
      // Committing approves the file's salaries (authoriseCommit checked who may): D-2.06-3.
      await assignments.submitIn(
        tx,
        BigInt(a.id),
        null,
        actorId,
        v.hasPay ? { wageApprovedBy: actorId } : {},
      );
      return profile.id;
    },
  };
}

// ---- contractors -------------------------------------------------------------------------------------------
function contractorImport(deps: WorkforceImportDeps): ImportType<z.infer<typeof CreateContractorBody>> {
  const contractors = contractorService(deps);
  const columns: ImportColumn[] = [
    col('contractor_id', false, 'Unique. Numbered CON-… when empty', ''),
    col('contractor_type', true, oneOf(CONTRACTOR_TYPES), 'company'),
    col('trade_category', true, 'The trade / work category code (GET /lookups/trade_category)', 'PLUCKING'),
    col('contractor_name', true, 'Text, up to 150 characters', 'M/S Green Leaf Services'),
    col('short_name', false, 'Text', 'GLS'),
    col(
      'legal_status',
      false,
      'proprietorship, partnership, private_ltd, public_ltd, other',
      'proprietorship',
    ),
    col('contractor_since', false, DATE_HELP, ''),
    col('description', false, 'Nature of work', ''),
    col('mobile', true, 'A phone number', '+8801712345678'),
    col('alternate_mobile', false, 'A phone number', ''),
    col('email', false, 'An email address', ''),
    col('present_address', true, 'Text', 'Tea Garden Road, Sreemangal'),
    col('present_district', true, 'Text', 'Moulvibazar'),
    col('present_upazila', false, 'Text', ''),
    col('present_postal_code', false, 'Text', ''),
    col('contact_person_name', true, 'Text', 'Mr. Jahangir Alam'),
    col('contact_person_designation', false, 'Text', 'Proprietor'),
    col('contact_person_mobile', true, 'A phone number', '+8801712000000'),
    col('contact_person_email', false, 'An email address', ''),
    col('national_id', false, 'Text', ''),
    col('trade_licence_no', true, 'Text', 'TL-2026-1256'),
    col('trade_licence_expiry', false, DATE_HELP, ''),
    col('bin_no', false, 'Text', ''),
    col('tin_no', false, 'Text', ''),
    col('vat_registration_no', false, 'Text', ''),
    col('company_registration_no', false, 'Text', ''),
    col('bank_name', true, 'Text', 'Islami Bank Bangladesh Ltd.'),
    col('branch_name', true, 'Text', 'Sreemangal'),
    col('account_name', true, 'Text', 'Green Leaf Services'),
    col('account_no', true, 'Text', '05012345678901'),
    col('routing_no', false, 'Text', ''),
    col('mobile_banking_provider', false, oneOf(MOBILE_BANKING), ''),
    col('mobile_banking_number', false, 'A phone number', ''),
    col('years_of_experience', false, 'A whole number', ''),
    col('emergency_contact_name', true, 'Text', 'Jahangir Alam'),
    col('emergency_relation', true, oneOf(RELATIONS), 'brother'),
    col('emergency_mobile', true, 'A phone number', '+8801711000099'),
    col('estate', false, 'The estate code that registers it (and of its first contract)', 'DEMO-A'),
    col('contract_reference_no', false, 'First contract (optional): the agreement reference', ''),
    col('work_type', false, `First contract: ${oneOf(WORK_TYPES)}`, ''),
    col('rate_basis', false, `First contract: ${oneOf(RATE_BASES)}`, ''),
    col('rate', false, 'First contract: a number', ''),
    col('contract_start_date', false, `First contract: ${DATE_HELP}`, ''),
    col('contract_end_date', false, `First contract: ${DATE_HELP}`, ''),
    col('contract_value', false, 'First contract: a number (required for lump_sum)', ''),
    col('payment_terms', false, `First contract: ${oneOf(PAYMENT_TERMS)}`, ''),
    col('work_location', false, `First contract: ${oneOf(WORK_LOCATIONS)}`, ''),
  ];
  const FIELD: Record<string, string> = {
    code: 'contractor_id',
    trade_category_id: 'trade_category',
    name: 'contractor_name',
    phone: 'mobile',
    phone_alt: 'alternate_mobile',
    address_line1: 'present_address',
    trade_licence_number: 'trade_licence_no',
    bin: 'bin_no',
    tin: 'tin_no',
    vat_registration_number: 'vat_registration_no',
    registration_number: 'company_registration_no',
    bank_branch: 'branch_name',
    bank_account_name: 'account_name',
    bank_account_number: 'account_no',
    bank_routing_number: 'routing_no',
    emergency_phone: 'emergency_mobile',
    registered_estate_id: 'estate',
    'contact_person.contact_name': 'contact_person_name',
    'contact_person.designation': 'contact_person_designation',
    'contact_person.phone': 'contact_person_mobile',
    'contact_person.email': 'contact_person_email',
    'first_contract.reference_number': 'contract_reference_no',
    'first_contract.work_type': 'work_type',
    'first_contract.rate_basis': 'rate_basis',
    'first_contract.rate': 'rate',
    'first_contract.start_date': 'contract_start_date',
    'first_contract.end_date': 'contract_end_date',
    'first_contract.contract_value': 'contract_value',
    'first_contract.payment_terms': 'payment_terms',
    'first_contract.work_location': 'work_location',
    'first_contract.estate_id': 'estate',
  };
  const CONTRACT_COLUMNS = [
    'contract_reference_no',
    'work_type',
    'rate_basis',
    'rate',
    'contract_start_date',
    'contract_end_date',
    'contract_value',
    'payment_terms',
    'work_location',
  ];

  return {
    key: 'workforce.contractor',
    label: 'Contractors',
    permission: 'contractor',
    columns,
    maxRows: MAX_ROWS,
    actsAsUser: true,

    async check(row, tx) {
      const r = new RowReader(row, tx);
      const estateCode = r.text('estate');
      const estate = estateCode
        ? await tx.estate.findFirst({ where: { code: estateCode }, select: { id: true, status: true } })
        : null;
      if (estateCode && estate?.status !== 'active')
        r.m.errors.push(err('estate', `No active estate ${estateCode} in your scope.`));
      r.str('contractor_id', 'code');
      r.enumeration('contractor_type', CONTRACTOR_TYPES);
      await r.code('trade_category', 'tradeCategory', 'trade_category_id', 'trade category');
      r.require('trade_category');
      r.str('contractor_name', 'name');
      r.str('short_name');
      r.enumeration('legal_status', ['proprietorship', 'partnership', 'private_ltd', 'public_ltd', 'other']);
      r.date('contractor_since');
      r.str('description');
      r.str('mobile', 'phone');
      r.str('alternate_mobile', 'phone_alt');
      r.str('email');
      r.str('present_address', 'address_line1');
      for (const c of [
        'present_district',
        'present_upazila',
        'present_postal_code',
        'national_id',
        'bank_name',
        'emergency_contact_name',
      ])
        r.str(c);
      r.str('trade_licence_no', 'trade_licence_number');
      r.date('trade_licence_expiry');
      r.str('bin_no', 'bin');
      r.str('tin_no', 'tin');
      r.str('vat_registration_no', 'vat_registration_number');
      r.str('company_registration_no', 'registration_number');
      r.str('branch_name', 'bank_branch');
      r.str('account_name', 'bank_account_name');
      r.str('account_no', 'bank_account_number');
      r.str('routing_no', 'bank_routing_number');
      r.enumeration('mobile_banking_provider', MOBILE_BANKING);
      r.str('mobile_banking_number');
      r.int('years_of_experience');
      r.enumeration('emergency_relation', RELATIONS);
      r.str('emergency_mobile', 'emergency_phone');
      const body: Record<string, unknown> = { ...r.m.body };
      if (estate?.status === 'active') body.registered_estate_id = estate.id.toString();
      const contact: Record<string, unknown> = {};
      for (const [c, f] of [
        ['contact_person_name', 'contact_name'],
        ['contact_person_designation', 'designation'],
        ['contact_person_mobile', 'phone'],
        ['contact_person_email', 'email'],
      ] as const) {
        const v = r.text(c);
        if (v !== '') contact[f] = v;
      }
      body.contact_person = contact;
      if (CONTRACT_COLUMNS.some((c) => r.text(c) !== '')) {
        if (estate?.status !== 'active') r.m.errors.push(err('estate', 'A first contract needs the estate.'));
        const k: Record<string, unknown> = { estate_id: estate?.id.toString() ?? '1' };
        const set = (c: string, f: string, v = r.text(c)) => {
          if (v !== '') k[f] = v;
        };
        set('contract_reference_no', 'reference_number');
        set('work_type', 'work_type', r.text('work_type') ? enumOf(r.text('work_type')) : '');
        set('rate_basis', 'rate_basis', r.text('rate_basis') ? enumOf(r.text('rate_basis')) : '');
        set('rate', 'rate');
        set(
          'contract_start_date',
          'start_date',
          r.text('contract_start_date') ? isoDate(r.text('contract_start_date')) : '',
        );
        set(
          'contract_end_date',
          'end_date',
          r.text('contract_end_date') ? isoDate(r.text('contract_end_date')) : '',
        );
        set('contract_value', 'contract_value');
        set('payment_terms', 'payment_terms', r.text('payment_terms') ? enumOf(r.text('payment_terms')) : '');
        set('work_location', 'work_location', r.text('work_location') ? enumOf(r.text('work_location')) : '');
        body.first_contract = k;
        if (k.rate_basis === 'lump_sum' && k.contract_value === undefined) {
          r.m.errors.push(err('contract_value', 'A lump-sum contract states its value.'));
        }
      }
      const errors = [...r.m.errors];
      const parsed = CreateContractorBody.safeParse(body);
      if (!parsed.success) errors.push(...issuesToErrors(parsed.error.issues, (f) => FIELD[f] ?? f, errors));
      const code = r.text('contractor_id');
      if (code && (await tx.contractor.count({ where: { code } })) > 0)
        errors.push(err('contractor_id', `${code} is already used.`, 'DUPLICATE_KEY'));
      if (errors.length > 0 || !parsed.success) return { ok: false, errors };
      const licence = r.text('trade_licence_no');
      return {
        ok: true,
        value: parsed.data,
        ...(code ? { key: `code:${code}` } : licence ? { key: `licence:${licence}` } : {}),
      };
    },

    async commit(v, tx, actorId) {
      return (await contractors.createIn(tx, v, actorId)).id;
    },
  };
}

/** Registers workforce.worker, workforce.employee and workforce.contractor (P2.06). */
export function registerWorkforceImports(deps: WorkforceImportDeps): void {
  registerImportType(peopleImport('worker', deps));
  registerImportType(peopleImport('employee', deps));
  registerImportType(contractorImport(deps));
}
