import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import {
  auditAction,
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import type { ApprovalAdapter, SubmittedDocument } from '../../core/approval/adapters.js';
import { submitForApproval } from '../../core/approval/engine.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { MasterStatus } from '../../core/http/master.js';
import { dec, sum, toDecimalString } from '../../core/money/decimal.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import {
  addDays,
  businessDateFromDb,
  businessDateToDb,
  diffDays,
  todayIn,
  type BusinessDate,
} from '../../core/time/dates.js';
import type { PartyContact, Prisma } from '../../generated/prisma/client.js';
import { CONTACT_AUDIT, type ContactOwner } from '../facilities/contacts.service.js';
import {
  denyWrite,
  duplicate,
  idIn,
  idOut,
  iso,
  referenced,
  versionConflict,
} from '../organisation/common.js';
import type {
  ContractOut,
  ContractorOut,
  ContractorSummaryOut,
  CreateContractBody,
  CreateContractorBody,
  CreateLabourBody,
  LabourOut,
  PatchContractBody,
  PatchContractorBody,
  PatchLabourBody,
} from './contractor.schema.js';

/**
 * Contractors, their contracts and contractor labour (P2.05; Spec P3 §8.6–§8.8, P1 §5.5.1, P7 §9.5; the
 * manager's design, Add New Contractor and Contractor Management, BACKLOG D-2-4, D-2.05-*).
 *
 *   contractor   an organisation-level master: numbered CON-…, the design's fields, contacts in
 *                party_contact (the primary one cached on the row), documents. Active, inactive or
 *                blacklisted (with a reason). Deleted only before it has a contract.
 *   contract     per estate, approvable: draft → submitted → approved (rejected; returned = draft) and
 *                an approved one may be terminated. Its status for the design is computed from the
 *                state and the dates: pending, upcoming, active, completed, terminated, rejected.
 *   labour       named people under a contract, never an employment profile or a payroll line.
 *
 * Scope: a contractor is seen where it was registered OR has a contract; a contract and its labour by
 * the contract's estate (and division). Writes need that estate (a contractor with no estate: all
 * estates).
 */

type ContractorOutT = z.infer<typeof ContractorOut>;
type ContractOutT = z.infer<typeof ContractOut>;
type LabourOutT = z.infer<typeof LabourOut>;
type ContractBody = z.infer<typeof PatchContractBody>;

export const CONTRACT_DOCUMENT = 'contractor_contract';
const LICENCE_WARNING_DAYS = 30;

export const CONTRACTOR_AUDIT: AuditedRecord = {
  type: 'contractor',
  class: 'master',
  fields: [
    'code',
    'name',
    'short_name',
    'contractor_type',
    'trade_category_id',
    'legal_status',
    'registration_type',
    'contractor_since',
    'description',
    'contact_person',
    'designation',
    'phone',
    'phone_alt',
    'email',
    'address_line1',
    'present_district',
    'present_upazila',
    'present_postal_code',
    'permanent_address',
    'permanent_district',
    'permanent_upazila',
    'permanent_postal_code',
    'national_id',
    'registration_number',
    'trade_licence_number',
    'trade_licence_expiry',
    'bin',
    'tin',
    'vat_registration_number',
    'registration_date',
    'renewal_date',
    'bank_name',
    'bank_branch',
    'bank_account_name',
    'bank_account_number',
    'bank_routing_number',
    'mobile_banking_provider',
    'mobile_banking_number',
    'equipment_owned',
    'years_of_experience',
    'safety_compliance',
    'quality_rating',
    'remarks',
    'emergency_contact_name',
    'emergency_relation',
    'emergency_phone',
    'emergency_phone_alt',
    'emergency_address',
    'registered_estate_id',
    'status',
    'blacklist_reason',
  ],
};
export const CONTRACT_AUDIT: AuditedRecord = {
  type: CONTRACT_DOCUMENT,
  class: 'operational',
  fields: [
    'contractor_id',
    'estate_id',
    'contract_number',
    'reference_number',
    'work_type',
    'rate_basis',
    'rate',
    'start_date',
    'end_date',
    'contract_value',
    'retention_percentage',
    'payment_terms',
    'work_location',
    'division_id',
    'reporting_to_designation_id',
    'terms',
    'state',
    'terminated_on',
    'termination_reason',
    'rejection_reason',
  ],
};
export const LABOUR_AUDIT: AuditedRecord = {
  type: 'contractor_labour',
  class: 'master',
  fields: [
    'contractor_contract_id',
    'labour_code',
    'name',
    'national_id',
    'phone',
    'engaged_from',
    'engaged_to',
    'status',
  ],
};

const id = (v: unknown) => BigInt(String(v));
export const CONTRACTOR_LIST_FIELDS: ListFieldMap = {
  contractor_type: { field: 'contractorType' },
  trade_category_id: { field: 'tradeCategoryId', convert: id },
  status: { field: 'status' },
  registered_estate_id: { field: 'registeredEstateId', convert: id },
  code: { field: 'code' },
  name: { field: 'name' },
  created_at: { field: 'createdAt' },
};
export const CONTRACT_LIST_FIELDS: ListFieldMap = {
  contractor_id: { field: 'contractorId', convert: id },
  estate_id: { field: 'estateId', convert: id },
  division_id: { field: 'divisionId', convert: id },
  state: { field: 'state' },
  work_type: { field: 'workType' },
  rate_basis: { field: 'rateBasis' },
  work_location: { field: 'workLocation' },
  contract_number: { field: 'contractNumber' },
  start_date: { field: 'startDate' },
  end_date: { field: 'endDate' },
  created_at: { field: 'createdAt' },
};

const ref = { select: { id: true, code: true, name: true } } as const;
const user = { select: { id: true, username: true } } as const;
const contractInclude = {
  contractor: ref,
  estate: ref,
  division: ref,
  reportingTo: ref,
  creator: user,
  approver: user,
  _count: { select: { labour: true } },
} as const satisfies Prisma.ContractorContractInclude;
type ContractRow = Prisma.ContractorContractGetPayload<{ include: typeof contractInclude }>;
const contractorInclude = { tradeCategory: ref } as const satisfies Prisma.ContractorInclude;
type ContractorRow = Prisma.ContractorGetPayload<{ include: typeof contractorInclude }>;

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const d = (v: Date | null) => (v ? businessDateFromDb(v) : null);
const toDb = (v: BusinessDate | null | undefined) =>
  v === undefined ? undefined : v === null ? null : businessDateToDb(v);
const refOut = (r: { id: bigint; code: string; name: string } | null) =>
  r ? { id: r.id.toString(), code: r.code, name: r.name } : null;
const money = (v: Prisma.Decimal | null) => (v === null ? null : toDecimalString(v, 'money'));
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);
function pick<T>(v: T | undefined, kept: T): T {
  if (v === undefined) return kept;
  return v;
}

/** The design's contract status, from the state and the dates. */
export function contractStatus(
  c: { state: string; startDate: Date; endDate: Date; terminatedOn: Date | null },
  today: BusinessDate,
): ContractOutT['status'] {
  if (c.state === 'draft' || c.state === 'submitted') return 'pending';
  if (c.state === 'rejected') return 'rejected';
  if (c.state === 'terminated') return 'terminated';
  if (businessDateFromDb(c.endDate) < today) return 'completed';
  if (businessDateFromDb(c.startDate) > today) return 'upcoming';
  return 'active';
}
/** Approved, started, not ended, not terminated: the contracts the list and the figures count. */
export function contractInForce(date: BusinessDate): Prisma.ContractorContractWhereInput {
  const day = businessDateToDb(date);
  return { state: 'approved', startDate: { lte: day }, endDate: { gte: day } };
}
/** Whole months from the start to the end (inclusive), a part month counting as one: 1 Jan – 31 Dec is 12. */
export function monthsBetween(from: BusinessDate, to: BusinessDate): number {
  const after = addDays(to, 1);
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = after.split('-').map(Number) as [number, number, number];
  const whole = (ty - fy) * 12 + (tm - fm) - (td < fd ? 1 : 0);
  return Math.max(1, whole + (td === fd ? 0 : 1));
}

export interface ContractorServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function contractorService({ db, accessLog, timezone }: ContractorServiceDeps) {
  const today = () => todayIn(timezone);
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  // ---- write scope ---------------------------------------------------------------------------------------
  async function canChangeContractor(
    c: { id: bigint | null; registeredEstateId: bigint | null },
    operation: string,
  ) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return;
    const estates: (bigint | null)[] = [c.registeredEstateId];
    if (c.id !== null) {
      const rows = await db.contractorContract.findMany({
        where: { contractorId: c.id },
        select: { estateId: true },
      });
      estates.push(...rows.map((r) => r.estateId));
    }
    if (!estates.some((e) => e !== null && scope.estates.includes(e)))
      await denyWrite(accessLog, 'contractor', c.id, operation);
  }
  async function canChangeEstate(estateId: bigint, recordId: bigint | null, operation: string) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates || scope.estates.includes(estateId)) return;
    await denyWrite(accessLog, 'contractor', recordId, operation);
  }

  // ---- contractors -----------------------------------------------------------------------------------------
  /** Per contractor: the contract shown in the list (in force today, else the latest) and its workers. */
  async function contractFacts(tx: Database | Tx, ids: readonly bigint[]) {
    const t = today();
    const rows =
      ids.length === 0
        ? []
        : await tx.contractorContract.findMany({
            where: { contractorId: { in: [...ids] } },
            include: contractInclude,
            orderBy: [{ startDate: 'desc' }, { id: 'desc' }],
          });
    const current = new Map<bigint, ContractRow>();
    for (const r of rows) {
      const shown = current.get(r.contractorId);
      const inForce = (c: ContractRow) => contractStatus(c, t) === 'active';
      if (!shown || (!inForce(shown) && inForce(r))) current.set(r.contractorId, r);
    }
    const live = rows.filter((r) => contractStatus(r, t) === 'active').map((r) => r.id);
    const workers =
      live.length === 0
        ? []
        : await tx.contractorLabour.groupBy({
            by: ['contractorContractId'],
            where: { contractorContractId: { in: live }, status: 'active' },
            _count: { _all: true },
          });
    const byContract = new Map(workers.map((w) => [w.contractorContractId, w._count._all]));
    const count = new Map<bigint, number>();
    for (const r of rows)
      count.set(r.contractorId, (count.get(r.contractorId) ?? 0) + (byContract.get(r.id) ?? 0));
    return { current, count };
  }

  function toContractorOut(
    c: ContractorRow,
    current: ContractRow | undefined,
    workers: number,
  ): ContractorOutT {
    const t = today();
    const expiry = d(c.tradeLicenceExpiry);
    return {
      id: c.id.toString(),
      code: c.code,
      name: c.name,
      short_name: c.shortName,
      contractor_type: c.contractorType as ContractorOutT['contractor_type'],
      trade_category_id: idOut(c.tradeCategoryId),
      trade_category: refOut(c.tradeCategory),
      legal_status: c.legalStatus as ContractorOutT['legal_status'],
      registration_type: c.registrationType,
      contractor_since: d(c.contractorSince),
      description: c.description,
      contact_person: c.contactPerson,
      designation: c.designation,
      phone: c.phone,
      phone_alt: c.phoneAlt,
      email: c.email,
      address_line1: c.addressLine1,
      present_district: c.presentDistrict,
      present_upazila: c.presentUpazila,
      present_postal_code: c.presentPostalCode,
      permanent_address: c.permanentAddress,
      permanent_district: c.permanentDistrict,
      permanent_upazila: c.permanentUpazila,
      permanent_postal_code: c.permanentPostalCode,
      national_id: c.nationalId,
      registration_number: c.registrationNumber,
      trade_licence_number: c.tradeLicenceNumber,
      trade_licence_expiry: expiry,
      licence_expiring: expiry !== null && expiry <= addDays(t, LICENCE_WARNING_DAYS),
      bin: c.bin,
      tin: c.tin,
      vat_registration_number: c.vatRegistrationNumber,
      registration_date: d(c.registrationDate),
      renewal_date: d(c.renewalDate),
      bank_name: c.bankName,
      bank_branch: c.bankBranch,
      bank_account_name: c.bankAccountName,
      bank_account_number: c.bankAccountNumber,
      bank_routing_number: c.bankRoutingNumber,
      mobile_banking_provider: c.mobileBankingProvider as ContractorOutT['mobile_banking_provider'],
      mobile_banking_number: c.mobileBankingNumber,
      equipment_owned: c.equipmentOwned,
      years_of_experience: c.yearsOfExperience,
      safety_compliance: c.safetyCompliance as ContractorOutT['safety_compliance'],
      quality_rating: c.qualityRating as ContractorOutT['quality_rating'],
      remarks: c.remarks,
      emergency_contact_name: c.emergencyContactName,
      emergency_relation: c.emergencyRelation as ContractorOutT['emergency_relation'],
      emergency_phone: c.emergencyPhone,
      emergency_phone_alt: c.emergencyPhoneAlt,
      emergency_address: c.emergencyAddress,
      registered_estate_id: idOut(c.registeredEstateId),
      current_contract: current
        ? {
            id: current.id.toString(),
            contract_number: current.contractNumber,
            estate: {
              id: current.estate.id.toString(),
              code: current.estate.code,
              name: current.estate.name,
            },
            work_type: current.workType as ContractOutT['work_type'],
            start_date: businessDateFromDb(current.startDate),
            end_date: businessDateFromDb(current.endDate),
            contract_value: money(current.contractValue),
            work_location: current.workLocation as ContractOutT['work_location'],
            division: refOut(current.division),
            status: contractStatus(current, t),
          }
        : null,
      number_of_workers: workers,
      status: c.status as ContractorOutT['status'],
      blacklist_reason: c.blacklistReason,
      version: c.version,
      created_at: c.createdAt.toISOString(),
      updated_at: iso(c.updatedAt),
    };
  }
  async function contractorOut(tx: Database | Tx, c: ContractorRow) {
    const { current, count } = await contractFacts(tx, [c.id]);
    return toContractorOut(c, current.get(c.id), count.get(c.id) ?? 0);
  }
  async function contractorOrNotFound(tx: Database | Tx, cid: bigint): Promise<ContractorRow> {
    const c = await tx.contractor.findUnique({ where: { id: cid }, include: contractorInclude });
    if (!c) throw Errors.notFound('Contractor not found.');
    return c;
  }

  const contractorData = (b: z.infer<typeof PatchContractorBody>) => {
    const out: Record<string, unknown> = {};
    const set = (k: string, v: unknown) => {
      if (v !== undefined) out[k] = v;
    };
    set('code', b.code);
    set('name', b.name);
    set('shortName', b.short_name);
    set('contractorType', b.contractor_type);
    set('tradeCategoryId', b.trade_category_id === undefined ? undefined : idIn(b.trade_category_id));
    set('legalStatus', b.legal_status);
    set('registrationType', b.registration_type);
    set('contractorSince', toDb(b.contractor_since));
    set('description', b.description);
    set('phone', b.phone);
    set('phoneAlt', b.phone_alt);
    set('email', b.email);
    set('addressLine1', b.address_line1);
    set('presentDistrict', b.present_district);
    set('presentUpazila', b.present_upazila);
    set('presentPostalCode', b.present_postal_code);
    set('permanentAddress', b.permanent_address);
    set('permanentDistrict', b.permanent_district);
    set('permanentUpazila', b.permanent_upazila);
    set('permanentPostalCode', b.permanent_postal_code);
    set('nationalId', b.national_id);
    set('registrationNumber', b.registration_number);
    set('tradeLicenceNumber', b.trade_licence_number);
    set('tradeLicenceExpiry', toDb(b.trade_licence_expiry));
    set('bin', b.bin);
    set('tin', b.tin);
    set('vatRegistrationNumber', b.vat_registration_number);
    set('registrationDate', toDb(b.registration_date));
    set('renewalDate', toDb(b.renewal_date));
    set('bankName', b.bank_name);
    set('bankBranch', b.bank_branch);
    set('bankAccountName', b.bank_account_name);
    set('bankAccountNumber', b.bank_account_number);
    set('bankRoutingNumber', b.bank_routing_number);
    set('mobileBankingProvider', b.mobile_banking_provider);
    set('mobileBankingNumber', b.mobile_banking_number);
    set('equipmentOwned', b.equipment_owned);
    set('yearsOfExperience', b.years_of_experience);
    set('safetyCompliance', b.safety_compliance);
    set('qualityRating', b.quality_rating);
    set('remarks', b.remarks);
    set('emergencyContactName', b.emergency_contact_name);
    set('emergencyRelation', b.emergency_relation);
    set('emergencyPhone', b.emergency_phone);
    set('emergencyPhoneAlt', b.emergency_phone_alt);
    set('emergencyAddress', b.emergency_address);
    return out as Prisma.ContractorUncheckedUpdateInput;
  };

  async function checkContractor(
    tx: Database | Tx,
    b: z.infer<typeof PatchContractorBody>,
    cur?: ContractorRow,
  ) {
    const problems: ErrorDetail[] = [];
    if (b.trade_category_id !== undefined && b.trade_category_id !== cur?.tradeCategoryId) {
      const t = await tx.tradeCategory.findUnique({
        where: { id: b.trade_category_id },
        select: { status: true },
      });
      if (t?.status !== 'active')
        problems.push(invalid('trade_category_id', 'No such active trade category.'));
    }
    const provider =
      b.mobile_banking_provider !== undefined ? b.mobile_banking_provider : cur?.mobileBankingProvider;
    const number = b.mobile_banking_number !== undefined ? b.mobile_banking_number : cur?.mobileBankingNumber;
    if ((provider ?? null) !== null && (number ?? null) === null) {
      problems.push(invalid('mobile_banking_number', 'A mobile-banking provider needs the account number.'));
    }
    const since = b.contractor_since !== undefined ? b.contractor_since : d(cur?.contractorSince ?? null);
    if (since && since > today()) problems.push(invalid('contractor_since', 'Cannot be in the future.'));
    const reg = b.registration_date !== undefined ? b.registration_date : d(cur?.registrationDate ?? null);
    const renewal = b.renewal_date !== undefined ? b.renewal_date : d(cur?.renewalDate ?? null);
    if (reg && renewal && renewal < reg)
      problems.push(invalid('renewal_date', 'Cannot be before the registration date.'));
    if (problems.length > 0) throw Errors.validation(problems);
  }

  /** The contact owner for /contractors/{id}/contacts: the primary contact is cached on the row. */
  const contactOwner: ContactOwner = {
    type: 'contractor',
    module: 'contractor',
    exists: async (tx, cid) => (await tx.contractor.count({ where: { id: cid } })) === 1,
    syncPrimary: async (tx, ownerId, primary: PartyContact | null) => {
      await tx.contractor.update({
        where: { id: ownerId },
        data: { contactPerson: primary?.contactName ?? null, designation: primary?.designation ?? null },
      });
    },
  };

  // ---- contracts -------------------------------------------------------------------------------------------
  async function approvalIds(tx: Database | Tx, ids: readonly bigint[]) {
    if (ids.length === 0) return new Map<bigint, bigint>();
    const rows = await tx.approvalRequest.findMany({
      where: { documentType: CONTRACT_DOCUMENT, documentId: { in: [...ids] }, state: 'pending' },
      select: { id: true, documentId: true },
    });
    return new Map(rows.map((r) => [r.documentId, r.id]));
  }
  function toContractOut(c: ContractRow, approvalId: bigint | null): ContractOutT {
    const t = today();
    const start = businessDateFromDb(c.startDate);
    const end = businessDateFromDb(c.endDate);
    return {
      id: c.id.toString(),
      contractor_id: c.contractorId.toString(),
      contractor: { id: c.contractor.id.toString(), code: c.contractor.code, name: c.contractor.name },
      estate_id: c.estateId.toString(),
      estate: { id: c.estate.id.toString(), code: c.estate.code, name: c.estate.name },
      contract_number: c.contractNumber,
      reference_number: c.referenceNumber,
      work_type: c.workType as ContractOutT['work_type'],
      rate_basis: c.rateBasis as ContractOutT['rate_basis'],
      rate: toDecimalString(c.rate, 'money'),
      start_date: start,
      end_date: end,
      duration_months: monthsBetween(start, end),
      days_left: diffDays(t, end),
      contract_value: money(c.contractValue),
      retention_percentage:
        c.retentionPercentage === null ? null : toDecimalString(c.retentionPercentage, 'pct'),
      payment_terms: c.paymentTerms as ContractOutT['payment_terms'],
      work_location: c.workLocation as ContractOutT['work_location'],
      division_id: idOut(c.divisionId),
      division: refOut(c.division),
      reporting_to_designation_id: idOut(c.reportingToDesignationId),
      reporting_to: refOut(c.reportingTo),
      terms: c.terms,
      state: c.state as ContractOutT['state'],
      status: contractStatus(c, t),
      approval_id: idOut(approvalId),
      labour_count: c._count.labour,
      terminated_on: d(c.terminatedOn),
      termination_reason: c.terminationReason,
      submitted_at: iso(c.submittedAt),
      approved_at: iso(c.approvedAt),
      approved_by: c.approver ? { id: c.approver.id.toString(), username: c.approver.username } : null,
      rejected_at: iso(c.rejectedAt),
      rejection_reason: c.rejectionReason,
      created_by: { id: c.creator.id.toString(), username: c.creator.username },
      version: c.version,
      created_at: c.createdAt.toISOString(),
      updated_at: iso(c.updatedAt),
    };
  }
  async function contractOut(tx: Database | Tx, c: ContractRow) {
    const pending = c.state === 'submitted' ? await approvalIds(tx, [c.id]) : new Map<bigint, bigint>();
    return toContractOut(c, pending.get(c.id) ?? null);
  }
  async function contractOrNotFound(tx: Database | Tx, cid: bigint): Promise<ContractRow> {
    const c = await tx.contractorContract.findUnique({ where: { id: cid }, include: contractInclude });
    if (!c) throw Errors.notFound('Contract not found.');
    return c;
  }

  interface ContractTerms {
    estateId: bigint;
    referenceNumber: string | null;
    workType: string;
    rateBasis: string;
    rate: string;
    startDate: BusinessDate;
    endDate: BusinessDate;
    contractValue: string | null;
    retentionPercentage: string | null;
    paymentTerms: string | null;
    workLocation: string | null;
    divisionId: bigint | null;
    reportingToDesignationId: bigint | null;
    terms: string | null;
  }
  const termsOf = (c: ContractRow): ContractTerms => ({
    estateId: c.estateId,
    referenceNumber: c.referenceNumber,
    workType: c.workType,
    rateBasis: c.rateBasis,
    rate: c.rate.toString(),
    startDate: businessDateFromDb(c.startDate),
    endDate: businessDateFromDb(c.endDate),
    contractValue: c.contractValue?.toString() ?? null,
    retentionPercentage: c.retentionPercentage?.toString() ?? null,
    paymentTerms: c.paymentTerms,
    workLocation: c.workLocation,
    divisionId: c.divisionId,
    reportingToDesignationId: c.reportingToDesignationId,
    terms: c.terms,
  });
  const mergeTerms = (base: ContractTerms, b: ContractBody): ContractTerms => ({
    estateId: b.estate_id ?? base.estateId,
    referenceNumber: pick(b.reference_number, base.referenceNumber),
    workType: b.work_type ?? base.workType,
    rateBasis: b.rate_basis ?? base.rateBasis,
    rate: b.rate === undefined ? base.rate : b.rate.toString(),
    startDate: b.start_date ?? base.startDate,
    endDate: b.end_date ?? base.endDate,
    contractValue:
      b.contract_value === undefined ? base.contractValue : (b.contract_value?.toString() ?? null),
    retentionPercentage:
      b.retention_percentage === undefined
        ? base.retentionPercentage
        : (b.retention_percentage?.toString() ?? null),
    paymentTerms: pick(b.payment_terms, base.paymentTerms),
    workLocation: pick(b.work_location, base.workLocation),
    divisionId: b.division_id === undefined ? base.divisionId : idIn(b.division_id),
    reportingToDesignationId:
      b.reporting_to_designation_id === undefined
        ? base.reportingToDesignationId
        : idIn(b.reporting_to_designation_id),
    terms: pick(b.terms, base.terms),
  });
  async function checkContract(tx: Database | Tx, t: ContractTerms, prefix = '') {
    const f = (x: string) => `${prefix}${x}`;
    const problems: ErrorDetail[] = [];
    const estate = await tx.estate.findUnique({ where: { id: t.estateId }, select: { status: true } });
    if (estate?.status !== 'active') problems.push(invalid(f('estate_id'), 'No such active estate.'));
    if (t.endDate < t.startDate) problems.push(invalid(f('end_date'), 'Cannot be before the start date.'));
    if (t.rateBasis === 'lump_sum' && t.contractValue === null) {
      problems.push(invalid(f('contract_value'), 'A lump-sum contract states its value.'));
    }
    if (t.divisionId !== null) {
      const v = await tx.division.findUnique({
        where: { id: t.divisionId },
        select: { estateId: true, status: true },
      });
      if (v?.estateId !== t.estateId || v.status !== 'active')
        problems.push(invalid(f('division_id'), 'No such active division in the contract’s estate.'));
    }
    if (t.reportingToDesignationId !== null) {
      const g = await tx.designation.findUnique({
        where: { id: t.reportingToDesignationId },
        select: { status: true },
      });
      if (g?.status !== 'active')
        problems.push(invalid(f('reporting_to_designation_id'), 'No such active designation.'));
    }
    if (problems.length > 0) throw Errors.validation(problems);
  }
  const contractColumns = (t: ContractTerms) => ({
    estateId: t.estateId,
    referenceNumber: t.referenceNumber,
    workType: t.workType,
    rateBasis: t.rateBasis,
    rate: t.rate,
    startDate: businessDateToDb(t.startDate),
    endDate: businessDateToDb(t.endDate),
    contractValue: t.contractValue,
    retentionPercentage: t.retentionPercentage,
    paymentTerms: t.paymentTerms,
    workLocation: t.workLocation,
    divisionId: t.divisionId,
    reportingToDesignationId: t.reportingToDesignationId,
    terms: t.terms,
  });
  const blank = (
    b:
      | z.infer<typeof CreateContractBody>
      | NonNullable<z.infer<typeof CreateContractorBody>['first_contract']>,
  ): ContractTerms =>
    mergeTerms(
      {
        estateId: b.estate_id,
        referenceNumber: null,
        workType: b.work_type,
        rateBasis: b.rate_basis,
        rate: b.rate.toString(),
        startDate: b.start_date,
        endDate: b.end_date,
        contractValue: null,
        retentionPercentage: null,
        paymentTerms: null,
        workLocation: null,
        divisionId: null,
        reportingToDesignationId: null,
        terms: null,
      },
      b,
    );

  /** Creates a draft contract (inside the caller's transaction): numbered per estate and year. */
  async function insertContract(
    tx: Tx,
    contractorId: bigint,
    t: ContractTerms,
    actorId: bigint,
    prefix = '',
  ) {
    await canChangeEstate(t.estateId, null, 'create-contract');
    await checkContract(tx, t, prefix);
    const estate = await tx.estate.findUniqueOrThrow({ where: { id: t.estateId }, select: { code: true } });
    const { number } = await allocateNumber(
      tx,
      CONTRACT_DOCUMENT,
      { date: today(), estateCode: estate.code },
      'draft',
    );
    const { id: cid } = await tx.contractorContract.create({
      data: {
        ...contractColumns(t),
        contractorId,
        contractNumber: number,
        state: 'draft',
        stateChangedAt: new Date(),
        createdBy: actorId,
      },
      select: { id: true },
    });
    const out = await contractOut(tx, await contractOrNotFound(tx, cid));
    await auditCreate(tx, CONTRACT_AUDIT, cid, out, { actorId });
    await recordStatusChange(tx, CONTRACT_AUDIT.type, cid, null, 'draft', { actorId });
    return out;
  }
  const notUsable = (c: { status: string }) => {
    if (c.status !== 'active') {
      throw transition(
        `A ${c.status} contractor takes no new contract.`,
        c.status,
        c.status === 'blacklisted' ? 'Blacklisted contractors cannot be engaged.' : 'Reactivate it first.',
      );
    }
  };

  const adapter: ApprovalAdapter = {
    documentType: CONTRACT_DOCUMENT,
    async describe(tx, cid): Promise<SubmittedDocument> {
      const c = await contractOrNotFound(tx, cid);
      const start = businessDateFromDb(c.startDate);
      const end = businessDateFromDb(c.endDate);
      const value = c.contractValue === null ? null : toDecimalString(c.contractValue, 'money');
      return {
        id: cid,
        number: c.contractNumber,
        label: `${c.contractNumber} · ${c.contractor.name}`,
        createdBy: c.createdBy,
        estateId: c.estateId,
        values: {
          estate_id: c.estateId.toString(),
          contract_value: value,
          term_months: String(monthsBetween(start, end)),
        },
        amount: c.contractValue === null ? null : c.contractValue.toFixed(2),
      };
    },
    async onApproved(tx, cid, ctx) {
      await lockRowsForUpdate(tx, 'contractor_contract', { id: cid });
      const c = await contractOrNotFound(tx, cid);
      if (c.state !== 'submitted')
        throw transition(`A ${c.state} contract cannot be approved.`, c.state, 'Reload it.');
      const contractor = await tx.contractor.findUniqueOrThrow({
        where: { id: c.contractorId },
        select: { status: true },
      });
      if (contractor.status === 'blacklisted') {
        throw transition(
          'The contractor was blacklisted meanwhile.',
          contractor.status,
          'Reject this contract.',
        );
      }
      const now = new Date();
      await tx.contractorContract.update({
        where: { id: cid },
        data: {
          state: 'approved',
          stateChangedAt: now,
          approvedAt: now,
          approvedBy: ctx.actorId,
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, CONTRACT_AUDIT, cid, 'approve', {
        actorId: ctx.actorId,
        actingForUserId: ctx.actingForUserId,
      });
      await recordStatusChange(tx, CONTRACT_AUDIT.type, cid, 'submitted', 'approved', {
        actorId: ctx.actorId,
      });
    },
    async onRejected(tx, cid, ctx) {
      const now = new Date();
      await tx.contractorContract.update({
        where: { id: cid },
        data: {
          state: 'rejected',
          stateChangedAt: now,
          rejectedAt: now,
          rejectedBy: ctx.actorId,
          rejectionReason: ctx.reason.slice(0, 500),
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, CONTRACT_AUDIT, cid, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
      await recordStatusChange(tx, CONTRACT_AUDIT.type, cid, 'submitted', 'rejected', {
        actorId: ctx.actorId,
        comment: ctx.reason,
      });
    },
    async onReturned(tx, cid, ctx) {
      await tx.contractorContract.update({
        where: { id: cid },
        data: {
          state: 'draft',
          stateChangedAt: new Date(),
          submittedAt: null,
          submittedBy: null,
          ...stamp(ctx.actorId),
        },
      });
      await recordStatusChange(tx, CONTRACT_AUDIT.type, cid, 'submitted', 'draft', {
        actorId: ctx.actorId,
        comment: ctx.comment,
      });
    },
  };

  // ---- labour -----------------------------------------------------------------------------------------------
  function toLabourOut(l: Prisma.ContractorLabourGetPayload<object>): LabourOutT {
    return {
      id: l.id.toString(),
      contractor_contract_id: l.contractorContractId.toString(),
      labour_code: l.labourCode,
      name: l.name,
      national_id: l.nationalId,
      phone: l.phone,
      engaged_from: d(l.engagedFrom),
      engaged_to: d(l.engagedTo),
      status: l.status as LabourOutT['status'],
      version: l.version,
      created_at: l.createdAt.toISOString(),
    };
  }
  function checkEngagement(c: ContractRow, from: BusinessDate | null, to: BusinessDate | null) {
    const start = businessDateFromDb(c.startDate);
    const end = businessDateFromDb(c.endDate);
    const problems: ErrorDetail[] = [];
    if (from && (from < start || from > end))
      problems.push(invalid('engaged_from', `Within the contract, ${start} to ${end}.`));
    if (to && (to < start || to > end))
      problems.push(invalid('engaged_to', `Within the contract, ${start} to ${end}.`));
    if (from && to && to < from) problems.push(invalid('engaged_to', 'Cannot be before engaged_from.'));
    if (problems.length > 0) throw Errors.validation(problems);
  }
  const labourOpen = (c: ContractRow) => {
    if (c.state === 'rejected' || c.state === 'terminated') {
      throw transition(
        `A ${c.state} contract takes no labour.`,
        c.state,
        'Only a current or pending contract.',
      );
    }
  };

  return {
    adapter,
    contactOwner,

    // ================= contractors =================
    async list(q: ListQuery) {
      const search = q.filters.find((f) => f.field === 'q');
      const location = q.filters.filter(
        (f) => f.field === 'division_id' || f.field === 'work_location' || f.field === 'estate_id',
      );
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== 'q' && !location.includes(f)) };
      const and: Prisma.ContractorWhereInput[] = [toWhere(rest, CONTRACTOR_LIST_FIELDS)];
      if (search) {
        const term = String(search.value);
        and.push({
          OR: [
            { code: { startsWith: term } },
            { name: { contains: term } },
            { shortName: { contains: term } },
            { phone: { contains: term } },
          ],
        });
      }
      // The design's Location filter: where its contracts are (estate, division, work location).
      for (const f of location) {
        const values = Array.isArray(f.value) ? f.value : [f.value];
        const column =
          f.field === 'division_id' ? 'divisionId' : f.field === 'estate_id' ? 'estateId' : 'workLocation';
        const v = f.field === 'work_location' ? values.map(String) : values.map((x) => BigInt(String(x)));
        and.push({ contracts: { some: { [column]: { in: v } } } });
      }
      const where = { AND: and };
      const [rows, total] = await Promise.all([
        db.contractor.findMany({
          where,
          include: contractorInclude,
          orderBy: [...toOrderBy(q.sort, CONTRACTOR_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.contractor.count({ where }),
      ]);
      const { current, count } = await contractFacts(
        db,
        rows.map((r) => r.id),
      );
      return { items: rows.map((r) => toContractorOut(r, current.get(r.id), count.get(r.id) ?? 0)), total };
    },

    async get(cid: bigint) {
      return contractorOut(db, await contractorOrNotFound(db, cid));
    },

    async create(b: z.infer<typeof CreateContractorBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const registered =
          b.registered_estate_id !== undefined
            ? idIn(b.registered_estate_id)
            : (b.first_contract?.estate_id ?? null);
        await canChangeContractor({ id: null, registeredEstateId: registered }, 'create');
        await checkContractor(tx, b);
        const code = b.code ?? (await allocateNumber(tx, 'contractor', { date: today() }, 'draft')).number;
        const { id: cid } = await tx.contractor
          .create({
            data: {
              ...(contractorData(b) as Prisma.ContractorUncheckedCreateInput),
              code,
              name: b.name,
              contractorType: b.contractor_type,
              registeredEstateId: registered,
              contactPerson: b.contact_person.contact_name,
              designation: b.contact_person.designation ?? null,
              status: 'active',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Contractor ID ${code}`));
        const contact = await tx.partyContact.create({
          data: {
            ownerType: 'contractor',
            ownerId: cid,
            contactName: b.contact_person.contact_name,
            designation: b.contact_person.designation ?? null,
            contactType: 'primary',
            phone: b.contact_person.phone,
            email: b.contact_person.email ?? null,
            isPrimary: true,
            createdBy: actorId,
          },
        });
        await auditCreate(
          tx,
          CONTACT_AUDIT,
          contact.id,
          {
            owner_type: 'contractor',
            owner_id: cid.toString(),
            contact_name: contact.contactName,
            is_primary: true,
          },
          { actorId },
        );
        if (b.first_contract)
          await insertContract(tx, cid, blank(b.first_contract), actorId, 'first_contract.');
        const out = await contractorOut(tx, await contractorOrNotFound(tx, cid));
        await auditCreate(tx, CONTRACTOR_AUDIT, cid, out, { actorId });
        await recordStatusChange(tx, CONTRACTOR_AUDIT.type, cid, null, 'active', { actorId });
        return out;
      });
    },

    async update(
      cid: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchContractorBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await contractorOrNotFound(tx, cid);
        await canChangeContractor(before, 'update');
        await checkContractor(tx, changes, before);
        const { count } = await tx.contractor
          .updateMany({
            where: { id: cid, version: expectedVersion },
            data: { ...contractorData(changes), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Contractor ID ${changes.code ?? ''}`));
        const old = await contractorOut(tx, before);
        if (count !== 1) versionConflict(before, old);
        const after = await contractorOut(tx, await contractorOrNotFound(tx, cid));
        await auditUpdate(tx, CONTRACTOR_AUDIT, cid, old, after, { actorId });
        return after;
      });
    },

    async setStatus(
      cid: bigint,
      expectedVersion: number,
      status: MasterStatus | 'blacklisted',
      actorId: bigint,
      reason: string | null = null,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await contractorOrNotFound(tx, cid);
        await canChangeContractor(
          before,
          status === 'blacklisted' ? 'blacklist' : status === 'active' ? 'reactivate' : 'deactivate',
        );
        const old = await contractorOut(tx, before);
        if (before.version !== expectedVersion) versionConflict(before, old);
        if (before.status === status) return old;
        await tx.contractor.update({
          where: { id: cid },
          data: { status, blacklistReason: status === 'blacklisted' ? reason : null, ...stamp(actorId) },
        });
        const after = await contractorOut(tx, await contractorOrNotFound(tx, cid));
        await auditUpdate(tx, CONTRACTOR_AUDIT, cid, old, after, { actorId, reason });
        await recordStatusChange(tx, CONTRACTOR_AUDIT.type, cid, before.status, status, {
          actorId,
          comment: reason,
        });
        return after;
      });
    },

    /** Only a contractor registered in error: no contract. Its contacts go with it. */
    async remove(cid: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const c = await contractorOrNotFound(tx, cid);
        await canChangeContractor(c, 'delete');
        const out = await contractorOut(tx, c);
        if ((await tx.contractorContract.count({ where: { contractorId: cid } })) > 0) {
          throw new AppError('REFERENCED_RECORD', 'This contractor has contracts, so it cannot be deleted.', [
            { code: 'REFERENCED_RECORD', message: 'Deactivate it instead.' },
          ]);
        }
        await tx.partyContact.deleteMany({ where: { ownerType: 'contractor', ownerId: cid } });
        await tx.contractor.delete({ where: { id: cid } }).catch(referenced('contractor'));
        await auditDelete(tx, CONTRACTOR_AUDIT, cid, out, { actorId });
      });
    },

    // ================= contracts =================
    contracts: {
      async list(q: ListQuery) {
        const expiring = q.filters.find((f) => f.field === 'expiring_within_days');
        const status = q.filters.find((f) => f.field === 'status');
        const rest = { ...q, filters: q.filters.filter((f) => f !== expiring && f !== status) };
        const and: Prisma.ContractorContractWhereInput[] = [toWhere(rest, CONTRACT_LIST_FIELDS)];
        const t = today();
        if (expiring) {
          and.push({
            ...contractInForce(t),
            endDate: { gte: businessDateToDb(t), lte: businessDateToDb(addDays(t, Number(expiring.value))) },
          });
        }
        if (status) {
          const day = businessDateToDb(t);
          const want = (Array.isArray(status.value) ? status.value : [status.value]).map(String);
          const map: Record<string, Prisma.ContractorContractWhereInput> = {
            pending: { state: { in: ['draft', 'submitted'] } },
            rejected: { state: 'rejected' },
            terminated: { state: 'terminated' },
            completed: { state: 'approved', endDate: { lt: day } },
            upcoming: { state: 'approved', startDate: { gt: day } },
            active: contractInForce(t),
          };
          and.push({ OR: want.map((w) => map[w] ?? {}) });
        }
        const where = { AND: and };
        const [rows, total] = await Promise.all([
          db.contractorContract.findMany({
            where,
            include: contractInclude,
            orderBy: [...toOrderBy(q.sort, CONTRACT_LIST_FIELDS), { id: 'desc' }],
            ...toPaging(q),
          }),
          db.contractorContract.count({ where }),
        ]);
        const pending = await approvalIds(
          db,
          rows.filter((r) => r.state === 'submitted').map((r) => r.id),
        );
        return { items: rows.map((r) => toContractOut(r, pending.get(r.id) ?? null)), total };
      },

      async get(cid: bigint) {
        return contractOut(db, await contractOrNotFound(db, cid));
      },

      async create(b: z.infer<typeof CreateContractBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const contractor = await contractorOrNotFound(tx, b.contractor_id).catch(() => {
            throw Errors.validation([invalid('contractor_id', 'No such contractor.')]);
          });
          notUsable(contractor);
          return insertContract(tx, contractor.id, blank(b), actorId);
        });
      },

      async update(cid: bigint, expectedVersion: number, changes: ContractBody, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const before = await contractOrNotFound(tx, cid);
          await canChangeEstate(before.estateId, cid, 'update-contract');
          if (before.state !== 'draft')
            throw transition(
              `A ${before.state} contract cannot be changed.`,
              before.state,
              'Only a draft is edited.',
            );
          const t = mergeTerms(termsOf(before), changes);
          if (t.estateId !== before.estateId) await canChangeEstate(t.estateId, cid, 'update-contract');
          await checkContract(tx, t);
          const { count } = await tx.contractorContract.updateMany({
            where: { id: cid, version: expectedVersion },
            data: { ...contractColumns(t), ...stamp(actorId) },
          });
          const old = await contractOut(tx, before);
          if (count !== 1) versionConflict(before, old);
          const after = await contractOut(tx, await contractOrNotFound(tx, cid));
          await auditUpdate(tx, CONTRACT_AUDIT, cid, old, after, { actorId });
          return after;
        });
      },

      async remove(cid: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const c = await contractOrNotFound(tx, cid);
          await canChangeEstate(c.estateId, cid, 'delete-contract');
          if (c.state !== 'draft')
            throw transition(`A ${c.state} contract cannot be deleted.`, c.state, 'Only a draft is deleted.');
          const out = await contractOut(tx, c);
          await tx.contractorLabour.deleteMany({ where: { contractorContractId: cid } });
          await tx.contractorContract.delete({ where: { id: cid } });
          await auditDelete(tx, CONTRACT_AUDIT, cid, out, { actorId });
        });
      },

      /** Routed through the contractor_contract workflow (P7 §9.5); no workflow → approved at once. */
      async submit(cid: bigint, expectedVersion: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'contractor_contract', { id: cid });
          const c = await contractOrNotFound(tx, cid);
          await canChangeEstate(c.estateId, cid, 'submit-contract');
          if (c.version !== expectedVersion) versionConflict(c, await contractOut(tx, c));
          if (c.state !== 'draft')
            throw transition(
              `A ${c.state} contract cannot be submitted.`,
              c.state,
              'Only a draft is submitted.',
            );
          notUsable(
            await tx.contractor.findUniqueOrThrow({
              where: { id: c.contractorId },
              select: { status: true },
            }),
          );
          await checkContract(tx, termsOf(c));
          const now = new Date();
          await tx.contractorContract.update({
            where: { id: cid },
            data: {
              state: 'submitted',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: actorId,
              ...stamp(actorId),
            },
          });
          await recordStatusChange(tx, CONTRACT_AUDIT.type, cid, 'draft', 'submitted', { actorId });
          await submitForApproval(tx, { timezone }, CONTRACT_DOCUMENT, cid, { actorId, date: today() });
          return contractOut(tx, await contractOrNotFound(tx, cid));
        });
      },

      /** An approved contract ended early: the last day of work and why. Its labour is ended with it. */
      async terminate(
        cid: bigint,
        expectedVersion: number,
        on: BusinessDate,
        reason: string,
        actorId: bigint,
      ) {
        return withTransaction(db, async (tx) => {
          const c = await contractOrNotFound(tx, cid);
          await canChangeEstate(c.estateId, cid, 'terminate-contract');
          const old = await contractOut(tx, c);
          if (c.version !== expectedVersion) versionConflict(c, old);
          if (c.state !== 'approved')
            throw transition(
              `A ${c.state} contract cannot be terminated.`,
              c.state,
              'Only an approved contract.',
            );
          const start = businessDateFromDb(c.startDate);
          const end = businessDateFromDb(c.endDate);
          if (on < start || on > end)
            throw Errors.validation([invalid('terminated_on', `Within the contract, ${start} to ${end}.`)]);
          const now = new Date();
          const day = businessDateToDb(on);
          await tx.contractorContract.update({
            where: { id: cid },
            data: {
              state: 'terminated',
              stateChangedAt: now,
              terminatedOn: day,
              terminatedAt: now,
              terminatedBy: actorId,
              terminationReason: reason,
              ...stamp(actorId),
            },
          });
          await tx.contractorLabour.updateMany({
            where: { contractorContractId: cid, OR: [{ engagedTo: null }, { engagedTo: { gt: day } }] },
            data: { engagedTo: day, ...stamp(actorId) },
          });
          const after = await contractOut(tx, await contractOrNotFound(tx, cid));
          await auditUpdate(tx, CONTRACT_AUDIT, cid, old, after, { actorId, reason });
          await recordStatusChange(tx, CONTRACT_AUDIT.type, cid, 'approved', 'terminated', {
            actorId,
            comment: reason,
          });
          return after;
        });
      },
    },

    // ================= labour =================
    labour: {
      async list(contractId: bigint) {
        await contractOrNotFound(db, contractId);
        const rows = await db.contractorLabour.findMany({
          where: { contractorContractId: contractId },
          orderBy: [{ labourCode: 'asc' }],
        });
        return rows.map(toLabourOut);
      },
      async add(contractId: bigint, b: z.infer<typeof CreateLabourBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'contractor_contract', { id: contractId });
          const c = await contractOrNotFound(tx, contractId);
          await canChangeEstate(c.estateId, contractId, 'add-labour');
          labourOpen(c);
          const from = b.engaged_from ?? businessDateFromDb(c.startDate);
          const to = b.engaged_to ?? null;
          checkEngagement(c, from, to);
          let code = b.labour_code;
          if (!code) {
            const n = await tx.contractorLabour.count({ where: { contractorContractId: contractId } });
            code = `L-${String(n + 1).padStart(4, '0')}`;
          }
          const l = await tx.contractorLabour
            .create({
              data: {
                contractorContractId: contractId,
                labourCode: code,
                name: b.name,
                nationalId: b.national_id ?? null,
                phone: b.phone ?? null,
                engagedFrom: businessDateToDb(from),
                engagedTo: to === null ? null : businessDateToDb(to),
                createdBy: actorId,
              },
            })
            .catch(duplicate('labour_code', `Labour code ${code} in this contract`));
          const out = toLabourOut(l);
          await auditCreate(tx, LABOUR_AUDIT, l.id, out, { actorId });
          return out;
        });
      },
      async update(
        contractId: bigint,
        labourId: bigint,
        expectedVersion: number,
        b: z.infer<typeof PatchLabourBody>,
        actorId: bigint,
      ) {
        return withTransaction(db, async (tx) => {
          const c = await contractOrNotFound(tx, contractId);
          await canChangeEstate(c.estateId, labourId, 'update-labour');
          const before = await tx.contractorLabour.findUnique({ where: { id: labourId } });
          if (before?.contractorContractId !== contractId) throw Errors.notFound('Labour not found.');
          const from = b.engaged_from !== undefined ? b.engaged_from : d(before.engagedFrom);
          const to = b.engaged_to !== undefined ? b.engaged_to : d(before.engagedTo);
          checkEngagement(c, from, to);
          const { count } = await tx.contractorLabour
            .updateMany({
              where: { id: labourId, version: expectedVersion },
              data: {
                ...Object.fromEntries(
                  Object.entries({
                    labourCode: b.labour_code,
                    name: b.name,
                    nationalId: b.national_id,
                    phone: b.phone,
                    engagedFrom: toDb(b.engaged_from),
                    engagedTo: toDb(b.engaged_to),
                    status: b.status,
                  }).filter(([, v]) => v !== undefined),
                ),
                ...stamp(actorId),
              },
            })
            .catch(duplicate('labour_code', `Labour code ${b.labour_code ?? ''} in this contract`));
          if (count !== 1) versionConflict(before, toLabourOut(before));
          const after = toLabourOut(await tx.contractorLabour.findUniqueOrThrow({ where: { id: labourId } }));
          await auditUpdate(tx, LABOUR_AUDIT, labourId, toLabourOut(before), after, { actorId });
          return after;
        });
      },
      /** Only labour entered in error (attendance from Phase 5 will refer to it). */
      async remove(contractId: bigint, labourId: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const c = await contractOrNotFound(tx, contractId);
          await canChangeEstate(c.estateId, labourId, 'delete-labour');
          const l = await tx.contractorLabour.findUnique({ where: { id: labourId } });
          if (l?.contractorContractId !== contractId) throw Errors.notFound('Labour not found.');
          await tx.contractorLabour
            .delete({ where: { id: labourId } })
            .catch(referenced('contractor labour'));
          await auditDelete(tx, LABOUR_AUDIT, labourId, toLabourOut(l), { actorId });
        });
      },
    },

    /** GET /contractors/summary: the cards, charts, top list and expiry alerts of Contractor Management. */
    async summary(
      estateId: bigint | undefined,
      expiringDays = 30,
    ): Promise<z.infer<typeof ContractorSummaryOut>> {
      const t = today();
      const monthStart = `${t.slice(0, 7)}-01`;
      const contractorWhere: Prisma.ContractorWhereInput =
        estateId === undefined
          ? {}
          : { OR: [{ registeredEstateId: estateId }, { contracts: { some: { estateId } } }] };
      const contractors = await db.contractor.findMany({
        where: contractorWhere,
        select: {
          id: true,
          code: true,
          name: true,
          contractorType: true,
          status: true,
          createdAt: true,
          tradeLicenceExpiry: true,
          tradeCategory: ref,
        },
      });
      const contracts = await db.contractorContract.findMany({
        where: { ...(estateId === undefined ? {} : { estateId }), state: { in: ['approved', 'terminated'] } },
        select: {
          id: true,
          contractNumber: true,
          contractorId: true,
          workType: true,
          state: true,
          startDate: true,
          endDate: true,
          terminatedOn: true,
          contractValue: true,
          contractor: { select: { name: true } },
        },
      });
      const live = contracts.filter((c) => contractStatus(c, t) === 'active');
      const pct = (n: number, of: number) => (of === 0 ? '0.00' : ((n / of) * 100).toFixed(2));
      const bucket = <T>(items: readonly T[], key: (i: T) => [string, string]) => {
        const m = new Map<string, { key: string; label: string; count: number }>();
        for (const i of items) {
          const [k, label] = key(i);
          const e = m.get(k) ?? { key: k, label, count: 0 };
          e.count += 1;
          m.set(k, e);
        }
        return [...m.values()]
          .sort((a, b) => b.count - a.count)
          .map((e) => ({ ...e, percentage: pct(e.count, items.length) }));
      };
      const label = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
      const valueBy = new Map<bigint, ReturnType<typeof dec>>();
      for (const c of live)
        if (c.contractValue !== null)
          valueBy.set(
            c.contractorId,
            (valueBy.get(c.contractorId) ?? dec('0')).plus(c.contractValue.toString()),
          );
      const byId = new Map(contractors.map((c) => [c.id, c]));
      const horizon = addDays(t, expiringDays);
      const alerts = contracts
        .filter((c) => c.state === 'approved')
        .map((c) => ({ c, end: businessDateFromDb(c.endDate) }))
        .filter(({ end }) => end >= addDays(t, -30) && end <= addDays(t, 90))
        .sort((a, b) => a.end.localeCompare(b.end))
        .slice(0, 20)
        .map(({ c, end }) => {
          const days = diffDays(t, end);
          return {
            contract_id: c.id.toString(),
            contract_number: c.contractNumber,
            contractor_id: c.contractorId.toString(),
            contractor_name: c.contractor.name,
            end_date: end,
            days_left: days,
            status:
              days < 0
                ? ('expired' as const)
                : end <= horizon
                  ? ('expiring_soon' as const)
                  : ('safe' as const),
          };
        });
      return {
        estate_id: estateId?.toString() ?? null,
        as_of: new Date().toISOString(),
        total: contractors.length,
        active: contractors.filter((c) => c.status === 'active').length,
        inactive: contractors.filter((c) => c.status !== 'active').length,
        blacklisted: contractors.filter((c) => c.status === 'blacklisted').length,
        contracts_expiring: live.filter((c) => businessDateFromDb(c.endDate) <= horizon).length,
        expiring_days: expiringDays,
        new_this_month: contractors.filter((c) => c.createdAt.toISOString().slice(0, 10) >= monthStart)
          .length,
        total_contract_value: toDecimalString(
          sum(live.flatMap((c) => (c.contractValue === null ? [] : [c.contractValue.toString()]))),
          'money',
        ),
        by_contractor_type: bucket(contractors, (c) => [c.contractorType, label(c.contractorType)]),
        by_work_type: bucket(live, (c) => [c.workType, label(c.workType)]),
        by_trade_category: bucket(contractors, (c) =>
          c.tradeCategory ? [c.tradeCategory.code, c.tradeCategory.name] : ['none', 'Not set'],
        ),
        by_status: bucket(contractors, (c) => [c.status, label(c.status)]),
        top_contractors: [...valueBy.entries()]
          .sort((a, b) => b[1].comparedTo(a[1]))
          .slice(0, 5)
          .flatMap(([cid, v]) => {
            const c = byId.get(cid);
            return c
              ? [
                  {
                    contractor_id: cid.toString(),
                    code: c.code,
                    name: c.name,
                    contract_value: toDecimalString(v, 'money'),
                  },
                ]
              : [];
          }),
        expiry_alerts: alerts,
        licences_expiring: contractors.filter(
          (c) =>
            c.tradeLicenceExpiry !== null &&
            businessDateFromDb(c.tradeLicenceExpiry) <= addDays(t, LICENCE_WARNING_DAYS),
        ).length,
      };
    },
  };
}

export type ContractorService = ReturnType<typeof contractorService>;
