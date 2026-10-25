import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';

/** Request and response schemas of suppliers and their bank detail changes (P4.01; Spec P3 §16.1, P7 §9.6). */

export const BUSINESS_TYPES = ['manufacturer', 'distributor', 'retailer', 'service', 'contractor'] as const;
export const SUPPLIER_STATUSES = ['active', 'inactive'] as const;
export const BANK_CHANGE_STATES = ['draft', 'submitted', 'approved', 'rejected'] as const;

export const IdParams = z.object({ id: zId });

const text = (max: number) => z.string().trim().min(1).max(max);
const zCode = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".');
const zPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9][0-9 -]{4,26}[0-9]$/, 'Must be a phone number, e.g. +8801711000000.');
const zAccountNumber = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 .\-/]*$/, 'Letters, digits, spaces, ".", "-" or "/".');

/** The bank details: entered with the supplier, changed afterwards only through an approved change. */
const bank = {
  bank_name: text(150),
  bank_branch: text(150),
  bank_account_name: text(150),
  bank_account_number: zAccountNumber,
  bank_routing_number: zCode(20),
};
export const BANK_FIELDS = Object.keys(bank) as (keyof typeof bank)[];

const supplierFields = {
  /** Numbered by the `supplier` format when omitted. */
  code: zCode(20),
  name: text(150),
  business_type: z.enum(BUSINESS_TYPES),
  /** Kept in step with the primary contact (POST /suppliers/{id}/contacts) once it has one. */
  contact_person: text(150).nullable(),
  phone: zPhone.nullable(),
  email: z.email().max(150).nullable(),
  address_line1: text(200).nullable(),
  tin: zCode(30).nullable(),
  vat_registration: zCode(30).nullable(),
  bank_name: bank.bank_name.nullable(),
  bank_branch: bank.bank_branch.nullable(),
  bank_account_name: bank.bank_account_name.nullable(),
  bank_account_number: bank.bank_account_number.nullable(),
  bank_routing_number: bank.bank_routing_number.nullable(),
  payment_terms_days: z.number().int().min(0).max(365).nullable(),
};

export const CreateSupplierBody = z
  .strictObject(supplierFields)
  .partial()
  .required({ name: true, business_type: true });
/**
 * PUT and PATCH accept the bank fields so a form can send the record back whole, but refuse any CHANGE to
 * them: that goes through POST /suppliers/{id}/bank-changes (P7 §9.6).
 */
export const ReplaceSupplierBody = z.strictObject(supplierFields);
export const PatchSupplierBody = z.strictObject(supplierFields).partial();

export const SupplierOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  business_type: z.enum(BUSINESS_TYPES),
  contact_person: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address_line1: z.string().nullable(),
  tin: z.string().nullable(),
  vat_registration: z.string().nullable(),
  bank_name: z.string().nullable(),
  bank_branch: z.string().nullable(),
  bank_account_name: z.string().nullable(),
  bank_account_number: z.string().nullable(),
  bank_routing_number: z.string().nullable(),
  /** When an approved change last replaced the bank details; null: the details entered at creation. */
  bank_details_changed_at: z.string().nullable(),
  /** Changed within the recent period (setting procurement.bank_change_recent_days): payments add the finance step. */
  bank_details_recently_changed: z.boolean(),
  /** The open (draft or submitted) bank detail change, if any. */
  pending_bank_change_id: z.string().nullable(),
  payment_terms_days: z.number().int().nullable(),
  is_approved_supplier: z.boolean(),
  status: z.enum(SUPPLIER_STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type SupplierOutT = z.infer<typeof SupplierOut>;

export const SupplierApprovalBody = z.strictObject({ reason: text(500).optional() });

// ---- bank detail changes -------------------------------------------------------------------------------

const changeFields = {
  bank_name: bank.bank_name,
  bank_branch: bank.bank_branch.nullable(),
  bank_account_name: bank.bank_account_name.nullable(),
  bank_account_number: bank.bank_account_number,
  bank_routing_number: bank.bank_routing_number.nullable(),
  /** Why the details change (the supplier's letter, a new account …): shown to the approver. */
  reason: text(500),
};
export const CreateBankChangeBody = z
  .strictObject({
    ...changeFields,
    /** false: keep it as a draft to submit later. Default true. */
    submit: z.boolean().optional(),
  })
  .partial({ bank_branch: true, bank_account_name: true, bank_routing_number: true });
export const PatchBankChangeBody = z.strictObject(changeFields).partial();

const BankDetails = z.object({
  bank_name: z.string().nullable(),
  bank_branch: z.string().nullable(),
  bank_account_name: z.string().nullable(),
  bank_account_number: z.string().nullable(),
  bank_routing_number: z.string().nullable(),
});

export const BankChangeOut = z.object({
  id: z.string(),
  supplier_id: z.string(),
  supplier: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  proposed: BankDetails,
  /** The details it replaces: the supplier's current ones while open, the replaced ones once approved. */
  previous: BankDetails,
  reason: z.string(),
  state: z.enum(BANK_CHANGE_STATES),
  state_changed_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  submitted_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_by: z.string().nullable(),
  rejected_at: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  /** The pending approval request while submitted (GET /approvals/{id}). */
  approval_request_id: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  created_by: z.string(),
});
export type BankChangeOutT = z.infer<typeof BankChangeOut>;
