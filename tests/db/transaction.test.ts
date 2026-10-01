import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';

import { Prisma } from '../../src/generated/prisma/client.js';
import { createDatabase, type Database } from '../../src/core/db/prisma.js';
import { runSeeders, seedRows, type Seeder } from '../../src/core/db/seed.js';
import { lockRowsForUpdate, withTransaction } from '../../src/core/db/transaction.js';
import { createTempDatabase, prismaProbe, url, type TempDatabase } from './helpers.js';

/** P0.03: the transaction helper, the row-lock helper and the seeder runner, on real MySQL via Prisma. */
describe('database client, transactions, locks and seeding', () => {
  let tmp: TempDatabase;
  let db: Database; // app account (DML only)
  let migratorDb: Database; // seeding runs as the migration account

  beforeAll(async () => {
    tmp = await createTempDatabase();
    const deploy = prismaProbe(tmp, ['migrate', 'deploy']);
    expect(deploy.status, deploy.stdout + deploy.stderr).toBe(0);
    const opts = { poolSize: 4, allowPublicKeyRetrieval: true };
    db = createDatabase({ database: { url: url('app', tmp.name), ...opts } });
    migratorDb = createDatabase({ database: { url: url('migrator', tmp.name), ...opts } });
  });

  afterAll(async () => {
    await db.$disconnect();
    await migratorDb.$disconnect();
    await tmp.drop();
  });

  const countLookups = async (code: string) =>
    (await db.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM probe_lookup WHERE code = ${code}`)[0]?.n;

  describe('withTransaction', () => {
    it('runs at READ COMMITTED', async () => {
      const iso = await withTransaction(db, async (tx) => {
        const rows = await tx.$queryRaw<{ iso: string }[]>`SELECT @@transaction_isolation AS iso`;
        return rows[0]?.iso;
      });
      expect(iso).toBe('READ-COMMITTED');
    });

    it('commits when the work resolves', async () => {
      await withTransaction(db, async (tx) => {
        await tx.$executeRaw`INSERT INTO probe_lookup (code, name) VALUES ('TX-OK', 'committed')`;
      });
      expect(await countLookups('TX-OK')).toBe(1n);
    });

    it('rolls back everything when the work throws', async () => {
      await expect(
        withTransaction(db, async (tx) => {
          await tx.$executeRaw`INSERT INTO probe_lookup (code, name) VALUES ('TX-RB', 'rolled back')`;
          throw new Error('business rule failed after the write');
        }),
      ).rejects.toThrow('business rule failed');
      expect(await countLookups('TX-RB')).toBe(0n);
    });
  });

  describe('decimals never become floats', () => {
    it('returns DECIMAL columns as Prisma Decimal with exact digits', async () => {
      await db.$executeRaw`INSERT INTO probe_item (code, status, gross_area) VALUES ('DEC-1', 'x', 9847.25)`;
      const [row] = await db.$queryRaw<{ gross_area: Prisma.Decimal }[]>`
        SELECT gross_area FROM probe_item WHERE code = 'DEC-1'`;
      expect(row?.gross_area).toBeInstanceOf(Prisma.Decimal);
      expect(row?.gross_area.toFixed(3)).toBe('9847.250');
    });
  });

  describe('lockRowsForUpdate', () => {
    it('locks the row so a concurrent locker must wait (Spec P2 §3.7)', async () => {
      await db.$executeRaw`INSERT INTO probe_lookup (code, name) VALUES ('LOCK-1', 'balance row')`;

      let releaseFirst!: () => void;
      const firstHolds = new Promise<void>((r) => (releaseFirst = r));
      let firstLocked!: () => void;
      const locked = new Promise<void>((r) => (firstLocked = r));

      const first = withTransaction(db, async (tx) => {
        const rows = await lockRowsForUpdate<{ code: string }>(tx, 'probe_lookup', { code: 'LOCK-1' });
        expect(rows).toHaveLength(1);
        firstLocked();
        await firstHolds;
      });
      await locked;

      // While the first transaction holds the lock, NOWAIT fails immediately.
      await expect(
        withTransaction(
          db,
          (tx) => tx.$queryRaw`SELECT * FROM probe_lookup WHERE code = 'LOCK-1' FOR UPDATE NOWAIT`,
        ),
      ).rejects.toThrow();

      releaseFirst();
      await first;

      // Once released, the lock is available again.
      const rows = await withTransaction(db, (tx) =>
        lockRowsForUpdate(tx, 'probe_lookup', { code: 'LOCK-1' }),
      );
      expect(rows).toHaveLength(1);
    });

    it('binds values as parameters (no SQL injection through values)', async () => {
      const rows = await withTransaction(db, (tx) =>
        lockRowsForUpdate(tx, 'probe_lookup', { code: "x' OR '1'='1" }),
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('runSeeders', () => {
    let names: Record<string, string> = { CTC: 'Crush, Tear, Curl', ORT: 'Orthodox' };
    const seeder: Seeder = {
      name: 'probe-lookups',
      run: (tx) =>
        seedRows(
          tx,
          'probe_lookup',
          'code',
          Object.entries(names).map(([code, name]) => ({ code, name })),
        ),
    };
    const logger = pino({ level: 'silent' });

    it('seeds on the first run', async () => {
      const result = await runSeeders(migratorDb, [seeder], logger);
      expect(result['probe-lookups']).toEqual({ inserted: 2, updated: 0 });
    });

    it('is idempotent: a second run changes nothing', async () => {
      const result = await runSeeders(migratorDb, [seeder], logger);
      expect(result['probe-lookups']).toEqual({ inserted: 0, updated: 0 });
      expect(await countLookups('CTC')).toBe(1n);
    });

    it('updates only rows whose values changed, and adds only what is missing', async () => {
      names = { CTC: 'CTC (renamed)', ORT: 'Orthodox', GRN: 'Green' };
      const result = await runSeeders(migratorDb, [seeder], logger);
      expect(result['probe-lookups']).toEqual({ inserted: 1, updated: 1 });
    });

    it('refuses unsafe identifiers', async () => {
      await expect(
        withTransaction(migratorDb, (tx) => seedRows(tx, 'probe_lookup; DROP', 'code', [])),
      ).rejects.toThrow(/unsafe table/);
    });
  });
});
