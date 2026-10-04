/**
 * `npm run db:seed` (also run by Prisma after `migrate dev`).
 *
 * Seeding is a deployment step, so it connects as the MIGRATION account (MIGRATION_DATABASE_URL), the
 * same account that applies migrations. The app account cannot update reference tables that ship as
 * system data.
 *
 * Seeders are registered in `seeders.ts` in dependency order as epics deliver them (permissions and the
 * admin role in P1.01, lookups in P1.10, …). Every seeder is idempotent.
 */
import { existsSync } from 'node:fs';

import { createLogger } from '../../src/core/logging/logger.js';
import { createDatabase } from '../../src/core/db/prisma.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { buildSeeders } from './seeders.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  process.stderr.write('MIGRATION_DATABASE_URL is required to seed the database\n');
  process.exit(1);
}

const logger = createLogger({ appEnv: 'development', log: { level: 'info', format: 'pretty' } });
const db = createDatabase({
  database: {
    url,
    poolSize: 2,
    allowPublicKeyRetrieval: process.env.DB_ALLOW_PUBLIC_KEY_RETRIEVAL === 'true',
  },
});

try {
  await runSeeders(db, buildSeeders(process.env), logger);
} catch (err) {
  logger.error({ err }, 'seeding failed');
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
