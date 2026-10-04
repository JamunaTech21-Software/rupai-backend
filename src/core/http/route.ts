import { Router, type RequestHandler } from 'express';
import type { z } from 'zod';

import type { ApiModule } from '../../app.js';
import { requirePermission, requireSignedIn, type PermissionResolver } from '../auth/authorize.js';
import type { ErrorCode } from '../errors/codes.js';
import type { Platform } from '../platform.js';
import { idempotency } from './idempotency.js';
import { listQuery, type ListQuerySpec } from './list-query.js';
import { validate } from './validate.js';

/**
 * Declarative routes (P0.07). Every endpoint is declared ONCE, with everything Spec P4 requires it to
 * state, and both the Express route and its OpenAPI documentation are generated from that declaration,
 * so the docs cannot drift from the code (P4 §18.4).
 *
 * A declaration MUST state (checked at start-up, so CI fails on an omission):
 *   - its permission (`auth: { permission: 'sale.approve' }`), or why it is public
 *   - its filterable / sortable / includable fields, if it is a list (`list`)
 *   - the business error codes it can return (`errors`), even if there are none (`[]`)
 */

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type RouteAuth =
  | { readonly permission: string }
  /**
   * Any signed-in user, no permission: the caller's own account (profile, sessions, password). Still
   * usable while a temporary password must be changed. Must say why no permission applies.
   */
  | { readonly signedIn: true; readonly reason: string }
  /** Public endpoints are rare (login, password reset) and must say why. */
  | { readonly public: true; readonly reason: string };

export interface RouteSuccess {
  readonly status: 200 | 201 | 202 | 204;
  readonly description: string;
  /** Schema of `data` (or of one item, for lists). Omit for 204. */
  readonly schema?: z.ZodType;
}

export interface RouteSpec {
  readonly method: HttpMethod;
  /** Express-style path relative to the module, e.g. '/', '/:id', '/:id/approve'. */
  readonly path: string;
  readonly summary: string;
  readonly description?: string;
  readonly auth: RouteAuth;
  /** Route-specific middleware that runs first, e.g. the stricter auth rate limit classes (P4 §2.9). */
  readonly before?: readonly RequestHandler[];
  readonly params?: z.ZodObject;
  /** Non-list query parameters. Lists use `list` instead. */
  readonly query?: z.ZodObject;
  readonly body?: z.ZodType;
  readonly list?: ListQuerySpec;
  /** The handler requires If-Match (versioned mutation, P4 §5.1). Documents the header and the 409/422. */
  readonly ifMatch?: boolean;
  /** Accept (or require) an Idempotency-Key (P4 §5.2). Transition endpoints use this. */
  readonly idempotent?: boolean | 'required';
  readonly success: RouteSuccess;
  /** Business error codes this endpoint can return. Generic ones (validation, auth, rate limit) are added. */
  readonly errors: readonly ErrorCode[];
  readonly handler: RequestHandler;
}

export interface DeclaredRoute extends RouteSpec {
  /** Full path as served, e.g. /api/v1/widgets/:id */
  readonly fullPath: string;
  readonly tag: string;
}

const PERMISSION = /^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/;

/** Start-up check: refuses a declaration that omits something P4 requires. */
export function assertWellDeclared(route: DeclaredRoute): void {
  const where = `${route.method.toUpperCase()} ${route.fullPath}`;
  const problems: string[] = [];
  if (!route.summary.trim()) problems.push('summary is required');
  if ('permission' in route.auth) {
    if (!PERMISSION.test(route.auth.permission)) {
      problems.push(`permission "${route.auth.permission}" must be module.action, e.g. sale.approve`);
    }
  } else if (!route.auth.reason.trim()) {
    problems.push('a public or signed-in endpoint must give a reason');
  }
  if (!Array.isArray(route.errors)) problems.push('errors must be declared (use [] when there are none)');
  if (route.list) {
    if (route.method !== 'get') problems.push('list declarations are only valid on GET');
    if (route.query) problems.push('use either list or query, not both');
    if (route.list.filters === undefined) problems.push('a list must declare its filters (use {} for none)');
    if (route.list.sorts === undefined) problems.push('a list must declare its sorts (use [] for none)');
  }
  if (route.success.status === 204 && route.success.schema)
    problems.push('a 204 response has no body schema');
  if (problems.length > 0)
    throw new Error(`Route ${where} is not well declared:\n  - ${problems.join('\n  - ')}`);
}

/** The error codes the generic middleware can produce for a route, in addition to its business errors. */
export function implicitErrors(route: RouteSpec): ErrorCode[] {
  const codes: ErrorCode[] = ['MALFORMED_REQUEST', 'RATE_LIMITED', 'INTERNAL_ERROR'];
  if ('permission' in route.auth) {
    codes.push('UNAUTHENTICATED', 'SESSION_EXPIRED', 'PERMISSION_DENIED', 'PASSWORD_CHANGE_REQUIRED');
  }
  if ('signedIn' in route.auth) codes.push('UNAUTHENTICATED', 'SESSION_EXPIRED');
  if (route.params) codes.push('NOT_FOUND');
  if (route.params || route.query || route.body || route.list) codes.push('VALIDATION_FAILED');
  if (route.body) codes.push('PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE');
  if (route.list) {
    codes.push('UNKNOWN_FILTER', 'UNKNOWN_SORT', 'UNKNOWN_INCLUDE');
    if (route.list.rangeRequired) codes.push('RANGE_REQUIRED');
  }
  if (route.ifMatch) codes.push('PRECONDITION_REQUIRED', 'VERSION_CONFLICT');
  if (route.idempotent) codes.push('IDEMPOTENCY_KEY_REUSED', 'IDEMPOTENCY_IN_PROGRESS');
  return codes;
}

export interface ModuleBuilder {
  route(spec: RouteSpec): ModuleBuilder;
  build(): ApiModule;
}

/**
 * Defines a module's routes. Usage:
 *
 *   const m = defineModule({ name: 'estates', path: '/estates', tag: 'Estates', platform });
 *   m.route({ method: 'get', path: '/', summary: 'List estates', auth: { permission: 'estate.view' },
 *             list: { filters: {...}, sorts: [...], pagination: 'page' }, success: {...}, errors: [],
 *             handler });
 *   export const estatesModule = m.build();
 *
 * `auth` is enforced here (P1.01): a permission route answers 401 without an authenticated user and
 * 403 PERMISSION_DENIED without the permission, BEFORE the request is validated, so an unauthorised
 * caller learns nothing about the endpoint's input. Scope (which records) is applied in the
 * data-access layer from P1.03.
 */
export function defineModule(opts: {
  name: string;
  path: string;
  tag: string;
  platform: Platform;
  /** Resolves the caller's permissions. Required: a module cannot be built without authorisation. */
  authz: PermissionResolver;
}): ModuleBuilder {
  const router = Router();
  const routes: DeclaredRoute[] = [];
  const base = opts.path === '/' ? '' : opts.path;

  const builder: ModuleBuilder = {
    route(spec) {
      const declared: DeclaredRoute = {
        ...spec,
        fullPath: `/api/v1${base}${spec.path === '/' ? '' : spec.path}`,
        tag: opts.tag,
      };
      assertWellDeclared(declared);

      const chain: RequestHandler[] = [...(spec.before ?? [])];
      if ('permission' in spec.auth) chain.push(requirePermission(opts.authz, spec.auth.permission));
      if ('signedIn' in spec.auth) chain.push(requireSignedIn());
      if (spec.idempotent) {
        chain.push(
          idempotency({ store: opts.platform.idempotencyStore, required: spec.idempotent === 'required' }),
        );
      }
      if (spec.params || spec.body || spec.query) {
        chain.push(
          validate({
            ...(spec.params ? { params: spec.params } : {}),
            ...(spec.query ? { query: spec.query } : {}),
            ...(spec.body ? { body: spec.body } : {}),
          }),
        );
      }
      if (spec.list) chain.push(listQuery(spec.list));
      router[spec.method](spec.path, ...chain, spec.handler);
      routes.push(declared);
      return builder;
    },
    build() {
      return { name: opts.name, path: opts.path, router, routes };
    },
  };
  return builder;
}
