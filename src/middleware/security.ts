import cors from 'cors';
import type { RequestHandler } from 'express';
import helmet from 'helmet';

import type { Config } from '../config/env.js';

/**
 * Security headers for a JSON API (Spec P13 §10, P14 §7.3). Nothing here is ever rendered as a page,
 * so the CSP forbids everything. HSTS is sent only when a valid certificate is in place
 * (HSTS_ENABLED), because HSTS over a bad certificate locks users out.
 */
export function securityHeaders(config: Pick<Config, 'http'>): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    strictTransportSecurity: config.http.hstsEnabled
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
}

/** Request headers the SPA may send (Spec P4 §2.2.2). Nothing else is permitted. */
export const CORS_ALLOWED_HEADERS = ['Authorization', 'Content-Type', 'If-Match', 'Idempotency-Key'];

/**
 * Response headers the SPA may read. By default a cross-origin client cannot see them (Spec P4 §2.2.2).
 * X-Environment drives the non-production banner (P0.02), Location follows a 201, and
 * Idempotent-Replayed tells the client a retry was answered from storage.
 */
export const CORS_EXPOSED_HEADERS = [
  'ETag',
  'X-Request-Id',
  'Retry-After',
  'X-Environment',
  'Location',
  'Idempotent-Replayed',
];

/**
 * CORS with an exact origin allow-list (Spec P4 §2.2.2): no wildcard, and the request's Origin is never
 * reflected. A request from an unlisted origin gets no CORS headers, so the browser blocks it. Requests
 * with no Origin (server-to-server, curl, devices) are unaffected. CORS is a browser control, not
 * authentication.
 */
export function corsPolicy(config: Pick<Config, 'http'>): RequestHandler {
  const allowed = new Set(config.http.corsOrigins);
  return cors({
    origin: (origin, cb) => {
      cb(null, origin !== undefined && allowed.has(origin) ? origin : false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: CORS_EXPOSED_HEADERS,
    credentials: config.http.corsAllowCredentials,
    maxAge: config.http.corsMaxAgeSeconds,
    optionsSuccessStatus: 204,
  });
}
