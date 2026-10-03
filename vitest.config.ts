import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *   unit — fast, no external services. Run by `npm test` and `npm run check`.
 *   db   — against a real MySQL 8.4 started by Testcontainers (Docker must be running), or the server
 *          named by TEST_DB_HOST (e.g. after `npm run db:up`, faster when iterating). `npm run test:db`.
 */
export default defineConfig({
  test: {
    restoreMocks: true,
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
          exclude: ['tests/db/**', 'tests/fixtures/**', 'node_modules/**'],
        },
      },
      {
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          // Starts a throwaway MySQL 8.4 with Testcontainers unless TEST_DB_HOST names a running server.
          globalSetup: ['tests/db/global-setup.ts'],
          // Database tests share one MySQL server. Run files one at a time for predictable grants.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
