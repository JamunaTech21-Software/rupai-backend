import { z } from 'zod';

/**
 * Environment configuration (Spec P14 §4.3).
 *
 * - Every value comes from the environment. No secret lives in the repository.
 * - The application validates its configuration at start-up and refuses to start on any missing or
 *   malformed value. Error messages name the variable but never echo its value, which may be a secret.
 */

const required = (what: string) => ({
  error: (iss: { input?: unknown }) => (iss.input === undefined || iss.input === '' ? 'is required' : what),
});

export const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const envSchema = z.object({
  /** Runtime mode for libraries (Express, etc.). */
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * Deployment environment name. Anything other than `production` is shown as a banner in the web UI,
   * so nobody approves a real payroll on staging (Spec P14 §4.3).
   */
  APP_ENV: z.enum(APP_ENVS, required(`must be one of ${APP_ENVS.join(', ')}`)),

  PORT: z.coerce
    .number(required('must be a number'))
    .int('must be an integer')
    .min(1, 'must be between 1 and 65535')
    .max(65535, 'must be between 1 and 65535')
    .default(4000),

  LOG_LEVEL: z.enum(LOG_LEVELS, required(`must be one of ${LOG_LEVELS.join(', ')}`)).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty'], required('must be json or pretty')).default('json'),

  /** Display timezone. Storage is always UTC (Spec P2 §2.7, P14 §8.3). */
  APP_TIMEZONE: z
    .string(required('must be an IANA timezone'))
    .refine(isValidTimezone, 'must be a valid IANA timezone, e.g. Asia/Dhaka')
    .default('Asia/Dhaka'),

  /** Application database account: DML only (Spec P14 §5.2). */
  DATABASE_URL: z
    .string(required('must be a mysql:// connection URL'))
    .min(1, 'is required')
    // Empty is already reported as "is required" by min(1).
    .refine((v) => v === '' || v.startsWith('mysql://'), 'must be a mysql:// connection URL'),

  /**
   * Connection pool size per process. MySQL max_connections must exceed
   * (API processes + workers) × pool size + margin (Spec P14 §3.4).
   */
  DB_POOL_SIZE: z.coerce
    .number(required('must be a number'))
    .int('must be an integer')
    .min(1, 'must be between 1 and 100')
    .max(100, 'must be between 1 and 100')
    .default(10),

  /**
   * MySQL 8 caching_sha2_password over a non-TLS connection needs the server's RSA key. Only enable this
   * for a database on localhost or a trusted local network. Use TLS everywhere else.
   */
  DB_ALLOW_PUBLIC_KEY_RETRIEVAL: z
    .enum(['true', 'false'], required('must be true or false'))
    .default('false'),

  // ---- HTTP (P0.04) ------------------------------------------------------------------------------

  /**
   * Exact browser origins allowed to call the API, comma-separated (Spec P4 §2.2.2). No wildcard, and
   * the request Origin is never reflected. Required in production. Defaults to the local web app elsewhere.
   */
  CORS_ORIGINS: z.string(required('must be a comma-separated list of origins')).optional(),
  /** Only true if the refresh token travels in a cookie (decided in P1.02). Default false. */
  CORS_ALLOW_CREDENTIALS: z.enum(['true', 'false'], required('must be true or false')).default('false'),
  /** How long browsers may cache a preflight response, so chatty screens are not doubled. */
  CORS_MAX_AGE_SECONDS: z.coerce
    .number(required('must be a number'))
    .int('must be an integer')
    .min(0, 'must be 0 or more')
    .max(86400, 'must be at most 86400')
    .default(600),

  /**
   * Which reverse proxies to trust for the client IP (Express "trust proxy"). The production API sits
   * behind Nginx/Caddy on the same machine (Spec P14 §2.1), so the default is loopback.
   */
  TRUST_PROXY: z
    .string(required('must be an Express trust-proxy value'))
    .min(1, 'is required')
    .default('loopback'),

  /** HSTS only once a valid certificate is in place, never before. HSTS with a bad certificate locks users out (P14 §7.3). */
  HSTS_ENABLED: z.enum(['true', 'false'], required('must be true or false')).default('false'),

  /** Maximum JSON body size. */
  BODY_LIMIT: z
    .string(required('must be a size such as 1mb'))
    .regex(/^\d+(?:kb|mb)$/i, 'must be a size such as 512kb or 1mb')
    .default('1mb'),

  /** Rate limiting (Spec P4 §2.9). Disable only in tests. */
  RATE_LIMIT_ENABLED: z.enum(['true', 'false'], required('must be true or false')).default('true'),

  /**
   * Redis: shared idempotency records and rate-limit counters now, then the job queue (P1.15) and token
   * revocation (P1.02). Required in production, because several API processes must share them. Optional
   * in development and tests, where an in-memory fallback is used.
   */
  REDIS_URL: z
    .string(required('must be a redis:// connection URL'))
    .refine((v) => v === '' || /^rediss?:\/\//.test(v), 'must be a redis:// or rediss:// connection URL')
    .optional(),

  /** Interactive API docs at /docs. Off in production by default. */
  DOCS_ENABLED: z.enum(['true', 'false'], required('must be true or false')).optional(),

  /** Reported by the health endpoint, so what is running is never a matter of inference (P14 §11.3). */
  APP_VERSION: z.string().min(1).default('0.0.0-dev'),
  BUILD_COMMIT: z.string().min(1).default('unknown'),
});

const DEV_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** Validates a comma-separated origin list: exact scheme://host[:port], no paths, no wildcard. */
function parseOrigins(raw: string, problems: string[]): string[] {
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0) problems.push('CORS_ORIGINS must list at least one origin');
  for (const o of origins) {
    if (o.includes('*')) {
      problems.push('CORS_ORIGINS must not contain a wildcard');
      continue;
    }
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      problems.push(`CORS_ORIGINS contains an invalid origin`);
      continue;
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.origin !== o) {
      problems.push(
        'CORS_ORIGINS entries must be exact origins like https://erp.example.com (no path or trailing slash)',
      );
    }
  }
  return origins;
}

export type AppEnv = (typeof APP_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly appEnv: AppEnv;
  readonly isProduction: boolean;
  readonly port: number;
  readonly log: { readonly level: LogLevel; readonly format: 'json' | 'pretty' };
  readonly timezone: string;
  readonly database: {
    readonly url: string;
    readonly poolSize: number;
    readonly allowPublicKeyRetrieval: boolean;
  };
  readonly http: {
    readonly corsOrigins: readonly string[];
    readonly corsAllowCredentials: boolean;
    readonly corsMaxAgeSeconds: number;
    readonly trustProxy: string;
    readonly hstsEnabled: boolean;
    readonly bodyLimit: string;
    readonly rateLimitEnabled: boolean;
  };
  readonly build: { readonly version: string; readonly commit: string };
  readonly redis: { readonly url: string | null };
  readonly docs: { readonly enabled: boolean };
}

export class ConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration — refusing to start:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates configuration from an environment map. It is pure (no reads of `process.env`)
 * so it can be tested.
 * @throws ConfigError listing every problem at once, not just the first.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`);
    throw new ConfigError(problems);
  }
  const e = parsed.data;

  const problems: string[] = [];
  if (e.APP_ENV === 'production' && e.NODE_ENV !== 'production') {
    problems.push('NODE_ENV must be production when APP_ENV is production');
  }
  if (e.APP_ENV === 'production' && e.LOG_FORMAT === 'pretty') {
    problems.push('LOG_FORMAT must be json in production');
  }
  let corsOrigins = DEV_CORS_ORIGINS;
  if (e.CORS_ORIGINS === undefined || e.CORS_ORIGINS.trim() === '') {
    if (e.APP_ENV === 'production') problems.push('CORS_ORIGINS is required in production');
  } else {
    corsOrigins = parseOrigins(e.CORS_ORIGINS, problems);
  }
  const redisUrl = e.REDIS_URL && e.REDIS_URL !== '' ? e.REDIS_URL : null;
  if (e.APP_ENV === 'production' && !redisUrl) problems.push('REDIS_URL is required in production');
  if (e.APP_ENV === 'production' && e.RATE_LIMIT_ENABLED === 'false') {
    problems.push('RATE_LIMIT_ENABLED must be true in production');
  }
  if (problems.length > 0) throw new ConfigError(problems);

  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    appEnv: e.APP_ENV,
    isProduction: e.APP_ENV === 'production',
    port: e.PORT,
    log: Object.freeze({ level: e.LOG_LEVEL, format: e.LOG_FORMAT }),
    timezone: e.APP_TIMEZONE,
    database: Object.freeze({
      url: e.DATABASE_URL,
      poolSize: e.DB_POOL_SIZE,
      allowPublicKeyRetrieval: e.DB_ALLOW_PUBLIC_KEY_RETRIEVAL === 'true',
    }),
    http: Object.freeze({
      corsOrigins: Object.freeze([...corsOrigins]),
      corsAllowCredentials: e.CORS_ALLOW_CREDENTIALS === 'true',
      corsMaxAgeSeconds: e.CORS_MAX_AGE_SECONDS,
      trustProxy: e.TRUST_PROXY,
      hstsEnabled: e.HSTS_ENABLED === 'true',
      bodyLimit: e.BODY_LIMIT.toLowerCase(),
      rateLimitEnabled: e.RATE_LIMIT_ENABLED === 'true',
    }),
    build: Object.freeze({ version: e.APP_VERSION, commit: e.BUILD_COMMIT }),
    redis: Object.freeze({ url: redisUrl }),
    docs: Object.freeze({
      enabled: e.DOCS_ENABLED === undefined ? e.APP_ENV !== 'production' : e.DOCS_ENABLED === 'true',
    }),
  });
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
