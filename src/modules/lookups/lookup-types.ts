import type { DecimalKind } from '../../core/money/decimal.js';

/**
 * Every reference master (Spec P3 §5, §7.1), described once. One engine (lookup.engine.ts) turns a
 * descriptor into validation, SQL, the API contract and the audit record, so 25 tables behave identically.
 *
 * Adding a lookup: create its table in a migration (common shape of P3 §5.1 plus its own columns), add its
 * descriptor here, and it has the full master API under its path.
 */

export type FieldType =
  | { readonly kind: 'string'; readonly max: number; readonly pattern?: RegExp; readonly upper?: boolean }
  | { readonly kind: 'int'; readonly min?: number; readonly max?: number }
  | { readonly kind: 'bool' }
  | { readonly kind: 'decimal'; readonly decimal: DecimalKind; readonly positive?: boolean }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  /** A reference to another table's id. `table` must exist; the engine checks the row does. */
  | { readonly kind: 'ref'; readonly table: string; readonly label: string }
  /** A time of day, "HH:MM". */
  | { readonly kind: 'time' };

export interface LookupField {
  readonly name: string;
  readonly type: FieldType;
  /** Must be given on create and is never null. */
  readonly required?: boolean;
  /** Value when omitted on create. */
  readonly default?: string | number | boolean | null;
  /** Shown, never accepted: maintained by the seed or the engine (is_system, is_base, is_overnight). */
  readonly readOnly?: boolean;
  /** May be used as a list filter. */
  readonly filter?: boolean;
}

export interface LookupType {
  /** The type's name in the API and in audit records: snake_case, the table name. */
  readonly key: string;
  readonly table: string;
  /** Path under /api/v1. */
  readonly path: string;
  /** The permission module guarding it: {module}.view / .create / .edit / .delete. */
  readonly permission: string;
  readonly label: string;
  /** The unique business key (unique index ux_{table}_{keyField}). */
  readonly keyField: string;
  readonly fields: readonly LookupField[];
  /** Whether rows carry is_system (P3 §5.1): such rows keep their key and cannot be deleted or deactivated. */
  readonly hasSystem: boolean;
  readonly defaultSort: readonly string[];
  /** A nullable estate column: NULL rows are organisation-wide, others follow estate scope (shift). */
  readonly estateColumn?: string;
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/;
const str = (max: number): FieldType => ({ kind: 'string', max });

/** P3 §5.1: code, name, description, sort_order, is_system (+ status and the audit block). */
const COMMON: readonly LookupField[] = [
  { name: 'code', type: { kind: 'string', max: 20, pattern: CODE }, required: true },
  { name: 'name', type: str(150), required: true },
  { name: 'description', type: str(500), default: null },
  { name: 'sort_order', type: { kind: 'int', min: 0, max: 100000 }, required: false, default: 0 },
  { name: 'is_system', type: { kind: 'bool' }, readOnly: true },
];

function common(
  key: string,
  label: string,
  over: Partial<LookupType> = {},
  extra: readonly LookupField[] = [],
): LookupType {
  return {
    key,
    table: key,
    path: `/lookups/${key}`,
    permission: 'lookup',
    label,
    keyField: 'code',
    fields: [...COMMON, ...extra],
    hasSystem: true,
    defaultSort: ['sort_order', 'name'],
    ...over,
  };
}

/**
 * The 24 tables that use the common shape unchanged (P3 §5.1; amenity from R.2, the estate profile;
 * irrigation_source, soil_type and drainage_class from R.3, the Field / Block page; religion,
 * education_level, skill and language from P2.01, the person form).
 */
const PLAIN: readonly (readonly [string, string])[] = [
  ['department', 'department'],
  ['designation', 'designation'],
  ['worker_category', 'worker category'],
  ['employee_category', 'employee category'],
  ['employment_type', 'employment type'],
  ['leave_type', 'leave type'],
  ['buyer_type', 'buyer type'],
  ['trading_type', 'trading type'],
  ['packaging_type', 'packaging type'],
  ['charge_type', 'charge type'],
  ['document_type', 'document type'],
  ['payment_method', 'payment method'],
  ['land_type', 'land type'],
  ['adjustment_reason', 'adjustment reason'],
  ['quality_grade', 'quality grade'],
  ['collection_point_type', 'collection point type'],
  ['amenity', 'estate facility'],
  ['irrigation_source', 'irrigation source'],
  ['soil_type', 'soil type'],
  ['drainage_class', 'drainage class'],
  ['religion', 'religion'],
  ['education_level', 'education level'],
  ['skill', 'skill'],
  ['language', 'language'],
];

export const MANUFACTURE_PROCESSES = ['ctc', 'orthodox', 'green', 'oolong', 'white', 'other'] as const;
export const GRADE_CATEGORIES = ['leaf', 'broken', 'fannings', 'dust'] as const;
export const COST_CATEGORIES = ['cultivation', 'maintenance', 'protection', 'harvesting', 'other'] as const;
export const VARIETY_TYPES = ['clonal', 'seedling', 'hybrid'] as const;

export const LOOKUP_TYPES: readonly LookupType[] = [
  ...PLAIN.map(([key, label]) => common(key, label)),

  // ---- lookups with additional columns (P3 §5.2, §7.1) -----------------------------------------
  common('tea_type', 'tea type', { path: '/tea-types', permission: 'tea_type' }, [
    {
      name: 'manufacture_process',
      type: { kind: 'enum', values: MANUFACTURE_PROCESSES },
      default: null,
      filter: true,
    },
  ]),
  common('tea_grade', 'tea grade', { path: '/tea-grades', permission: 'tea_grade' }, [
    /** NULL: the grade is valid for every tea type. */
    {
      name: 'tea_type_id',
      type: { kind: 'ref', table: 'tea_type', label: 'tea type' },
      default: null,
      filter: true,
    },
    { name: 'grade_category', type: { kind: 'enum', values: GRADE_CATEGORIES }, default: null, filter: true },
    { name: 'is_primary_grade', type: { kind: 'bool' }, default: false, filter: true },
  ]),
  common('activity_type', 'activity type', { permission: 'activity_type' }, [
    { name: 'cost_category', type: { kind: 'enum', values: COST_CATEGORIES }, required: true, filter: true },
    { name: 'default_uom_id', type: { kind: 'ref', table: 'uom', label: 'unit of measure' }, default: null },
    { name: 'requires_material', type: { kind: 'bool' }, default: false, filter: true },
  ]),
  common('shift', 'shift', { path: '/shifts', permission: 'shift', estateColumn: 'estate_id' }, [
    /** NULL: organisation-wide. */
    {
      name: 'estate_id',
      type: { kind: 'ref', table: 'estate', label: 'estate' },
      default: null,
      filter: true,
    },
    { name: 'start_time', type: { kind: 'time' }, required: true },
    /** May be earlier than start_time for a night shift. */
    { name: 'end_time', type: { kind: 'time' }, required: true },
    { name: 'break_minutes', type: { kind: 'int', min: 0, max: 1440 }, default: 0 },
    { name: 'grace_minutes', type: { kind: 'int', min: 0, max: 1440 }, default: 0 },
    { name: 'half_day_hours', type: { kind: 'decimal', decimal: 'pct', positive: true }, default: null },
    /** Derived: the shift ends on the following day (end_time is not after start_time). */
    { name: 'is_overnight', type: { kind: 'bool' }, readOnly: true },
    { name: 'overtime_after_minutes', type: { kind: 'int', min: 0, max: 1440 }, default: null },
  ]),
  common('uom_category', 'unit category', { permission: 'uom' }, [
    /** The unit conversion factors in this category are expressed against. Set after its units exist. */
    { name: 'base_uom_id', type: { kind: 'ref', table: 'uom', label: 'unit of measure' }, default: null },
  ]),
  common('tea_variety', 'tea variety', {}, [
    { name: 'variety_type', type: { kind: 'enum', values: VARIETY_TYPES }, default: null, filter: true },
    { name: 'recommended_spacing', type: str(100), default: null },
    /** A planning reference; never used in a calculation (P3 §7.1). */
    { name: 'typical_yield_kg_ha', type: { kind: 'decimal', decimal: 'qty' }, default: null },
  ]),

  // ---- units, currency, country: their own shapes (P3 §5.3–§5.4) ---------------------------------
  {
    key: 'uom',
    table: 'uom',
    path: '/uoms',
    permission: 'uom',
    label: 'unit of measure',
    keyField: 'code',
    hasSystem: true,
    defaultSort: ['code'],
    fields: [
      {
        name: 'uom_category_id',
        type: { kind: 'ref', table: 'uom_category', label: 'unit category' },
        required: true,
        filter: true,
      },
      { name: 'code', type: { kind: 'string', max: 20, pattern: CODE }, required: true },
      { name: 'name', type: str(100), required: true },
      { name: 'decimal_precision', type: { kind: 'int', min: 0, max: 6 }, default: 3 },
      /** Multiplier to the category's base unit (1000 for ton → kg). No conversion engine: O-18. */
      { name: 'conversion_factor', type: { kind: 'decimal', decimal: 'pct', positive: true }, default: null },
      /** Set through the category's base_uom_id. */
      { name: 'is_base', type: { kind: 'bool' }, readOnly: true },
      { name: 'is_system', type: { kind: 'bool' }, readOnly: true },
    ],
  },
  {
    key: 'currency',
    table: 'currency',
    path: '/lookups/currency',
    permission: 'currency',
    label: 'currency',
    keyField: 'code',
    hasSystem: false,
    defaultSort: ['code'],
    fields: [
      {
        name: 'code',
        type: { kind: 'string', max: 3, pattern: /^[A-Za-z]{3}$/, upper: true },
        required: true,
      },
      { name: 'name', type: str(150), required: true },
      { name: 'symbol', type: str(10), default: null },
      { name: 'decimal_places', type: { kind: 'int', min: 0, max: 4 }, default: 2 },
      /** The organisation's base currency (BDT). Fixed by the seed. */
      { name: 'is_base', type: { kind: 'bool' }, readOnly: true },
    ],
  },
  {
    key: 'country',
    table: 'country',
    path: '/lookups/country',
    permission: 'country',
    label: 'country',
    keyField: 'iso2',
    hasSystem: false,
    defaultSort: ['name'],
    fields: [
      {
        name: 'iso2',
        type: { kind: 'string', max: 2, pattern: /^[A-Za-z]{2}$/, upper: true },
        required: true,
      },
      {
        name: 'iso3',
        type: { kind: 'string', max: 3, pattern: /^[A-Za-z]{3}$/, upper: true },
        required: true,
      },
      { name: 'name', type: str(150), required: true },
      {
        name: 'dialling_code',
        type: { kind: 'string', max: 10, pattern: /^\+[0-9][0-9 -]{0,8}$/ },
        default: null,
      },
    ],
  },
];

export const LOOKUP_BY_KEY: ReadonlyMap<string, LookupType> = new Map(LOOKUP_TYPES.map((t) => [t.key, t]));

export function lookupType(key: string): LookupType {
  const t = LOOKUP_BY_KEY.get(key);
  if (!t) throw new Error(`unknown lookup type ${key}`);
  return t;
}
