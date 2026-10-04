/**
 * `npm run db:seed:demo`: demo accounts for staging and local verification (P0.08). Run AFTER
 * `npm run db:seed`. Refuses to run when APP_ENV=production.
 *
 *   DEMO_PASSWORD   the password of the demo accounts (at least 12 characters)
 */
import { existsSync } from 'node:fs';

import { createDatabase } from '../../src/core/db/prisma.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { createLogger } from '../../src/core/logging/logger.js';
import { demoSeeders } from './demo-seeders.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

if (process.env.APP_ENV === 'production') fail('Demo data is never seeded in production.');
const url = process.env.MIGRATION_DATABASE_URL ?? fail('MIGRATION_DATABASE_URL is required');
const password = process.env.DEMO_PASSWORD ?? '';
if (password.length < 12) fail('DEMO_PASSWORD (at least 12 characters) is required');

const logger = createLogger({ appEnv: 'development', log: { level: 'info', format: 'pretty' } });
const db = createDatabase({
  database: {
    url,
    poolSize: 2,
    allowPublicKeyRetrieval: process.env.DB_ALLOW_PUBLIC_KEY_RETRIEVAL === 'true',
  },
});
try {
  await runSeeders(db, demoSeeders(password), logger);
} catch (err) {
  logger.error({ err }, 'demo seeding failed');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
