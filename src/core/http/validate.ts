import type { RequestHandler, Response } from 'express';
import type { z } from 'zod';

import { Errors, type ErrorDetail } from '../errors/app-error.js';

/**
 * Request validation with Zod (Spec P4 §2.3, §3.1). One schema per part of the request:
 *   - unknown body keys are rejected (schemas should be `z.strictObject`)
 *   - failures become 422 VALIDATION_FAILED, with one detail per problem
 *   - `field` uses dot and index notation matching the body (`lines.0.quantity`), so the client can put
 *     each error on the right input
 * The parsed, typed values are stored for the controller. Controllers never re-read `req.body`.
 */
export interface RequestSchemas {
  readonly params?: z.ZodType;
  readonly query?: z.ZodType;
  readonly body?: z.ZodType;
}

export interface Validated<S extends RequestSchemas> {
  params: S['params'] extends z.ZodType ? z.infer<S['params']> : undefined;
  query: S['query'] extends z.ZodType ? z.infer<S['query']> : undefined;
  body: S['body'] extends z.ZodType ? z.infer<S['body']> : undefined;
}

const VALIDATED = 'validated';

export function zodIssuesToDetails(issues: readonly z.core.$ZodIssue[], prefix?: string): ErrorDetail[] {
  return issues.map((i) => {
    const path = i.path.map(String).join('.');
    const field = prefix ? (path ? `${prefix}.${path}` : prefix) : path;
    return { ...(field ? { field } : {}), code: 'VALIDATION_FAILED', message: i.message };
  });
}

export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, res, next) => {
    const details: ErrorDetail[] = [];
    const out: Record<string, unknown> = {};
    const parts = [
      ['params', schemas.params, req.params],
      ['query', schemas.query, req.query],
      ['body', schemas.body, req.body as unknown],
    ] as const;

    for (const [part, schema, input] of parts) {
      if (!schema) continue;
      const result = schema.safeParse(input ?? {});
      if (result.success) out[part] = result.data;
      // Body fields are reported by their own path. Params and query fields are prefixed so the
      // client can tell them apart.
      else details.push(...zodIssuesToDetails(result.error.issues, part === 'body' ? undefined : part));
    }

    if (details.length > 0) throw Errors.validation(details);
    res.locals[VALIDATED] = out;
    next();
  };
}

/** Typed access to the values validated by `validate(schemas)` on this route. */
export function getValidated<S extends RequestSchemas>(res: Response, _schemas: S): Validated<S> {
  const v = res.locals[VALIDATED] as Validated<S> | undefined;
  if (!v) throw new Error('validate() middleware was not mounted on this route');
  return v;
}
