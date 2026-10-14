import type { ErrorDetail } from '../errors/app-error.js';
import { dec, type Dec } from '../money/decimal.js';
import type { ApprovableDocument, ConditionField, FieldClass } from './document-types.js';

/**
 * The condition grammar of the approval engine (Spec P7 §5).
 *
 *   - A condition tests ONE field of the document with one operator. Conditions combine with AND only:
 *     there is no OR and no nesting. A step needing "or" is two steps (P7 §5.1).
 *   - Only the document is tested: never the date, another document, or the outcome of an earlier step
 *     (P7 §5.2). That is what makes an approval path reproducible afterwards.
 *   - Amounts are compared in base currency, as decimals, never as floats.
 *
 * A step carries at most one condition (the three columns of P3 §28.3); `between` covers a range. A
 * workflow's own condition (when the workflow applies at all) is a list, all of which must hold.
 */

export const OPERATORS = [
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'eq',
  'in',
  'not_in',
  'is_true',
  'is_false',
] as const;
export type Operator = (typeof OPERATORS)[number];

/** P7 Table 5.1: which operators each class of field allows. */
export const CLASS_OPERATORS: Readonly<Record<FieldClass, readonly Operator[]>> = {
  amount: ['lt', 'lte', 'gt', 'gte', 'between'],
  quantity: ['lt', 'lte', 'gt', 'gte'],
  organisational: ['eq', 'in', 'not_in'],
  attribute: ['eq', 'in'],
  submitter: ['eq', 'in'],
  flag: ['is_true', 'is_false'],
};

/** A number as a decimal string, one value or several, or nothing (flags). */
export type ConditionValue = string | string[] | null;

export interface Condition {
  readonly field: string;
  readonly operator: Operator;
  readonly value: ConditionValue;
}

/** The values of one document, as its module hands them to the engine. */
export type DocumentValues = Readonly<Record<string, string | boolean | null | undefined>>;

const NUMBER = /^\d{1,15}(?:\.\d{1,4})?$/;
const ID = /^[1-9]\d{0,19}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,49}$/;
const MAX_LIST = 50;

const COMPARISONS = new Set<Operator>(['lt', 'lte', 'gt', 'gte']);
const LISTS = new Set<Operator>(['in', 'not_in']);
const NUMERIC = new Set<FieldClass>(['amount', 'quantity']);
const IDS = new Set<FieldClass>(['organisational', 'submitter']);

export function fieldOf(document: ApprovableDocument, name: string): ConditionField | undefined {
  return document.fields.find((f) => f.name === name);
}

/**
 * Whether a condition is well-formed for this document type (P7 §15.2, check 1): the field exists on it,
 * the operator suits the field's class, and the value has the shape the operator needs.
 */
export function checkCondition(document: ApprovableDocument, c: Condition, path: string): ErrorDetail[] {
  const problem = (suffix: string, message: string, context?: Record<string, unknown>): ErrorDetail => ({
    field: `${path}.${suffix}`,
    code: 'WORKFLOW_CONDITION_INVALID',
    message,
    ...(context ? { context } : {}),
  });
  const field = fieldOf(document, c.field);
  if (!field) {
    return [
      problem('field', `A ${document.label.toLowerCase()} has no field "${c.field}".`, {
        fields: document.fields.map((f) => f.name),
      }),
    ];
  }
  const allowed = CLASS_OPERATORS[field.class];
  if (!allowed.includes(c.operator)) {
    return [
      problem('operator', `"${c.operator}" cannot be used on ${field.label} (use ${allowed.join(', ')}).`, {
        operators: allowed,
      }),
    ];
  }
  const one = (v: unknown): v is string =>
    typeof v === 'string' && (NUMERIC.has(field.class) ? NUMBER : IDS.has(field.class) ? ID : CODE).test(v);
  const kind = NUMERIC.has(field.class)
    ? 'a number such as "50000.00"'
    : IDS.has(field.class)
      ? 'an id'
      : 'a code';

  if (c.operator === 'is_true' || c.operator === 'is_false') {
    return c.value === null ? [] : [problem('value', 'A flag test takes no value.')];
  }
  if (c.operator === 'between') {
    const v = c.value;
    if (!Array.isArray(v) || v.length !== 2 || !one(v[0]) || !one(v[1])) {
      return [problem('value', 'between needs two numbers: [from, to], both included.')];
    }
    return dec(v[0]).gt(dec(v[1])) ? [problem('value', 'The first number must not exceed the second.')] : [];
  }
  if (LISTS.has(c.operator)) {
    const v = c.value;
    if (!Array.isArray(v) || v.length === 0 || v.length > MAX_LIST || !v.every(one)) {
      return [
        problem('value', `"${c.operator}" needs a list of 1 to ${String(MAX_LIST)} values, each ${kind}.`),
      ];
    }
    return new Set(v).size === v.length ? [] : [problem('value', 'The list repeats a value.')];
  }
  return one(c.value) ? [] : [problem('value', `"${c.operator}" needs ${kind}.`)];
}

function number(v: DocumentValues[string]): Dec | null {
  return typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v) ? dec(v) : null;
}

/**
 * Whether a document satisfies a condition. A field the document has no value for satisfies nothing but
 * `not_in` and `is_false`: an absent amount is never "at least" anything.
 */
export function evaluateCondition(c: Condition, values: DocumentValues): boolean {
  const actual = values[c.field];
  if (c.operator === 'is_true') return actual === true || actual === 'true';
  if (c.operator === 'is_false') return !(actual === true || actual === 'true');
  if (COMPARISONS.has(c.operator) || c.operator === 'between') {
    const n = number(actual);
    if (n === null) return false;
    if (c.operator === 'between') {
      const [from, to] = c.value as readonly string[];
      return from !== undefined && to !== undefined && n.gte(dec(from)) && n.lte(dec(to));
    }
    const limit = dec(c.value as string);
    if (c.operator === 'lt') return n.lt(limit);
    if (c.operator === 'lte') return n.lte(limit);
    if (c.operator === 'gt') return n.gt(limit);
    return n.gte(limit);
  }
  const text = actual === null || actual === undefined ? null : String(actual);
  if (c.operator === 'eq') return text !== null && text === c.value;
  const list = c.value as readonly string[];
  return c.operator === 'in' ? text !== null && list.includes(text) : text === null || !list.includes(text);
}

/** All of them (AND). An empty list is always satisfied. */
export function evaluateAll(conditions: readonly Condition[], values: DocumentValues): boolean {
  return conditions.every((c) => evaluateCondition(c, values));
}

/** A numeric condition as an inclusive-or-exclusive range, for the ladder check. */
export interface Range {
  readonly low: Dec | null;
  readonly lowInclusive: boolean;
  readonly high: Dec | null;
  readonly highInclusive: boolean;
}

export function rangeOf(c: Condition): Range | null {
  if (c.operator === 'between') {
    const [from, to] = c.value as readonly string[];
    if (from === undefined || to === undefined) return null;
    return { low: dec(from), lowInclusive: true, high: dec(to), highInclusive: true };
  }
  if (!COMPARISONS.has(c.operator)) return null;
  const n = dec(c.value as string);
  if (c.operator === 'gt' || c.operator === 'gte') {
    return { low: n, lowInclusive: c.operator === 'gte', high: null, highInclusive: false };
  }
  return { low: null, lowInclusive: false, high: n, highInclusive: c.operator === 'lte' };
}

/** Whether a's upper end lies below b's lower end: the two ranges share no value. */
function below(a: Range, b: Range): boolean {
  if (a.high === null || b.low === null) return false;
  return a.high.lt(b.low) || (a.high.eq(b.low) && !(a.highInclusive && b.lowInclusive));
}
export const rangesDisjoint = (a: Range, b: Range): boolean => below(a, b) || below(b, a);

/** Whether every value of `inner` is also in `outer`. */
export function rangeWithin(inner: Range, outer: Range): boolean {
  const lowOk =
    outer.low === null ||
    (inner.low !== null &&
      (inner.low.gt(outer.low) || (inner.low.eq(outer.low) && (outer.lowInclusive || !inner.lowInclusive))));
  const highOk =
    outer.high === null ||
    (inner.high !== null &&
      (inner.high.lt(outer.high) ||
        (inner.high.eq(outer.high) && (outer.highInclusive || !inner.highInclusive))));
  return lowOk && highOk;
}
