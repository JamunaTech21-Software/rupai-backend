import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../src/core/db/prisma.js';
import { loadMinimalDataset } from '../fixtures/minimal-dataset.js';
import { BACKEND, createTempDatabase, prismaProbe, url, withRollback, type TempDatabase } from './helpers.js';

/**
 * P0.06: the test harness itself works against a real MySQL, Testcontainers by default.
 * This is the "example integration test passing against real MySQL" of the epic's verification.
 */
describe('test harness', () => {
  let tmp: TempDatabase;
  let db: Database;

  beforeAll(async () => {
    tmp = await createTempDatabase();
    const deploy = prismaProbe(tmp, ['migrate', 'deploy']);
    expect(deploy.status, deploy.stdout + deploy.stderr).toBe(0);
    db = createDatabase({
      database: { url: url('app', tmp.name), poolSize: 2, allowPublicKeyRetrieval: true },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
    await tmp.drop();
  });

  const count = async () =>
    (await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM probe_lookup`)[0]?.n ?? -1n;

  it('withRollback lets a test write and read, then leaves the database untouched', async () => {
    const before = await count();
    const seen = await withRollback(db, async (tx) => {
      await tx.$executeRaw`INSERT INTO probe_lookup (code, name) VALUES ('ISO-1', 'isolated')`;
      const rows = await tx.$queryRaw<
        { n: bigint }[]
      >`SELECT COUNT(*) AS n FROM probe_lookup WHERE code = 'ISO-1'`;
      return rows[0]?.n;
    });
    expect(seen).toBe(1n);
    expect(await count()).toBe(before);
  });

  it('withRollback still surfaces real failures', async () => {
    await expect(
      withRollback(db, async (tx) => {
        await tx.$executeRaw`INSERT INTO probe_lookup (code, name) VALUES ('ISO-2', 'x')`;
        await tx.$executeRaw`INSERT INTO probe_lookup (code, name) VALUES ('ISO-2', 'duplicate')`;
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(0n);
  });

  it('the minimal dataset loads, and loads again with no change', async () => {
    const logger = pino({ level: 'silent' });
    await expect(loadMinimalDataset(db, logger)).resolves.toEqual({});
    await expect(loadMinimalDataset(db, logger)).resolves.toEqual({});
  });

  it('the project schema has no drift from its migrations (the CI drift gate)', () => {
    const run = spawnSync(resolve(BACKEND, 'node_modules/.bin/tsx'), ['scripts/check-drift.ts'], {
      cwd: BACKEND,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
        MIGRATION_DATABASE_URL: url('migrator', 'rupai'),
        SHADOW_DATABASE_URL: url('migrator', 'rupai_shadow'),
      },
      timeout: 120_000,
    });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain('No drift');
  });
});
