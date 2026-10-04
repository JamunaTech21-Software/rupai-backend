import { z } from 'zod';

import type { ApiModule } from '../../app.js';
import { ERROR_CODES, type ErrorCode } from '../errors/codes.js';
import type { FilterOp, FilterSpec, FilterType, ListQuerySpec } from './list-query.js';
import { implicitErrors, type DeclaredRoute } from './route.js';

/**
 * Generates the OpenAPI 3.1 document from the declared routes (Spec P4 §18.4). OpenAPI 3.1 uses JSON
 * Schema 2020-12 directly, which is what Zod emits, so request and response schemas are the same Zod
 * schemas that validate at runtime and cannot disagree with them.
 *
 * Postman and Insomnia import this document directly (`npm run docs:openapi` writes it to a file).
 */

type Json = Record<string, unknown>;

function toSchema(schema: z.ZodType): Json {
  return z.toJSONSchema(schema, { io: 'input', target: 'draft-2020-12', unrepresentable: 'any' });
}

function stripMeta(schema: Json): Json {
  const { $schema: _ignored, ...rest } = schema;
  return rest;
}

const expressToOpenApiPath = (p: string) => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function filterSchema(type: FilterType): Json {
  if (typeof type === 'object') return { type: 'string', enum: [...type.enum] };
  switch (type) {
    case 'int':
      return { type: 'integer' };
    case 'decimal':
      return { type: 'string', pattern: '^-?\\d{1,18}(\\.\\d{1,8})?$', description: 'decimal string' };
    case 'date':
      return { type: 'string', format: 'date' };
    case 'datetime':
      return { type: 'string', format: 'date-time', description: 'ISO 8601 with a UTC offset' };
    case 'bool':
      return { type: 'boolean' };
    case 'id':
      return { type: 'string', pattern: '^[1-9]\\d{0,19}$', description: 'numeric id as a string' };
    case 'ulid':
      return { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' };
    case 'string':
      return { type: 'string', maxLength: 200 };
  }
}

const DEFAULT_OPS: Record<string, readonly FilterOp[]> = {
  enum: ['eq', 'in', 'null'],
  int: ['eq', 'in', 'from', 'to', 'null'],
  decimal: ['eq', 'in', 'from', 'to', 'null'],
  date: ['eq', 'in', 'from', 'to', 'null'],
  datetime: ['eq', 'in', 'from', 'to', 'null'],
  bool: ['eq', 'null'],
  string: ['eq', 'in', 'null'],
  id: ['eq', 'in', 'null'],
  ulid: ['eq', 'in', 'null'],
};

function opsFor(spec: FilterSpec): readonly FilterOp[] {
  return spec.ops ?? DEFAULT_OPS[typeof spec.type === 'object' ? 'enum' : spec.type] ?? ['eq'];
}

function listParameters(list: ListQuerySpec): Json[] {
  const params: Json[] = [];
  for (const [field, spec] of Object.entries(list.filters ?? {})) {
    for (const op of opsFor(spec)) {
      const name = op === 'eq' ? `filter[${field}]` : `filter[${field}][${op}]`;
      const schema =
        op === 'in'
          ? { type: 'string', description: 'comma-separated values' }
          : op === 'null'
            ? { type: 'boolean' }
            : filterSchema(spec.type);
      const required = list.rangeRequired === field && (op === 'from' || op === 'to');
      params.push({ name, in: 'query', required, schema });
    }
  }
  if ((list.sorts ?? []).length > 0) {
    params.push({
      name: 'sort',
      in: 'query',
      schema: { type: 'string' },
      description: `Comma-separated; prefix "-" for descending. Sortable: ${(list.sorts ?? []).join(', ')}.${
        list.defaultSort ? ` Default: ${list.defaultSort.join(',')}.` : ''
      }`,
    });
  }
  if ((list.includes ?? []).length > 0) {
    params.push({
      name: 'include',
      in: 'query',
      schema: { type: 'string' },
      description: `Comma-separated related resources: ${(list.includes ?? []).join(', ')}.`,
    });
  }
  for (const [resource, attrs] of Object.entries(list.fields ?? {})) {
    params.push({
      name: `fields[${resource}]`,
      in: 'query',
      schema: { type: 'string' },
      description: `Sparse attributes: ${attrs.join(', ')}.`,
    });
  }
  const max = list.maxPageSize ?? 200;
  if (list.pagination === 'page') {
    params.push({ name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } });
    params.push({
      name: 'per_page',
      in: 'query',
      schema: { type: 'integer', minimum: 1, default: list.defaultPageSize ?? 25 },
      description: `Clamped to ${max}.`,
    });
  } else {
    params.push({ name: 'cursor', in: 'query', schema: { type: 'string' } });
    params.push({
      name: 'limit',
      in: 'query',
      schema: { type: 'integer', minimum: 1, default: 50 },
      description: `Clamped to ${max}.`,
    });
  }
  return params;
}

function objectParameters(schema: z.ZodObject, location: 'path' | 'query'): Json[] {
  const json = toSchema(schema) as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(json.properties ?? {}).map(([name, s]) => ({
    name,
    in: location,
    required: location === 'path' || (json.required ?? []).includes(name),
    schema: s,
  }));
}

function successResponse(route: DeclaredRoute): Json {
  const { success, list } = route;
  if (success.status === 204) return { description: success.description };
  const item = success.schema ? stripMeta(toSchema(success.schema)) : {};
  let body: Json;
  if (list) {
    body = {
      type: 'object',
      required: ['data', 'meta'],
      properties: {
        data: { type: 'array', items: item },
        meta: {
          $ref:
            list.pagination === 'page' ? '#/components/schemas/PageMeta' : '#/components/schemas/CursorMeta',
        },
        ...(list.pagination === 'page' ? { links: { $ref: '#/components/schemas/Links' } } : {}),
      },
    };
  } else {
    body = {
      type: 'object',
      required: ['data', 'meta'],
      properties: { data: item, meta: { $ref: '#/components/schemas/Meta' } },
    };
  }
  const headers: Json = { 'X-Request-Id': { $ref: '#/components/headers/RequestId' } };
  if (route.ifMatch || success.status === 201) headers.ETag = { $ref: '#/components/headers/ETag' };
  if (success.status === 201) headers.Location = { schema: { type: 'string' } };
  return { description: success.description, headers, content: { 'application/json': { schema: body } } };
}

function errorResponses(route: DeclaredRoute): Record<string, Json> {
  const codes = [...new Set<ErrorCode>([...implicitErrors(route), ...route.errors])];
  const byStatus = new Map<number, ErrorCode[]>();
  for (const c of codes) byStatus.set(ERROR_CODES[c], [...(byStatus.get(ERROR_CODES[c]) ?? []), c]);
  const out: Record<string, Json> = {};
  for (const [status, list] of [...byStatus.entries()].sort(([a], [b]) => a - b)) {
    out[String(status)] = {
      description: `Error codes: ${list.join(', ')}`,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
    };
  }
  return out;
}

function operation(route: DeclaredRoute): Json {
  const parameters: Json[] = [];
  if (route.params) parameters.push(...objectParameters(route.params, 'path'));
  if (route.query) parameters.push(...objectParameters(route.query, 'query'));
  if (route.list) parameters.push(...listParameters(route.list));
  if (route.ifMatch) parameters.push({ $ref: '#/components/parameters/IfMatch' });
  if (route.idempotent) {
    parameters.push(
      route.idempotent === 'required'
        ? { $ref: '#/components/parameters/IdempotencyKeyRequired' }
        : { $ref: '#/components/parameters/IdempotencyKey' },
    );
  }
  const isPublic = 'public' in route.auth;
  const permission = 'permission' in route.auth ? route.auth.permission : null;
  const reason = 'reason' in route.auth ? route.auth.reason : null;
  return {
    tags: [route.tag],
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    operationId: `${route.method}${route.fullPath.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))}`,
    security: isPublic ? [] : [{ bearerAuth: [] }],
    'x-permission': permission,
    ...(isPublic && reason ? { 'x-public-reason': reason } : {}),
    ...('signedIn' in route.auth && reason ? { 'x-signed-in-only': reason } : {}),
    'x-error-codes': [...new Set([...implicitErrors(route), ...route.errors])],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(route.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: stripMeta(toSchema(route.body)) } },
          },
        }
      : {}),
    responses: { [String(route.success.status)]: successResponse(route), ...errorResponses(route) },
  };
}

const COMPONENTS: Json = {
  securitySchemes: {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      description:
        'Access token from POST /api/v1/auth/login or /auth/refresh, in the Authorization header (Spec P4 §2.2). It lives 15 minutes; the refresh token is an HttpOnly cookie scoped to /api/v1/auth.',
    },
  },
  headers: {
    RequestId: {
      description: 'Per-request id. Quote it when reporting a problem.',
      schema: { type: 'string' },
    },
    ETag: { description: 'The resource version. Send it back as If-Match.', schema: { type: 'string' } },
  },
  parameters: {
    IfMatch: {
      name: 'If-Match',
      in: 'header',
      required: true,
      description:
        'The version (ETag) you last read. Missing → 422 PRECONDITION_REQUIRED, stale → 409 VERSION_CONFLICT.',
      schema: { type: 'string', example: '"3"' },
    },
    IdempotencyKey: {
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'A retry with the same key returns the original response instead of running twice (24 h).',
      schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
    },
    IdempotencyKeyRequired: {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
    },
  },
  schemas: {
    Meta: {
      type: 'object',
      required: ['request_id', 'server_time'],
      properties: { request_id: { type: 'string' }, server_time: { type: 'string', format: 'date-time' } },
    },
    PageMeta: {
      type: 'object',
      required: ['request_id', 'pagination'],
      properties: {
        request_id: { type: 'string' },
        server_time: { type: 'string', format: 'date-time' },
        pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer' },
            per_page: { type: 'integer' },
            total: { type: 'integer' },
            last_page: { type: 'integer' },
          },
        },
        applied_scope: { type: 'object', additionalProperties: true },
      },
    },
    CursorMeta: {
      type: 'object',
      required: ['request_id', 'cursor'],
      properties: {
        request_id: { type: 'string' },
        server_time: { type: 'string', format: 'date-time' },
        cursor: {
          type: 'object',
          properties: { limit: { type: 'integer' }, next_cursor: { type: ['string', 'null'] } },
        },
        applied_scope: { type: 'object', additionalProperties: true },
      },
    },
    Links: {
      type: 'object',
      properties: {
        first: { type: 'string' },
        prev: { type: ['string', 'null'] },
        next: { type: ['string', 'null'] },
        last: { type: 'string' },
      },
    },
    ErrorEnvelope: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message', 'details', 'request_id'],
          properties: {
            code: {
              type: 'string',
              enum: Object.keys(ERROR_CODES),
              description: 'Stable code. Branch on this, never on the message.',
            },
            message: { type: 'string' },
            details: {
              type: 'array',
              items: {
                type: 'object',
                required: ['code', 'message'],
                properties: {
                  field: {
                    type: 'string',
                    description: 'Dot/index path into the request, e.g. lines.0.quantity',
                  },
                  code: { type: 'string' },
                  message: { type: 'string' },
                  context: { type: 'object', additionalProperties: true },
                },
              },
            },
            request_id: { type: 'string' },
          },
        },
      },
    },
  },
};

const HEALTH_PATHS: Json = {
  '/health': {
    get: {
      tags: ['Platform'],
      summary: 'Liveness: the process is up',
      security: [],
      responses: { '200': { description: 'Up, with version and commit' } },
    },
  },
  '/health/ready': {
    get: {
      tags: ['Platform'],
      summary: 'Readiness: database (and Redis, when configured) reachable',
      security: [],
      responses: { '200': { description: 'Ready' }, '503': { description: 'A dependency is unreachable' } },
    },
  },
};

export function buildOpenApi(
  modules: readonly ApiModule[],
  info: { version: string; serverUrl?: string },
): Json {
  const paths: Record<string, Record<string, Json>> = {
    ...(HEALTH_PATHS as Record<string, Record<string, Json>>),
  };
  const tags = new Set<string>(['Platform']);
  for (const m of modules) {
    for (const route of m.routes ?? []) {
      const p = expressToOpenApiPath(route.fullPath);
      paths[p] = { ...(paths[p] ?? {}), [route.method]: operation(route) };
      tags.add(route.tag);
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'RupAI API',
      version: info.version,
      description:
        'Integrated tea estate ERP. Conventions: Spec Part 4. Money and quantities are decimal STRINGS, ids are strings, ' +
        'business dates are YYYY-MM-DD, timestamps carry a UTC offset. Errors use one envelope with a stable code.',
    },
    ...(info.serverUrl ? { servers: [{ url: info.serverUrl }] } : {}),
    tags: [...tags].map((name) => ({ name })),
    paths,
    components: COMPONENTS,
  };
}
