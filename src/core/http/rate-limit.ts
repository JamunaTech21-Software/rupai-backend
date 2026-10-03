import type { Request, RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';

import { getRequestContext } from '../context/request-context.js';
import { AppError } from '../errors/app-error.js';

/**
 * Rate limit classes (Spec P4 §2.9, Table 2.4). All values are configuration, not scattered constants.
 *
 * Counters live in Redis when REDIS_URL is set (always in production), so every API process shares one
 * count. Without Redis they are per-process memory, which is acceptable only in development.
 */
export const RATE_LIMIT_CLASSES = {
  /** Credential stuffing defence: per IP and, separately, per username (P1.02 mounts these). */
  authPerIp: { limit: 5, windowMs: 60_000 },
  authPerUsername: { limit: 5, windowMs: 60_000 },
  passwordReset: { limit: 3, windowMs: 60 * 60_000 },
  read: { limit: 120, windowMs: 60_000 },
  write: { limit: 60, windowMs: 60_000 },
  /** Reports and exports queue work. The limit protects the workers. */
  report: { limit: 10, windowMs: 60_000 },
  import: { limit: 5, windowMs: 60 * 60_000 },
  /** Attendance devices are bursty at shift change. */
  integration: { limit: 600, windowMs: 60_000 },
} as const;

export type RateLimitClass = keyof typeof RATE_LIMIT_CLASSES;

/** The authenticated user when known (from P1.02), otherwise the client IP (IPv6 by /56 subnet). */
export function actorOrIpKey(req: Request): string {
  const actor = getRequestContext()?.actorId;
  return actor ? `user:${actor}` : `ip:${ipKeyGenerator(req.ip ?? 'unknown')}`;
}

export interface RateLimitOptions {
  /** A RateLimitClass name, or a custom name for a route-specific limiter. */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly key?: (req: Request) => string;
  readonly enabled?: boolean;
  readonly store?: Store;
}

/**
 * One rate limiter. When exceeded it answers 429 RATE_LIMITED with Retry-After, in the standard error
 * envelope, and the client shows a countdown (Spec P5 Table 4.2).
 */
export function createRateLimiter(options: RateLimitOptions): RequestHandler {
  if (options.enabled === false)
    return (_req, _res, next) => {
      next();
    };
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    identifier: options.name,
    keyGenerator: (req) => `${options.name}:${(options.key ?? actorOrIpKey)(req)}`,
    ...(options.store ? { store: options.store } : {}),
    handler: (req, _res, next) => {
      const reset = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit?.resetTime;
      const retryAfter = Math.max(
        1,
        Math.ceil(((reset?.getTime() ?? Date.now() + options.windowMs) - Date.now()) / 1000),
      );
      next(
        new AppError(
          'RATE_LIMITED',
          'Too many requests. Please wait and try again.',
          [
            {
              code: 'RATE_LIMITED',
              message: `Retry after ${retryAfter} seconds.`,
              context: { retry_after_seconds: retryAfter },
            },
          ],
          { 'Retry-After': String(retryAfter) },
        ),
      );
    },
  });
}

/** Builds a limiter for one of the named classes of Spec P4 Table 2.4. */
export function rateLimitFor(
  cls: RateLimitClass,
  opts: { enabled: boolean; key?: (req: Request) => string; store?: Store },
): RequestHandler {
  return createRateLimiter({ name: cls, ...RATE_LIMIT_CLASSES[cls], ...opts });
}

/**
 * The default for every /api/v1 route: reads (GET/HEAD) at the read class, everything else at the write
 * class. Specific routes add stricter classes (auth, report, import) on top.
 */
export function defaultApiRateLimit(
  enabled: boolean,
  storeFor: (name: string) => Store | undefined = () => undefined,
): RequestHandler {
  const withStore = (name: string) => {
    const store = storeFor(name);
    return store ? { store } : {};
  };
  const read = rateLimitFor('read', { enabled, ...withStore('read') });
  const write = rateLimitFor('write', { enabled, ...withStore('write') });
  return (req, res, next) => {
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    const limiter = req.method === 'GET' || req.method === 'HEAD' ? read : write;
    void limiter(req, res, next);
  };
}
