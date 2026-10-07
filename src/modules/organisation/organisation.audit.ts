import type { AuditedRecord } from '../../core/audit/audit.js';

/**
 * What the organisation hierarchy audits (Spec P1 Table 13.1: masters record their significant fields,
 * and status history because they are stateful). The audited values are the API representations, so a
 * change log reads exactly like the resource.
 */

export const ORGANISATION_AUDIT: AuditedRecord = {
  type: 'organisation',
  class: 'master',
  fields: [
    'name',
    'short_name',
    'registration_number',
    'tin',
    'vat_registration',
    'address_line1',
    'address_line2',
    'city',
    'postal_code',
    'country_id',
    'phone',
    'email',
    'website',
    'logo_path',
    'base_currency_id',
    'fiscal_year_start_month',
    'status',
  ],
};

export const ESTATE_AUDIT: AuditedRecord = {
  type: 'estate',
  class: 'master',
  fields: [
    'code',
    'name',
    'location',
    'address_line1',
    'district',
    'total_area',
    'manager_profile_id',
    'phone',
    'email',
    'established_on',
    'ownership_type',
    'status',
    'remarks',
  ],
};

export const DIVISION_AUDIT: AuditedRecord = {
  type: 'division',
  class: 'master',
  fields: ['estate_id', 'code', 'name', 'manager_profile_id', 'area', 'status'],
};

export const SECTION_AUDIT: AuditedRecord = {
  type: 'section',
  class: 'master',
  fields: ['division_id', 'code', 'name', 'supervisor_profile_id', 'area', 'status'],
};

/** section_id and section_effective_from are tracked: the audit chain IS the field's section history. */
export const FIELD_AUDIT: AuditedRecord = {
  type: 'field',
  class: 'master',
  fields: [
    'estate_id',
    'section_id',
    'section_effective_from',
    'field_number',
    'name',
    'gross_area',
    'planted_area',
    'field_status',
    'status',
    'remarks',
  ],
};
