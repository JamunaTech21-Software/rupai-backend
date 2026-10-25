import type { z } from 'zod';

import type { ApprovalAdapter, SubmittedDocument } from '../../core/approval/adapters.js';
import { submitForApproval } from '../../core/approval/engine.js';
import {
  auditAction,
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { readSetting } from '../../core/settings/settings.js';
import { registerPartyResolver } from '../../core/settlement/parties.js';
import { todayIn } from '../../core/time/dates.js';
import type { PartyContact, Prisma } from '../../generated/prisma/client.js';
import type { ContactOwner } from '../facilities/contacts.service.js';
import { removeContactsOf } from '../facilities/contacts.service.js';
import { duplicate, inUse, iso, referenced, versionConflict } from '../organisation/common.js';
import {
  BANK_FIELDS,
  type BankChangeOutT,
  type CreateBankChangeBody,
  type CreateSupplierBody,
  type PatchBankChangeBody,
  type PatchSupplierBody,
  type SupplierOutT,
} from './suppliers.schema.js';

/**
 * Suppliers (Spec P3 §16.1, P7 §9.6; BACKLOG P4.01).
 *
 *   - Organisation tier: outside data scope (P6 §4.2), like buyers and the chart of accounts.
 *   - Bank details are entered with the supplier. Afterwards they change only through a
 *     supplier_bank_change approved by its workflow (P7 §9.6, finance); approval writes them onto the
 *     supplier and stamps bank_details_changed_at, which the payment workflow tests (P7 §8.4: a payment to a
 *     supplier whose bank details changed recently adds the finance-manager step, whatever the amount).
 *   - is_approved_supplier is a guard (P7 §6): no purchase document is submitted for an unapproved supplier.
 *     It is set and withdrawn with supplier.approve.
 *   - Contacts are party_contact rows (owner_type supplier); contact_person, phone and email cache the
 *     primary one.
 */

export const SUPPLIER_DOCUMENT = 'supplier_bank_change';
/** Days after an approved bank detail change during which a payment adds the finance step (P7 §8.4). */
export const BANK_CHANGE_RECENT_SETTING = 'procurement.bank_change_recent_days';
export const DEFAULT_BANK_CHANGE_RECENT_DAYS = 90;

export const SUPPLIER_AUDIT: AuditedRecord = {
  type: 'supplier',
  class: 'master',
  fields: [
    'code',
    'name',
    'business_type',
    'contact_person',
    'phone',
    'email',
    'address_line1',
    'tin',
    'vat_registration',
    'bank_name',
    'bank_branch',
    'bank_account_name',
    'bank_account_number',
    'bank_routing_number',
    'bank_details_changed_at',
    'payment_terms_days',
    'is_approved_supplier',
    'status',
  ],
};

export const BANK_CHANGE_AUDIT: AuditedRecord = {
  type: SUPPLIER_DOCUMENT,
  class: 'master',
  fields: ['supplier_id', 'proposed', 'reason', 'state'],
};

export const SUPPLIER_LIST_FIELDS: ListFieldMap = {
  code: { field: 'code' },
  name: { field: 'name' },
  business_type: { field: 'businessType' },
  status: { field: 'status' },
  is_approved_supplier: { field: 'isApprovedSupplier', convert: (v) => v === true || v === 'true' },
};

type SupplierRow = Prisma.SupplierGetPayload<object>;
const changeInclude = { supplier: { select: { id: true, code: true, name: true } } } as const;
type ChangeRow = Prisma.SupplierBankChangeGetPayload<{ include: typeof changeInclude }>;

const stamp = (actorId: bigint) => ({ version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId });
const invalid = (field: string, message: string) => ({ field, code: 'VALIDATION_FAILED' as const, message });
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);

/** The settlement core shows a payable's supplier by its code and name (D-3.05-4). */
registerPartyResolver('supplier', async (tx, ids) => {
  const rows = await tx.supplier.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, code: true, name: true },
  });
  return new Map(rows.map((r) => [r.id, { code: r.code, name: r.name, estateId: null }]));
});

/** The recent-change window (P7 §8.4), from the setting; 90 days when it is not set. */
export async function bankChangeRecentDays(tx: Database | Tx): Promise<number> {
  const v = await readSetting(tx, null, BANK_CHANGE_RECENT_SETTING);
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : DEFAULT_BANK_CHANGE_RECENT_DAYS;
}

/**
 * Whether the supplier's bank details changed within the recent window before `at`: the payment workflow's
 * condition (P7 §8.4, built in P4.07).
 */
export async function bankDetailsRecentlyChanged(
  tx: Database | Tx,
  supplierId: bigint,
  at: Date = new Date(),
): Promise<boolean> {
  const s = await tx.supplier.findUnique({
    where: { id: supplierId },
    select: { bankDetailsChangedAt: true },
  });
  return isRecent(s?.bankDetailsChangedAt ?? null, await bankChangeRecentDays(tx), at);
}

function isRecent(changedAt: Date | null, days: number, at: Date): boolean {
  return changedAt !== null && at.getTime() - changedAt.getTime() <= days * 86_400_000;
}

type Bank = Record<(typeof BANK_FIELDS)[number], string | null>;
const bankOf = (s: {
  bankName: string | null;
  bankBranch: string | null;
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankRoutingNumber: string | null;
}): Bank => ({
  bank_name: s.bankName,
  bank_branch: s.bankBranch,
  bank_account_name: s.bankAccountName,
  bank_account_number: s.bankAccountNumber,
  bank_routing_number: s.bankRoutingNumber,
});
const previousOf = (c: ChangeRow): Bank => ({
  bank_name: c.previousBankName,
  bank_branch: c.previousBankBranch,
  bank_account_name: c.previousBankAccountName,
  bank_account_number: c.previousBankAccountNumber,
  bank_routing_number: c.previousBankRoutingNumber,
});
const sameBank = (a: Bank, b: Bank) => BANK_FIELDS.every((f) => a[f] === b[f]);

export function suppliersService(db: Database, deps: { readonly timezone: string }) {
  const today = () => todayIn(deps.timezone);

  function toSupplierOut(s: SupplierRow, recentDays: number, pending: bigint | null): SupplierOutT {
    return {
      id: s.id.toString(),
      code: s.code,
      name: s.name,
      business_type: s.businessType as SupplierOutT['business_type'],
      contact_person: s.contactPerson,
      phone: s.phone,
      email: s.email,
      address_line1: s.addressLine1,
      tin: s.tin,
      vat_registration: s.vatRegistration,
      ...bankOf(s),
      bank_details_changed_at: iso(s.bankDetailsChangedAt),
      bank_details_recently_changed: isRecent(s.bankDetailsChangedAt, recentDays, new Date()),
      pending_bank_change_id: pending?.toString() ?? null,
      payment_terms_days: s.paymentTermsDays,
      is_approved_supplier: s.isApprovedSupplier,
      status: s.status as SupplierOutT['status'],
      version: s.version,
      created_at: s.createdAt.toISOString(),
      updated_at: iso(s.updatedAt),
    };
  }

  /** The open bank change of each supplier. */
  async function openChanges(tx: Database | Tx, ids: readonly bigint[]) {
    if (ids.length === 0) return new Map<bigint, bigint>();
    const rows = await tx.supplierBankChange.findMany({
      where: { supplierId: { in: [...ids] }, state: { in: ['draft', 'submitted'] } },
      select: { id: true, supplierId: true },
    });
    return new Map(rows.map((r) => [r.supplierId, r.id]));
  }
  async function supplierOut(tx: Database | Tx, s: SupplierRow) {
    const pending = await openChanges(tx, [s.id]);
    return toSupplierOut(s, await bankChangeRecentDays(tx), pending.get(s.id) ?? null);
  }
  async function supplierOrNotFound(tx: Database | Tx, id: bigint): Promise<SupplierRow> {
    const s = await tx.supplier.findUnique({ where: { id } });
    if (!s) throw Errors.notFound('Supplier not found.');
    return s;
  }

  /** Columns from a create or update body (bank fields only on create). */
  function columns(b: z.infer<typeof PatchSupplierBody>, withBank: boolean) {
    return {
      ...(b.code !== undefined ? { code: b.code } : {}),
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.business_type !== undefined ? { businessType: b.business_type } : {}),
      ...(b.contact_person !== undefined ? { contactPerson: b.contact_person } : {}),
      ...(b.phone !== undefined ? { phone: b.phone } : {}),
      ...(b.email !== undefined ? { email: b.email } : {}),
      ...(b.address_line1 !== undefined ? { addressLine1: b.address_line1 } : {}),
      ...(b.tin !== undefined ? { tin: b.tin } : {}),
      ...(b.vat_registration !== undefined ? { vatRegistration: b.vat_registration } : {}),
      ...(b.payment_terms_days !== undefined ? { paymentTermsDays: b.payment_terms_days } : {}),
      ...(withBank
        ? {
            bankName: b.bank_name ?? null,
            bankBranch: b.bank_branch ?? null,
            bankAccountName: b.bank_account_name ?? null,
            bankAccountNumber: b.bank_account_number ?? null,
            bankRoutingNumber: b.bank_routing_number ?? null,
          }
        : {}),
    };
  }

  /** An update may repeat the bank details; changing them needs an approved bank change (P7 §9.6). */
  function refuseBankEdit(before: SupplierRow, b: z.infer<typeof PatchSupplierBody>) {
    const current = bankOf(before);
    const changed = BANK_FIELDS.filter((f) => b[f] !== undefined && b[f] !== current[f]);
    if (changed.length > 0) {
      throw Errors.validation(
        changed.map((f) =>
          invalid(
            f,
            'Bank details change only through an approved bank detail change: POST /suppliers/{id}/bank-changes.',
          ),
        ),
        'Bank details need approval to change.',
      );
    }
  }

  const contactOwner: ContactOwner = {
    type: 'supplier',
    module: 'supplier',
    exists: async (tx, id) => (await tx.supplier.count({ where: { id } })) === 1,
    syncPrimary: async (tx, ownerId, primary: PartyContact | null) => {
      await tx.supplier.update({
        where: { id: ownerId },
        data: primary
          ? { contactPerson: primary.contactName, phone: primary.phone, email: primary.email }
          : { contactPerson: null },
      });
    },
  };

  // ---- bank detail changes ------------------------------------------------------------------------------
  async function approvalIds(tx: Database | Tx, ids: readonly bigint[]) {
    if (ids.length === 0) return new Map<bigint, bigint>();
    const rows = await tx.approvalRequest.findMany({
      where: { documentType: SUPPLIER_DOCUMENT, documentId: { in: [...ids] }, state: 'pending' },
      select: { id: true, documentId: true },
    });
    return new Map(rows.map((r) => [r.documentId, r.id]));
  }
  function toChangeOut(c: ChangeRow, supplier: SupplierRow, approvalId: bigint | null): BankChangeOutT {
    const open = c.state === 'draft' || c.state === 'submitted';
    return {
      id: c.id.toString(),
      supplier_id: c.supplierId.toString(),
      supplier: { id: c.supplier.id.toString(), code: c.supplier.code, name: c.supplier.name },
      proposed: {
        bank_name: c.bankName,
        bank_branch: c.bankBranch,
        bank_account_name: c.bankAccountName,
        bank_account_number: c.bankAccountNumber,
        bank_routing_number: c.bankRoutingNumber,
      },
      previous: open ? bankOf(supplier) : previousOf(c),
      reason: c.reason,
      state: c.state as BankChangeOutT['state'],
      state_changed_at: iso(c.stateChangedAt),
      submitted_at: iso(c.submittedAt),
      submitted_by: c.submittedBy?.toString() ?? null,
      approved_at: iso(c.approvedAt),
      approved_by: c.approvedBy?.toString() ?? null,
      rejected_at: iso(c.rejectedAt),
      rejection_reason: c.rejectionReason,
      approval_request_id: approvalId?.toString() ?? null,
      version: c.version,
      created_at: c.createdAt.toISOString(),
      created_by: c.createdBy.toString(),
    };
  }
  async function changeOrNotFound(tx: Database | Tx, id: bigint): Promise<ChangeRow> {
    const c = await tx.supplierBankChange.findUnique({ where: { id }, include: changeInclude });
    if (!c) throw Errors.notFound('Bank detail change not found.');
    return c;
  }
  async function changeOut(tx: Database | Tx, c: ChangeRow) {
    const approval = await approvalIds(tx, [c.id]);
    return toChangeOut(c, await supplierOrNotFound(tx, c.supplierId), approval.get(c.id) ?? null);
  }
  const auditOf = (c: ChangeRow) => ({
    supplier_id: c.supplierId.toString(),
    proposed: `${c.bankName} ${c.bankAccountNumber}`,
    reason: c.reason,
    state: c.state,
  });
  /** A proposal that changes nothing is refused: there is nothing to approve. */
  function assertChanges(supplier: SupplierRow, proposed: Bank) {
    if (sameBank(bankOf(supplier), proposed)) {
      throw Errors.validation(
        [invalid('bank_account_number', 'These are the supplier’s current bank details.')],
        'Nothing would change.',
      );
    }
  }
  const proposedOf = (c: ChangeRow): Bank => ({
    bank_name: c.bankName,
    bank_branch: c.bankBranch,
    bank_account_name: c.bankAccountName,
    bank_account_number: c.bankAccountNumber,
    bank_routing_number: c.bankRoutingNumber,
  });
  const alreadyOpen = (err: unknown): never => {
    if (err instanceof Error && err.message.includes('ux_supplier_bank_change_open')) {
      throw transition(
        'The supplier already has a bank detail change awaiting decision.',
        'open',
        'Decide or withdraw that one first.',
      );
    }
    throw err;
  };

  /** Draft → submitted, then into the workflow (no workflow: applied at once, P7 §3.2). */
  async function submitChange(tx: Tx, id: bigint, actorId: bigint) {
    const now = new Date();
    await tx.supplierBankChange.update({
      where: { id },
      data: {
        state: 'submitted',
        stateChangedAt: now,
        submittedAt: now,
        submittedBy: actorId,
        ...stamp(actorId),
      },
    });
    await recordStatusChange(tx, BANK_CHANGE_AUDIT.type, id, 'draft', 'submitted', { actorId });
    await submitForApproval(tx, { timezone: deps.timezone }, SUPPLIER_DOCUMENT, id, {
      actorId,
      date: today(),
    });
  }

  const adapter: ApprovalAdapter = {
    documentType: SUPPLIER_DOCUMENT,
    async describe(tx, id): Promise<SubmittedDocument> {
      const c = await changeOrNotFound(tx, id);
      return {
        id,
        number: null,
        label: `Bank details · ${c.supplier.code} ${c.supplier.name} → ${c.bankName} ${c.bankAccountNumber}`,
        createdBy: c.createdBy,
        values: {},
      };
    },
    /** Applies the details to the supplier and stamps the change time (the payment control flag). */
    async onApproved(tx, id, ctx) {
      await lockRowsForUpdate(tx, 'supplier_bank_change', { id });
      const c = await changeOrNotFound(tx, id);
      if (c.state !== 'submitted')
        throw transition(`A ${c.state} bank detail change cannot be approved.`, c.state, 'Reload it.');
      await lockRowsForUpdate(tx, 'supplier', { id: c.supplierId });
      const before = await supplierOrNotFound(tx, c.supplierId);
      const now = new Date();
      await tx.supplier.update({
        where: { id: c.supplierId },
        data: {
          bankName: c.bankName,
          bankBranch: c.bankBranch,
          bankAccountName: c.bankAccountName,
          bankAccountNumber: c.bankAccountNumber,
          bankRoutingNumber: c.bankRoutingNumber,
          bankDetailsChangedAt: now,
          ...stamp(ctx.actorId),
        },
      });
      await tx.supplierBankChange.update({
        where: { id },
        data: {
          state: 'approved',
          stateChangedAt: now,
          approvedAt: now,
          approvedBy: ctx.actorId,
          previousBankName: before.bankName,
          previousBankBranch: before.bankBranch,
          previousBankAccountName: before.bankAccountName,
          previousBankAccountNumber: before.bankAccountNumber,
          previousBankRoutingNumber: before.bankRoutingNumber,
          ...stamp(ctx.actorId),
        },
      });
      const after = await supplierOrNotFound(tx, c.supplierId);
      const days = await bankChangeRecentDays(tx);
      await auditUpdate(
        tx,
        SUPPLIER_AUDIT,
        c.supplierId,
        toSupplierOut(before, days, id),
        toSupplierOut(after, days, null),
        { actorId: ctx.actorId, actingForUserId: ctx.actingForUserId, reason: c.reason },
      );
      await auditAction(tx, BANK_CHANGE_AUDIT, id, 'approve', {
        actorId: ctx.actorId,
        actingForUserId: ctx.actingForUserId,
      });
      await recordStatusChange(tx, BANK_CHANGE_AUDIT.type, id, 'submitted', 'approved', {
        actorId: ctx.actorId,
      });
    },
    async onRejected(tx, id, ctx) {
      const now = new Date();
      await tx.supplierBankChange.update({
        where: { id },
        data: {
          state: 'rejected',
          stateChangedAt: now,
          rejectedAt: now,
          rejectedBy: ctx.actorId,
          rejectionReason: ctx.reason.slice(0, 500),
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, BANK_CHANGE_AUDIT, id, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
      await recordStatusChange(tx, BANK_CHANGE_AUDIT.type, id, 'submitted', 'rejected', {
        actorId: ctx.actorId,
        comment: ctx.reason,
      });
    },
    async onReturned(tx, id, ctx) {
      await tx.supplierBankChange.update({
        where: { id },
        data: {
          state: 'draft',
          stateChangedAt: new Date(),
          submittedAt: null,
          submittedBy: null,
          ...stamp(ctx.actorId),
        },
      });
      await recordStatusChange(tx, BANK_CHANGE_AUDIT.type, id, 'submitted', 'draft', {
        actorId: ctx.actorId,
        comment: ctx.comment,
      });
    },
  };

  return {
    adapter,
    contactOwner,

    // ================= suppliers =================
    async list(q: ListQuery) {
      const search = q.filters.find((f) => f.field === 'q');
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== 'q') };
      const and: Prisma.SupplierWhereInput[] = [toWhere(rest, SUPPLIER_LIST_FIELDS)];
      if (search) {
        const v = String(search.value);
        and.push({ OR: [{ code: { startsWith: v } }, { name: { contains: v } }] });
      }
      const where: Prisma.SupplierWhereInput = { AND: and };
      const [rows, total, days] = await Promise.all([
        db.supplier.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, SUPPLIER_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.supplier.count({ where }),
        bankChangeRecentDays(db),
      ]);
      const pending = await openChanges(
        db,
        rows.map((r) => r.id),
      );
      return { items: rows.map((s) => toSupplierOut(s, days, pending.get(s.id) ?? null)), total };
    },

    async get(id: bigint) {
      return supplierOut(db, await supplierOrNotFound(db, id));
    },

    async create(b: z.infer<typeof CreateSupplierBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const code = b.code ?? (await allocateNumber(tx, 'supplier', { date: today() }, 'draft')).number;
        const { id } = await tx.supplier
          .create({
            data: {
              ...columns(b, true),
              code,
              name: b.name,
              businessType: b.business_type,
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Supplier code ${code}`));
        const out = await supplierOut(tx, await supplierOrNotFound(tx, id));
        await auditCreate(tx, SUPPLIER_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, SUPPLIER_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchSupplierBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await supplierOrNotFound(tx, id);
        refuseBankEdit(before, changes);
        const old = await supplierOut(tx, before);
        const { count } = await tx.supplier
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...columns(changes, false), ...stamp(actorId) },
          })
          .catch(duplicate('code', `Supplier code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, old);
        const after = await supplierOut(tx, await supplierOrNotFound(tx, id));
        await auditUpdate(tx, SUPPLIER_AUDIT, id, old, after, { actorId });
        return after;
      });
    },

    async setStatus(id: bigint, expectedVersion: number, status: 'active' | 'inactive', actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await supplierOrNotFound(tx, id);
        const old = await supplierOut(tx, before);
        if (before.version !== expectedVersion) versionConflict(before, old);
        if (before.status === status) return old;
        await tx.supplier.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = await supplierOut(tx, await supplierOrNotFound(tx, id));
        await auditUpdate(tx, SUPPLIER_AUDIT, id, old, after, { actorId });
        await recordStatusChange(tx, SUPPLIER_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    /** Sets or withdraws is_approved_supplier (supplier.approve). Idempotent. */
    async setApproved(
      id: bigint,
      expectedVersion: number,
      approved: boolean,
      reason: string | null,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await supplierOrNotFound(tx, id);
        const old = await supplierOut(tx, before);
        if (before.version !== expectedVersion) versionConflict(before, old);
        if (before.isApprovedSupplier === approved) return old;
        if (approved && before.status !== 'active') {
          throw transition('An inactive supplier cannot be approved.', before.status, 'Reactivate it first.');
        }
        await tx.supplier.update({
          where: { id },
          data: { isApprovedSupplier: approved, ...stamp(actorId) },
        });
        const after = await supplierOut(tx, await supplierOrNotFound(tx, id));
        await auditUpdate(tx, SUPPLIER_AUDIT, id, old, after, { actorId, reason });
        return after;
      });
    },

    /** Only a supplier created in error: nothing refers to it (bank changes, payables, payments). */
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const s = await supplierOrNotFound(tx, id);
        const party = { partyType: 'supplier', partyId: id };
        const [changes, payables, payments] = await Promise.all([
          tx.supplierBankChange.count({ where: { supplierId: id } }),
          tx.payable.count({ where: party }),
          tx.payment.count({ where: party }),
        ]);
        if (changes > 0) throw inUse('supplier', 'bank detail changes');
        if (payables + payments > 0) throw inUse('supplier', 'payables or payments');
        const out = await supplierOut(tx, s);
        await removeContactsOf(tx, 'supplier', id, actorId);
        await tx.supplier.delete({ where: { id } }).catch(referenced('supplier'));
        await auditDelete(tx, SUPPLIER_AUDIT, id, out, { actorId });
      });
    },

    // ================= bank detail changes =================
    async listChanges(supplierId: bigint) {
      const supplier = await supplierOrNotFound(db, supplierId);
      const rows = await db.supplierBankChange.findMany({
        where: { supplierId },
        include: changeInclude,
        orderBy: { id: 'desc' },
      });
      const approvals = await approvalIds(
        db,
        rows.map((r) => r.id),
      );
      return rows.map((c) => toChangeOut(c, supplier, approvals.get(c.id) ?? null));
    },

    async getChange(id: bigint) {
      return changeOut(db, await changeOrNotFound(db, id));
    },

    /** Proposes new bank details; submitted to the workflow at once unless `submit` is false. */
    async createChange(supplierId: bigint, b: z.infer<typeof CreateBankChangeBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'supplier', { id: supplierId });
        const supplier = await supplierOrNotFound(tx, supplierId);
        const proposed: Bank = {
          bank_name: b.bank_name,
          bank_branch: b.bank_branch ?? null,
          bank_account_name: b.bank_account_name ?? null,
          bank_account_number: b.bank_account_number,
          bank_routing_number: b.bank_routing_number ?? null,
        };
        assertChanges(supplier, proposed);
        const { id } = await tx.supplierBankChange
          .create({
            data: {
              supplierId,
              bankName: b.bank_name,
              bankBranch: b.bank_branch ?? null,
              bankAccountName: b.bank_account_name ?? null,
              bankAccountNumber: b.bank_account_number,
              bankRoutingNumber: b.bank_routing_number ?? null,
              reason: b.reason,
              state: 'draft',
              stateChangedAt: new Date(),
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(alreadyOpen);
        const created = await changeOrNotFound(tx, id);
        await auditCreate(tx, BANK_CHANGE_AUDIT, id, auditOf(created), { actorId });
        await recordStatusChange(tx, BANK_CHANGE_AUDIT.type, id, null, 'draft', { actorId });
        if (b.submit !== false) await submitChange(tx, id, actorId);
        return changeOut(tx, await changeOrNotFound(tx, id));
      });
    },

    /** A draft (new, or returned by an approver) is corrected before it is submitted again. */
    async updateChange(
      id: bigint,
      expectedVersion: number,
      b: z.infer<typeof PatchBankChangeBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await changeOrNotFound(tx, id);
        if (before.version !== expectedVersion) versionConflict(before, await changeOut(tx, before));
        if (before.state !== 'draft')
          throw transition(
            `A ${before.state} bank detail change cannot be edited.`,
            before.state,
            'Only a draft.',
          );
        // undefined keeps the current value; null clears it (so not `??`).
        const pick = <T>(v: T | undefined, kept: T): T => {
          if (v === undefined) return kept;
          return v;
        };
        const proposed: Bank = {
          bank_name: pick(b.bank_name, before.bankName),
          bank_branch: pick(b.bank_branch, before.bankBranch),
          bank_account_name: pick(b.bank_account_name, before.bankAccountName),
          bank_account_number: pick(b.bank_account_number, before.bankAccountNumber),
          bank_routing_number: pick(b.bank_routing_number, before.bankRoutingNumber),
        };
        assertChanges(await supplierOrNotFound(tx, before.supplierId), proposed);
        await tx.supplierBankChange.update({
          where: { id },
          data: {
            bankName: proposed.bank_name ?? before.bankName,
            bankBranch: proposed.bank_branch,
            bankAccountName: proposed.bank_account_name,
            bankAccountNumber: proposed.bank_account_number ?? before.bankAccountNumber,
            bankRoutingNumber: proposed.bank_routing_number,
            reason: pick(b.reason, before.reason),
            ...stamp(actorId),
          },
        });
        const after = await changeOrNotFound(tx, id);
        await auditUpdate(tx, BANK_CHANGE_AUDIT, id, auditOf(before), auditOf(after), { actorId });
        return changeOut(tx, after);
      });
    },

    async submitChange(id: bigint, expectedVersion: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'supplier_bank_change', { id });
        const c = await changeOrNotFound(tx, id);
        if (c.version !== expectedVersion) versionConflict(c, await changeOut(tx, c));
        if (c.state !== 'draft')
          throw transition(`A ${c.state} bank detail change cannot be submitted.`, c.state, 'Only a draft.');
        assertChanges(await supplierOrNotFound(tx, c.supplierId), proposedOf(c));
        await submitChange(tx, id, actorId);
        return changeOut(tx, await changeOrNotFound(tx, id));
      });
    },

    /** Withdraws a draft. A submitted change is decided (or returned) by its approvers. */
    async removeChange(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const c = await changeOrNotFound(tx, id);
        if (c.state !== 'draft')
          throw transition(`A ${c.state} bank detail change cannot be deleted.`, c.state, 'Only a draft.');
        await tx.supplierBankChange.delete({ where: { id } });
        await auditDelete(tx, BANK_CHANGE_AUDIT, id, auditOf(c), { actorId });
      });
    },
  };
}

export type SuppliersService = ReturnType<typeof suppliersService>;
