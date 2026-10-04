import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

// The Prisma CLI does not read .env on its own. Real environment variables always win.
if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * Prisma CLI configuration.
 *
 * The CLI connects as the MIGRATION account (DDL), never as the application account. The running app
 * connects through the driver adapter using DATABASE_URL, the DML-only account (src/core/db/prisma.ts).
 * See BACKLOG §2.1 and prisma/README.md for the SQL-first workflow.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed/index.ts',
  },
  datasource: {
    // Optional at load time so that `prisma generate` works without a database.
    // Migration commands fail clearly if it is missing.
    url: process.env.MIGRATION_DATABASE_URL ?? '',
    // Only `migrate dev` and the drift check need a shadow database. Staging and production
    // (`migrate deploy`) have none, and Prisma refuses an empty string.
    ...(process.env.SHADOW_DATABASE_URL ? { shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL } : {}),
  },
});
