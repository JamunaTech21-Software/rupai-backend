import { defineConfig } from 'prisma/config';

// Fixture config: the test points PROBE_* at a throwaway rupai_tmp_* database.
export default defineConfig({
  schema: 'schema.prisma',
  migrations: { path: 'migrations' },
  datasource: {
    url: process.env.PROBE_DATABASE_URL ?? '',
    shadowDatabaseUrl: process.env.PROBE_SHADOW_DATABASE_URL ?? '',
  },
});
