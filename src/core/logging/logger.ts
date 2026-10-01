import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { Config } from '../../config/env.js';
import { getRequestContext } from '../context/request-context.js';

/**
 * Keys whose values must never reach a log line: credentials, tokens, national IDs, bank details
 * (Spec P13 §10, "no secret in a log"). These apply at the top level and one level deep. Code that
 * logs deeper structures must log a narrowed object instead.
 */
const SENSITIVE_KEYS = [
  'password',
  'password_hash',
  'current_password',
  'new_password',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'two_factor_secret',
  'api_key',
  'national_id',
  'nid',
  'bank_account_number',
  'account_number',
] as const;

export const REDACT_PATHS: string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
];

export const REDACTED = '[REDACTED]';

/**
 * Creates the root logger. `destination` is for tests. In normal use logs go to stdout (and from there
 * to the system journal, Spec P14 §6).
 */
export function createLogger(
  config: Pick<Config, 'appEnv' | 'log'>,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: config.log.level,
    base: { service: 'rupai-backend', env: config.appEnv },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    formatters: { level: (label) => ({ level: label }) },
  };

  if (destination) return pino(options, destination);

  if (config.log.format === 'pretty') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }
  return pino(options);
}

/**
 * The logger for the current request (bound with `request_id`), or `fallback` outside a request.
 * Services and repositories use this so every line they write carries the request id.
 */
export function getLogger(fallback: Logger): Logger {
  return getRequestContext()?.logger ?? fallback;
}
