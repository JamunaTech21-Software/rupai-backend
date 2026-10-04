import { Writable } from 'node:stream';

import type { Express } from 'express';
import type { Logger } from 'pino';

import { createApp, type ApiModule } from '../../src/app.js';
import { loadConfig, type Config } from '../../src/config/env.js';
import { createDatabase } from '../../src/core/db/prisma.js';
import { createLogger } from '../../src/core/logging/logger.js';
import type { Platform } from '../../src/core/platform.js';
import { testActor } from './actors.js';

export const TEST_ENV = {
  NODE_ENV: 'test',
  APP_ENV: 'test',
  LOG_LEVEL: 'info',
  LOG_FORMAT: 'json',
  DATABASE_URL: 'mysql://test:test@localhost:3306/rupai_test',
  AUTH_TOKEN_SECRET: 'test-only-token-secret-0123456789abcdef',
} as const;

/** Collects JSON log lines in memory so tests can assert on what was logged. */
export class LogCapture extends Writable {
  readonly lines: Record<string, unknown>[] = [];
  override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) this.lines.push(JSON.parse(line) as Record<string, unknown>);
    }
    cb();
  }
  get text(): string {
    return JSON.stringify(this.lines);
  }
}

export interface TestApp {
  app: Express;
  config: Config;
  logger: Logger;
  logs: LogCapture;
}

export function buildTestApp(
  env: Record<string, string> = {},
  modules: readonly ApiModule[] = [],
  platform?: Platform,
): TestApp {
  const config = loadConfig({ ...TEST_ENV, ...env });
  const logs = new LogCapture();
  const logger = createLogger(config, logs);
  // The Prisma client connects lazily, so tests that never query need no running database.
  const db = createDatabase(config);
  return {
    // Requests name their actor with the X-Test-Actor header (helpers/actors.ts) until real login (P1.02).
    app: createApp({
      config,
      logger,
      db,
      modules,
      authenticate: testActor(),
      ...(platform ? { platform } : {}),
    }),
    config,
    logger,
    logs,
  };
}
