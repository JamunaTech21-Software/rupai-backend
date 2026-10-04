import type { Request, Response } from 'express';

import { getRequestContext } from '../context/request-context.js';
import { etagFor } from './concurrency.js';
import type { ScopeView } from '../scope/scope.js';
import type { CursorPage, PagePagination } from './list-query.js';

/**
 * The two response shapes (Spec P4 §2.4). There is no third, and no endpoint returns a bare array.
 *
 *   single:     { data: {...}, meta: { request_id, server_time } }
 *   collection: { data: [...], meta: { request_id, pagination | cursor, applied_scope? }, links? }
 */

/**
 * `meta.applied_scope` on a list of a scoped resource (P4 §2.4): the scope the rows were filtered by,
 * so the client can say "showing Estate A and Estate C". Build it with `appliedScope()` (core/scope).
 */
export type AppliedScope = Readonly<Partial<ScopeView>>;

function baseMeta(): { request_id: string; server_time: string } {
  return {
    request_id: getRequestContext()?.requestId ?? '',
    server_time: new Date().toISOString(),
  };
}

/** 200 (or the given status) with a single resource. Sets ETag when the resource is versioned. */
export function sendOne(
  res: Response,
  data: unknown,
  options: { status?: number; version?: number; location?: string } = {},
): void {
  if (options.version !== undefined) res.setHeader('ETag', etagFor(options.version));
  if (options.location) res.setHeader('Location', options.location);
  res.status(options.status ?? 200).json({ data, meta: baseMeta() });
}

/** 201 Created with the resource and a Location header (Spec P4 §2.7). */
export function sendCreated(res: Response, data: unknown, location: string, version?: number): void {
  sendOne(res, data, { status: 201, location, ...(version !== undefined ? { version } : {}) });
}

/** 202 Accepted with a job resource, for deferred work (Spec P4 §5.3). */
export function sendAccepted(res: Response, job: unknown): void {
  sendOne(res, job, { status: 202 });
}

/** 204 No Content (successful draft deletion). */
export function sendNoContent(res: Response): void {
  res.status(204).end();
}

function pageLink(req: Request, page: number, perPage: number): string {
  const url = new URL(req.originalUrl, 'http://placeholder');
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(perPage));
  return `${url.pathname}${url.search}`;
}

/** A page-based collection with pagination meta and first/prev/next/last links. */
export function sendPage(
  req: Request,
  res: Response,
  items: readonly unknown[],
  page: { pagination: PagePagination; total: number; appliedScope?: AppliedScope },
): void {
  const { page: current, perPage } = page.pagination;
  const lastPage = Math.max(1, Math.ceil(page.total / perPage));
  res.status(200).json({
    data: items,
    meta: {
      ...baseMeta(),
      pagination: { page: current, per_page: perPage, total: page.total, last_page: lastPage },
      ...(page.appliedScope ? { applied_scope: page.appliedScope } : {}),
    },
    links: {
      first: pageLink(req, 1, perPage),
      prev: current > 1 ? pageLink(req, current - 1, perPage) : null,
      next: current < lastPage ? pageLink(req, current + 1, perPage) : null,
      last: pageLink(req, lastPage, perPage),
    },
  });
}

/**
 * A cursor-paginated collection, used on the five very-high-growth tables (Spec P4 §2.5). No total
 * is computed, which is deliberate: the client shows what has loaded and whether more exists.
 */
export function sendCursorPage(
  res: Response,
  items: readonly unknown[],
  page: { cursor: CursorPage; nextCursor: string | null; appliedScope?: AppliedScope },
): void {
  res.status(200).json({
    data: items,
    meta: {
      ...baseMeta(),
      cursor: { limit: page.cursor.limit, next_cursor: page.nextCursor },
      ...(page.appliedScope ? { applied_scope: page.appliedScope } : {}),
    },
  });
}
