import { existsSync } from 'node:fs';

import type { Logger } from 'pino';

import { ConfigError, loadConfig, type Config } from './config/env.js';

/**
 * What every process (API, worker, scheduler) does the same way at start-up and on the way out. Each is
 * a supervised unit that the supervisor restarts on failure (Spec P14 §6), so a fatal error exits
 * non-zero rather than limping on.
 */

/** Reads and validates configuration, or exits with the problems listed. */
export function loadProcessConfig(): Config {
  // A local .env file is a development convenience. Real environment variables always take precedence.
  if (existsSync('.env')) process.loadEnvFile('.env');
  try {
    return loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * An unhandled rejection or exception leaves the process in an unknown state. Log it and let the
 * supervisor restart the process (Spec P2 §3.3).
 */
export function exitOnFatal(logger: Logger): void {
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    process.exit(1);
  });
}

/**
 * Graceful shutdown (P14 §6): on SIGTERM or SIGINT, `drain` stops taking work and finishes what is in
 * flight. If it takes longer than `deadlineSeconds`, the process exits anyway.
 */
export function onShutdown(logger: Logger, deadlineSeconds: number, drain: () => Promise<void>): void {
  let started = false;
  const handler = (signal: NodeJS.Signals) => {
    if (started) return;
    started = true;
    logger.info({ signal }, 'shutdown signal received, draining');
    setTimeout(() => {
      logger.error('drain timeout exceeded, forcing exit');
      process.exit(1);
    }, deadlineSeconds * 1000).unref();
    drain().then(
      () => {
        logger.info('stopped');
        process.exit(0);
      },
      (err: unknown) => {
        logger.error({ err }, 'shutdown failed');
        process.exit(1);
      },
    );
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}
