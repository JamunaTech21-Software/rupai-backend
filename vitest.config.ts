import { defineConfig } from 'vitest/config';

/**
 * Two projects:
 *   unit — fast, no external services. Run by `npm test` and `npm run check`.
 *   db   — against a real MySQL 8.4 (`npm run db:up` first). Run by `npm run test:db`.
 *          P0.06 moves this onto Testcontainers so CI needs no pre-started database.
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
          // Database tests share one MySQL server. Run files one at a time for predictable grants.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
