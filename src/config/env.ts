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
});

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
