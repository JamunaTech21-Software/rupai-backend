import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Connection } from 'mariadb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROBE_DIR, connect, createTempDatabase, prismaProbe, type TempDatabase } from './helpers.js';

/**
 * P0.03 verification: the SQL-first Prisma workflow (BACKLOG §2.1) keeps what Prisma cannot express,
 * migrations are idempotent, and the drift check catches a model/SQL mismatch.
 */
describe('SQL-first Prisma workflow', () => {
  let tmp: TempDatabase;
  let app: Connection;

  beforeAll(async () => {
    tmp = await createTempDatabase();
    const deploy = prismaProbe(tmp, ['migrate', 'deploy']);
    expect(deploy.status, deploy.stdout + deploy.stderr).toBe(0);
    app = await connect('app', tmp.name);
  });

  afterAll(async () => {
    await app.end();
    await tmp.drop();
  });

  describe('migrations', () => {
    it('running migrate deploy again is a no-op', () => {
      const again = prismaProbe(tmp, ['migrate', 'deploy']);
      expect(again.status).toBe(0);
      expect(again.stdout).toContain('No pending migrations to apply');
    });

    it('the hand-written generated column and CHECK survive the migration', async () => {
      const [row] = await app.query<{ 'Create Table': string }[]>(`SHOW CREATE TABLE probe_item`);
      const ddl = row?.['Create Table'] ?? '';
      expect(ddl).toMatch(/`active_key` varchar\(60\).*GENERATED ALWAYS AS/);
      expect(ddl).toContain('CONSTRAINT `ck_probe_item_planted_le_gross` CHECK');
    });
  });

  describe('generated column enforces a partial unique rule ("one active per code")', () => {
    it('allows many inactive rows but only one active row per code', async () => {
      await app.query(
        `INSERT INTO probe_item (code, status, gross_area) VALUES ('F-01','inactive',10),('F-01','inactive',10),('F-01','active',10)`,
      );
      await expect(
        app.query(`INSERT INTO probe_item (code, status, gross_area) VALUES ('F-01','active',10)`),
      ).rejects.toMatchObject({ errno: 1062 }); // ER_DUP_ENTRY
    });

    it('cannot be written directly', async () => {
      await expect(
        app.query(
          `INSERT INTO probe_item (code, status, gross_area, active_key) VALUES ('F-02','active',1,'x')`,
        ),
      ).rejects.toMatchObject({ errno: 3105 }); // value for generated column not allowed
    });
  });

  describe('CHECK constraint', () => {
    it('rejects planted_area greater than gross_area', async () => {
      await expect(
        app.query(
          `INSERT INTO probe_item (code, status, gross_area, planted_area) VALUES ('F-03','x',10,10.001)`,
        ),
      ).rejects.toMatchObject({ errno: 3819 }); // ER_CHECK_CONSTRAINT_VIOLATED
    });

    it('accepts planted_area equal to gross_area', async () => {
      await app.query(
        `INSERT INTO probe_item (code, status, gross_area, planted_area) VALUES ('F-04','x',10,10)`,
      );
    });
  });

  describe('per-table grants make a table append-only for the app account', () => {
    it('allows UPDATE and DELETE where the migration granted them', async () => {
      await app.query(`UPDATE probe_item SET status = 'closed' WHERE code = 'F-04'`);
      await app.query(`DELETE FROM probe_item WHERE code = 'F-04'`);
    });

    it('refuses UPDATE and DELETE on the append-only table', async () => {
      await app.query(`INSERT INTO probe_log (message) VALUES ('written once')`);
      await expect(app.query(`UPDATE probe_log SET message = 'rewritten'`)).rejects.toMatchObject({
        errno: 1142, // ER_TABLEACCESS_DENIED_ERROR
      });
      await expect(app.query(`DELETE FROM probe_log`)).rejects.toMatchObject({ errno: 1142 });
    });
  });

  describe('drift check', () => {
    it('reports no drift when schema.prisma matches the migrations', () => {
      const run = prismaProbe(tmp, [
        'migrate',
        'diff',
        '--from-migrations',
        'migrations',
        '--to-schema',
        'schema.prisma',
        '--exit-code',
      ]);
      expect(run.status, run.stdout + run.stderr).toBe(0);
    });

    it('fails (exit 2) when the model changes without a migration', () => {
      const dir = mkdtempSync(join(tmpdir(), 'rupai-drift-'));
      try {
        const drifted = join(dir, 'schema.prisma');
        copyFileSync(join(PROBE_DIR, 'schema.prisma'), drifted);
        const original = readFileSync(drifted, 'utf8');
        writeFileSync(
          drifted,
          original.replace('message   String   @db.VarChar(200)', 'message   String   @db.VarChar(500)'),
        );
        const run = prismaProbe(tmp, [
          'migrate',
          'diff',
          '--from-migrations',
          'migrations',
          '--to-schema',
          drifted,
          '--exit-code',
        ]);
        expect(run.status, run.stdout + run.stderr).toBe(2);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
