import { existsSync } from 'node:fs';

import { createApp } from './app.js';
import { ConfigError, loadConfig, type Config } from './config/env.js';
import { createDatabase } from './core/db/prisma.js';
import { createLogger } from './core/logging/logger.js';
import { createPlatform } from './core/platform.js';
import { buildModules } from './modules/index.js';

/**
 * Process entry point: loads and validates configuration, binds the HTTP port, and shuts down cleanly.
 * Every process is supervised and restarted on failure (Spec P14 §6), so a fatal error exits non-zero
 * rather than limping on.
 */

// A local .env file is a development convenience. Real environment variables always take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
  throw err;
}

const logger = createLogger(config);
const db = createDatabase(config);
const platform = await createPlatform(config, logger);
const app = createApp({ config, logger, db, platform, modules: buildModules({ platform }) });

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, timezone: config.timezone }, 'rupai-backend listening');
});

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'shutdown signal received, draining');
  server.close(() => {
    logger.info('server closed');
    void Promise.allSettled([db.$disconnect(), platform.close()]).finally(() => process.exit(0));
  });
  // Hard stop if in-flight requests do not drain in time (Spec P14 §6).
  setTimeout(() => {
    logger.error('drain timeout exceeded, forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// An unhandled rejection or exception leaves the process in an unknown state. Log it and let the
// supervisor restart the process (Spec P2 §3.3).
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled promise rejection');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception');
  process.exit(1);
});
