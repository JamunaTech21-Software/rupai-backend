import type { RequestHandler, Response } from 'express';

import { AppError, Errors, type ErrorDetail } from '../errors/app-error.js';

/**
 * Query grammar for every list endpoint (Spec P4 §2.5, §2.6):
 *
 *   filter[field]=v            equals
 *   filter[field][in]=a,b      one of
 *   filter[field][from]=…      range, inclusive (and/or [to])
 *   filter[field][like]=v      prefix match, only on fields that opt in (indexed text)
 *   filter[field][null]=true   is null / is not null
 *   sort=field,-other          ascending / descending, only declared index-backed fields
 *   include=rel,rel            related resources from a per-endpoint allow-list (prevents N+1)
 *   fields[resource]=a,b,c     sparse attributes
 *   page=2&per_page=50         page-based (default 25, max 200, clamped — not rejected)
 *   cursor=…&limit=…           cursor-based, for the very-high-growth tables
 *
 * Anything not declared is REFUSED with 422, never ignored. A silently ignored filter produces a wrong
 * answer the user trusts.
 */

export type FilterOp = 'eq' | 'in' | 'from' | 'to' | 'like' | 'null';
export type FilterType =
  | 'string'
  | 'int'
  | 'decimal'
  | 'date'
  | 'datetime'
  | 'bool'
  | 'id'
  | 'ulid'
  | { readonly enum: readonly string[] };

export interface FilterSpec {
  readonly type: FilterType;
  /** Operators allowed for this field. Defaults depend on the type. `like` must be opted into. */
  readonly ops?: readonly FilterOp[];
}

export interface ListQuerySpec {
  readonly filters?: Readonly<Record<string, FilterSpec>>;
  /** Sortable fields. Each must be backed by an index (Spec P4 §2.6). */
  readonly sorts?: readonly string[];
  /** Applied when the client sends no sort, e.g. ['-created_at']. */
  readonly defaultSort?: readonly string[];
  readonly includes?: readonly string[];
  /** fields[resource] allow-list: resource name → selectable attributes. */
  readonly fields?: Readonly<Record<string, readonly string[]>>;
  readonly pagination: 'page' | 'cursor';
  /** The very-high-growth tables require a bounded range on this field (Spec P4 §2.5). */
  readonly rangeRequired?: string;
  readonly defaultPageSize?: number;
  readonly maxPageSize?: number;
}

export type FilterValue = string | number | boolean | readonly (string | number)[];
export interface Filter {
  readonly field: string;
  readonly op: FilterOp;
  readonly value: FilterValue;
}
export interface SortTerm {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}
export interface PagePagination {
  readonly page: number;
  readonly perPage: number;
  /** The per_page the client asked for, when it was clamped. Lets callers report the applied value. */
  readonly requestedPerPage?: number;
}
export interface CursorPage {
  readonly cursor: string | null;
  readonly limit: number;
}
export interface ListQuery {
  readonly filters: readonly Filter[];
  readonly sort: readonly SortTerm[];
  readonly include: readonly string[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly page?: PagePagination;
  readonly cursor?: CursorPage;
}

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const MAX_IN_VALUES = 100;
const MAX_CURSOR_LENGTH = 512;
const PAGE_KEYS = ['page', 'per_page'] as const;
const CURSOR_KEYS = ['cursor', 'limit'] as const;

function defaultOps(type: FilterType): readonly FilterOp[] {
  if (typeof type === 'object') return ['eq', 'in', 'null'];
  switch (type) {
    case 'int':
    case 'decimal':
    case 'date':
    case 'datetime':
      return ['eq', 'in', 'from', 'to', 'null'];
    case 'bool':
      return ['eq', 'null'];
    case 'string':
    case 'id':
    case 'ulid':
      return ['eq', 'in', 'null'];
  }
}

const RE = {
  int: /^-?\d{1,15}$/,
  decimal: /^-?\d{1,18}(?:\.\d{1,8})?$/,
  id: /^\d{1,20}$/,
  ulid: /^[0-9A-HJKMNP-TV-Z]{26}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/,
};

function isValidDate(v: string): boolean {
  if (!RE.date.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

function typeLabel(type: FilterType): string {
  return typeof type === 'object' ? `one of ${type.enum.join(', ')}` : type;
}

/** Coerces one raw value to its declared type, or returns an error message. */
function coerce(type: FilterType, raw: string): { value: string | number | boolean } | { error: string } {
  if (typeof type === 'object') {
    return type.enum.includes(raw) ? { value: raw } : { error: `must be ${typeLabel(type)}` };
  }
  switch (type) {
    case 'string':
      return raw.length > 0 && raw.length <= 200 ? { value: raw } : { error: 'must be 1–200 characters' };
    case 'int':
      return RE.int.test(raw) ? { value: Number.parseInt(raw, 10) } : { error: 'must be an integer' };
    case 'decimal':
      // Kept as a string: money and quantities never become floats (Spec P4 §2.3).
      return RE.decimal.test(raw) ? { value: raw } : { error: 'must be a decimal number, e.g. 1250.500' };
    case 'id':
      return RE.id.test(raw) ? { value: raw } : { error: 'must be a numeric identifier' };
    case 'ulid':
      return RE.ulid.test(raw) ? { value: raw } : { error: 'must be a 26-character ULID' };
    case 'date':
      return isValidDate(raw) ? { value: raw } : { error: 'must be a date in YYYY-MM-DD form' };
    case 'datetime':
      return RE.datetime.test(raw) && !Number.isNaN(Date.parse(raw))
        ? { value: raw }
        : { error: 'must be an ISO 8601 timestamp with a UTC offset' };
    case 'bool':
      return raw === 'true' || raw === 'false'
        ? { value: raw === 'true' }
        : { error: 'must be true or false' };
  }
}

/** Reads a scalar query value. Repeated parameters (arrays) and nested objects are refused. */
function scalar(raw: unknown, name: string, problems: ErrorDetail[]): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return raw;
  problems.push({ field: name, code: 'VALIDATION_FAILED', message: 'must be given once, as a single value' });
  return undefined;
}

function parseFilters(raw: unknown, spec: ListQuerySpec, problems: ErrorDetail[]): Filter[] {
  if (raw === undefined) return [];
  if (typeof raw !== 'object' || Array.isArray(raw) || raw === null) {
    throw Errors.malformed('filter must be written as filter[field]=value.');
  }
  const declared = spec.filters ?? {};
  const permitted = Object.keys(declared);
  const unknown = Object.keys(raw).filter((f) => !(f in declared));
  if (unknown.length > 0) {
    throw new AppError(
      'UNKNOWN_FILTER',
      `Filtering is not supported on: ${unknown.join(', ')}.`,
      unknown.map((f) => ({
        field: `filter[${f}]`,
        code: 'UNKNOWN_FILTER',
        message: `Not a filterable field. Permitted: ${permitted.join(', ') || 'none'}.`,
        context: { permitted },
      })),
    );
  }

  const filters: Filter[] = [];
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    const fspec = declared[field];
    if (!fspec) continue;
    const ops = fspec.ops ?? defaultOps(fspec.type);
    const entries: [FilterOp, unknown][] =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (Object.entries(value) as [FilterOp, unknown][])
        : [['eq', value]];

    for (const [op, rawOpValue] of entries) {
      const name = op === 'eq' ? `filter[${field}]` : `filter[${field}][${op}]`;
      if (!ops.includes(op)) {
        problems.push({
          field: name,
          code: 'VALIDATION_FAILED',
          message: `Operator "${op}" is not supported on ${field}. Permitted: ${ops.join(', ')}.`,
          context: { permitted: ops },
        });
        continue;
      }
      const v = scalar(rawOpValue, name, problems);
      if (v === undefined) continue;

      if (op === 'null') {
        if (v !== 'true' && v !== 'false') {
          problems.push({ field: name, code: 'VALIDATION_FAILED', message: 'must be true or false' });
        } else filters.push({ field, op, value: v === 'true' });
        continue;
      }
      if (op === 'like') {
        if (v.length < 1 || v.length > 100) {
          problems.push({ field: name, code: 'VALIDATION_FAILED', message: 'must be 1–100 characters' });
        } else filters.push({ field, op, value: v });
        continue;
      }
      if (op === 'in') {
        const parts = v.split(',');
        if (parts.length > MAX_IN_VALUES) {
          problems.push({
            field: name,
            code: 'VALIDATION_FAILED',
            message: `at most ${MAX_IN_VALUES} values`,
          });
          continue;
        }
        const values: (string | number)[] = [];
        for (const part of parts) {
          const c = coerce(fspec.type, part);
          if ('error' in c) {
            problems.push({ field: name, code: 'VALIDATION_FAILED', message: `"${part}" ${c.error}` });
          } else if (typeof c.value !== 'boolean') values.push(c.value);
        }
        filters.push({ field, op, value: values });
        continue;
      }
      const c = coerce(fspec.type, v);
      if ('error' in c) problems.push({ field: name, code: 'VALIDATION_FAILED', message: c.error });
      else filters.push({ field, op, value: c.value });
    }
  }
  return filters;
}

function parseSort(raw: string | undefined, spec: ListQuerySpec, problems: ErrorDetail[]): SortTerm[] {
  const terms = raw === undefined || raw === '' ? [...(spec.defaultSort ?? [])] : raw.split(',');
  const permitted = spec.sorts ?? [];
  const seen = new Set<string>();
  const out: SortTerm[] = [];
  const unknown: string[] = [];
  for (const term of terms) {
    const desc = term.startsWith('-');
    const field = desc ? term.slice(1) : term;
    if (
      !permitted.includes(field) &&
      !(spec.defaultSort ?? []).map((s) => s.replace(/^-/, '')).includes(field)
    ) {
      unknown.push(field);
      continue;
    }
    if (seen.has(field)) {
      problems.push({
        field: 'sort',
        code: 'VALIDATION_FAILED',
        message: `"${field}" appears more than once`,
      });
      continue;
    }
    seen.add(field);
    out.push({ field, direction: desc ? 'desc' : 'asc' });
  }
  if (unknown.length > 0) {
    throw new AppError('UNKNOWN_SORT', `Sorting is not supported on: ${unknown.join(', ')}.`, [
      {
        field: 'sort',
        code: 'UNKNOWN_SORT',
        message: `Permitted: ${permitted.join(', ') || 'none'}.`,
        context: { permitted },
      },
    ]);
  }
  return out;
}

function parseInclude(raw: string | undefined, spec: ListQuerySpec): string[] {
  if (raw === undefined || raw === '') return [];
  const permitted = spec.includes ?? [];
  const requested = [...new Set(raw.split(','))];
  const unknown = requested.filter((r) => !permitted.includes(r));
  if (unknown.length > 0) {
    throw new AppError('UNKNOWN_INCLUDE', `Cannot include: ${unknown.join(', ')}.`, [
      {
        field: 'include',
        code: 'UNKNOWN_INCLUDE',
        message: `Permitted: ${permitted.join(', ') || 'none'}.`,
        context: { permitted },
      },
    ]);
  }
  return requested;
}

function parseFields(raw: unknown, spec: ListQuerySpec, problems: ErrorDetail[]): Record<string, string[]> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw Errors.malformed('fields must be written as fields[resource]=a,b.');
  }
  const out: Record<string, string[]> = {};
  for (const [resource, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = `fields[${resource}]`;
    const allowed = spec.fields?.[resource];
    if (!allowed) {
      problems.push({ field: name, code: 'VALIDATION_FAILED', message: `Unknown resource "${resource}".` });
      continue;
    }
    const v = scalar(value, name, problems);
    if (v === undefined) continue;
    const requested = v.split(',');
    const bad = requested.filter((f) => !allowed.includes(f));
    if (bad.length > 0) {
      problems.push({
        field: name,
        code: 'VALIDATION_FAILED',
        message: `Unknown attributes: ${bad.join(', ')}. Permitted: ${allowed.join(', ')}.`,
        context: { permitted: allowed },
      });
      continue;
    }
    out[resource] = requested;
  }
  return out;
}

function positiveInt(raw: string | undefined, name: string, problems: ErrorDetail[]): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d{1,9}$/.test(raw) || Number.parseInt(raw, 10) < 1) {
    problems.push({ field: name, code: 'VALIDATION_FAILED', message: 'must be a positive integer' });
    return undefined;
  }
  return Number.parseInt(raw, 10);
}

/**
 * Parses and validates a list query against the endpoint's declared spec.
 * @throws AppError UNKNOWN_FILTER / UNKNOWN_SORT / UNKNOWN_INCLUDE / RANGE_REQUIRED / VALIDATION_FAILED
 */
export function parseListQuery(query: Record<string, unknown>, spec: ListQuerySpec): ListQuery {
  const problems: ErrorDetail[] = [];
  const allowedKeys = new Set<string>([
    'filter',
    'sort',
    'include',
    'fields',
    ...(spec.pagination === 'page' ? PAGE_KEYS : CURSOR_KEYS),
  ]);
  const unknownKeys = Object.keys(query).filter((k) => !allowedKeys.has(k));
  for (const k of unknownKeys) {
    problems.push({
      field: k,
      code: 'VALIDATION_FAILED',
      message: `Unknown query parameter. Permitted: ${[...allowedKeys].join(', ')}.`,
    });
  }

  const filters = parseFilters(query.filter, spec, problems);
  const sort = parseSort(scalar(query.sort, 'sort', problems), spec, problems);
  const include = parseInclude(scalar(query.include, 'include', problems), spec);
  const fields = parseFields(query.fields, spec, problems);

  const max = spec.maxPageSize ?? MAX_PAGE_SIZE;
  let page: PagePagination | undefined;
  let cursor: CursorPage | undefined;
  if (spec.pagination === 'page') {
    const p = positiveInt(scalar(query.page, 'page', problems), 'page', problems) ?? 1;
    const requested =
      positiveInt(scalar(query.per_page, 'per_page', problems), 'per_page', problems) ??
      spec.defaultPageSize ??
      DEFAULT_PAGE_SIZE;
    // Clamped, not rejected; the applied value is returned in meta (Spec P4 §2.5).
    page = {
      page: p,
      perPage: Math.min(requested, max),
      ...(requested > max ? { requestedPerPage: requested } : {}),
    };
  } else {
    const c = scalar(query.cursor, 'cursor', problems);
    if (c !== undefined && (c.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(c))) {
      problems.push({ field: 'cursor', code: 'VALIDATION_FAILED', message: 'is not a valid cursor' });
    }
    const limit = positiveInt(scalar(query.limit, 'limit', problems), 'limit', problems) ?? 50;
    cursor = { cursor: c ?? null, limit: Math.min(limit, max) };
  }

  if (problems.length > 0) throw Errors.validation(problems, 'The list query is invalid.');

  if (spec.rangeRequired) {
    const f = spec.rangeRequired;
    const hasFrom = filters.some((x) => x.field === f && x.op === 'from');
    const hasTo = filters.some((x) => x.field === f && x.op === 'to');
    if (!hasFrom || !hasTo) {
      throw new AppError('RANGE_REQUIRED', `A bounded range on ${f} is required for this list.`, [
        {
          field: `filter[${f}]`,
          code: 'RANGE_REQUIRED',
          message: `Send both filter[${f}][from] and filter[${f}][to].`,
        },
      ]);
    }
  }

  return { filters, sort, include, fields, ...(page ? { page } : {}), ...(cursor ? { cursor } : {}) };
}

const LIST_QUERY = 'listQuery';

/** Express middleware: parses the list query for this route and stores it for the controller. */
export function listQuery(spec: ListQuerySpec): RequestHandler {
  return (req, res, next) => {
    res.locals[LIST_QUERY] = parseListQuery(req.query, spec);
    next();
  };
}

/** The parsed list query for the current request (set by `listQuery()`). */
export function getListQuery(res: Response): ListQuery {
  const q = res.locals[LIST_QUERY] as ListQuery | undefined;
  if (!q) throw new Error('listQuery() middleware was not mounted on this route');
  return q;
}
