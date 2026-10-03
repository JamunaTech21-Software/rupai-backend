import qs from 'qs';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors/app-error.js';
import { parseListQuery, type ListQuerySpec } from '../../src/core/http/list-query.js';

const SALES: ListQuerySpec = {
  filters: {
    state: { type: { enum: ['draft', 'submitted', 'approved'] } },
    sale_date: { type: 'date' },
    buyer_id: { type: 'id' },
    net_amount: { type: 'decimal' },
    name: { type: 'string', ops: ['eq', 'like'] },
    separation_date: { type: 'date', ops: ['null'] },
  },
  sorts: ['sale_date', 'sale_number'],
  defaultSort: ['-sale_date'],
  includes: ['lines', 'buyer'],
  fields: { sales: ['id', 'sale_number', 'net_amount'] },
  pagination: 'page',
};

/** Parses a query string exactly as the app's query parser does. */
const q = (s: string) =>
  qs.parse(s, { depth: 2, arrayLimit: 0, parameterLimit: 100 }) as Record<string, unknown>;

function err(fn: () => unknown): AppError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AppError) return e;
    throw e;
  }
  throw new Error('expected an AppError');
}

describe('filters (Spec P4 §2.6)', () => {
  it('parses equals, in, range, like and null', () => {
    const r = parseListQuery(
      q(
        'filter[state][in]=draft,submitted&filter[buyer_id]=214&filter[sale_date][from]=2026-04-01' +
          '&filter[sale_date][to]=2026-06-30&filter[name][like]=Kar&filter[separation_date][null]=true',
      ),
      SALES,
    );
    expect(r.filters).toEqual([
      { field: 'state', op: 'in', value: ['draft', 'submitted'] },
      { field: 'buyer_id', op: 'eq', value: '214' },
      { field: 'sale_date', op: 'from', value: '2026-04-01' },
      { field: 'sale_date', op: 'to', value: '2026-06-30' },
      { field: 'name', op: 'like', value: 'Kar' },
      { field: 'separation_date', op: 'null', value: true },
    ]);
  });

  it('keeps decimal filter values as strings (never floats)', () => {
    const r = parseListQuery(q('filter[net_amount][from]=12345.6700'), SALES);
    expect(r.filters[0]?.value).toBe('12345.6700');
  });

  it('refuses an unknown filter with 422 UNKNOWN_FILTER and lists the permitted fields', () => {
    const e = err(() => parseListQuery(q('filter[password]=x'), SALES));
    expect(e.status).toBe(422);
    expect(e.code).toBe('UNKNOWN_FILTER');
    expect(e.details[0]).toMatchObject({ field: 'filter[password]' });
    expect(e.details[0]?.context?.permitted).toEqual(Object.keys(SALES.filters ?? {}));
  });

  it('refuses an operator the field does not allow', () => {
    const e = err(() => parseListQuery(q('filter[state][like]=app'), SALES));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details[0]?.field).toBe('filter[state][like]');
  });

  it.each([
    ['filter[sale_date][from]=2026-02-30', 'filter[sale_date][from]', 'YYYY-MM-DD'],
    ['filter[buyer_id]=abc', 'filter[buyer_id]', 'numeric identifier'],
    ['filter[net_amount]=1e5', 'filter[net_amount]', 'decimal'],
    ['filter[state]=archived', 'filter[state]', 'one of'],
    ['filter[separation_date][null]=yes', 'filter[separation_date][null]', 'true or false'],
  ])('rejects a malformed value: %s', (query, field, msg) => {
    const e = err(() => parseListQuery(q(query), SALES));
    expect(e.code).toBe('VALIDATION_FAILED');
    expect(e.details[0]?.field).toBe(field);
    expect(e.details[0]?.message).toContain(msg);
  });

  it('refuses a repeated parameter instead of picking one', () => {
    const e = err(() => parseListQuery(q('filter[state]=draft&filter[state]=approved'), SALES));
    expect(e.code).toBe('VALIDATION_FAILED');
  });

  it('refuses unknown top-level query parameters', () => {
    const e = err(() => parseListQuery(q('limit=5'), SALES));
    expect(e.details[0]).toMatchObject({ field: 'limit' });
  });
});

describe('sort, include and fields', () => {
  it('applies the default sort when none is given', () => {
    expect(parseListQuery({}, SALES).sort).toEqual([{ field: 'sale_date', direction: 'desc' }]);
  });

  it('parses ascending and descending terms', () => {
    expect(parseListQuery(q('sort=-sale_number,sale_date'), SALES).sort).toEqual([
      { field: 'sale_number', direction: 'desc' },
      { field: 'sale_date', direction: 'asc' },
    ]);
  });

  it('refuses a non-indexed sort with 422 UNKNOWN_SORT', () => {
    const e = err(() => parseListQuery(q('sort=remarks'), SALES));
    expect(e.code).toBe('UNKNOWN_SORT');
    expect(e.details[0]?.context?.permitted).toEqual(['sale_date', 'sale_number']);
  });

  it('accepts allow-listed includes and refuses others with 422 UNKNOWN_INCLUDE', () => {
    expect(parseListQuery(q('include=lines,buyer'), SALES).include).toEqual(['lines', 'buyer']);
    expect(err(() => parseListQuery(q('include=journal'), SALES)).code).toBe('UNKNOWN_INCLUDE');
  });

  it('accepts allow-listed sparse fields and refuses unknown attributes', () => {
    expect(parseListQuery(q('fields[sales]=id,net_amount'), SALES).fields).toEqual({
      sales: ['id', 'net_amount'],
    });
    expect(err(() => parseListQuery(q('fields[sales]=id,cost_price'), SALES)).code).toBe('VALIDATION_FAILED');
  });
});

describe('pagination (Spec P4 §2.5)', () => {
  it('defaults to page 1 of 25', () => {
    expect(parseListQuery({}, SALES).page).toEqual({ page: 1, perPage: 25 });
  });

  it('clamps per_page above 200 instead of rejecting, and remembers what was asked', () => {
    expect(parseListQuery(q('page=3&per_page=500'), SALES).page).toEqual({
      page: 3,
      perPage: 200,
      requestedPerPage: 500,
    });
  });

  it.each(['page=0', 'page=-1', 'per_page=abc'])('rejects %s', (query) => {
    expect(err(() => parseListQuery(q(query), SALES)).code).toBe('VALIDATION_FAILED');
  });

  const MOVEMENTS: ListQuerySpec = {
    filters: { moved_at: { type: 'datetime' } },
    sorts: ['moved_at'],
    pagination: 'cursor',
    rangeRequired: 'moved_at',
  };
  const range = 'filter[moved_at][from]=2026-06-01T00:00:00Z&filter[moved_at][to]=2026-06-30T23:59:59Z';

  it('uses cursor pagination on high-volume lists', () => {
    expect(parseListQuery(q(`${range}&cursor=abc_123-X&limit=500`), MOVEMENTS).cursor).toEqual({
      cursor: 'abc_123-X',
      limit: 200,
    });
  });

  it('refuses page parameters on a cursor list', () => {
    expect(err(() => parseListQuery(q(`${range}&page=2`), MOVEMENTS)).details[0]?.field).toBe('page');
  });

  it('requires a bounded range on very-high-growth tables: 422 RANGE_REQUIRED', () => {
    const e = err(() => parseListQuery(q('filter[moved_at][from]=2026-06-01T00:00:00Z'), MOVEMENTS));
    expect(e.code).toBe('RANGE_REQUIRED');
  });

  it('requires a UTC offset on timestamps (the server never infers a timezone)', () => {
    const e = err(() =>
      parseListQuery(
        q('filter[moved_at][from]=2026-06-01T00:00:00&filter[moved_at][to]=2026-06-30T00:00:00Z'),
        MOVEMENTS,
      ),
    );
    expect(e.details[0]?.message).toContain('UTC offset');
  });
});
