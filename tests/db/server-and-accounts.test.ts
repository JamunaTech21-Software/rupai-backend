import type { Connection } from 'mariadb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { connect } from './helpers.js';

/** P0.03: the MySQL server and the two accounts are configured as the spec requires. */
describe('MySQL server settings (Spec P2 §2.8, P14 §5.1)', () => {
  let conn: Connection;
  let row: Record<string, string | number>;

  beforeAll(async () => {
    conn = await connect('app', 'rupai');
    [row] = (await conn.query<Record<string, string | number>[]>(
      `SELECT VERSION() AS version, @@character_set_server AS charset, @@collation_server AS collation,
              @@default_storage_engine AS engine, @@transaction_isolation AS isolation,
              @@sql_mode AS sql_mode, @@log_bin AS log_bin, @@time_zone AS tz,
              @@innodb_flush_log_at_trx_commit AS flush`,
    )) as [Record<string, string | number>];
  });
  afterAll(async () => conn.end());

  it('runs MySQL 8.0 or later (generated columns, CTEs, JSON, CHECK)', () => {
    const [major] = String(row.version).split('.').map(Number);
    expect(major).toBeGreaterThanOrEqual(8);
  });

  it('uses utf8mb4 / utf8mb4_unicode_ci so Bengali text is storable', () => {
    expect(row.charset).toBe('utf8mb4');
    expect(row.collation).toBe('utf8mb4_unicode_ci');
  });

  it('uses InnoDB and READ COMMITTED', () => {
    expect(row.engine).toBe('InnoDB');
    expect(row.isolation).toBe('READ-COMMITTED');
  });

  it('is strict: money is never silently truncated', () => {
    expect(String(row.sql_mode)).toContain('STRICT_TRANS_TABLES');
  });

  it('has binary logging on (point-in-time recovery) and full durability', () => {
    expect(Number(row.log_bin)).toBe(1);
    expect(Number(row.flush)).toBe(1);
  });

  it('stores time in UTC', () => {
    expect(row.tz).toBe('+00:00');
  });
});

describe('application account rupai_app (Spec P14 §5.2)', () => {
  let conn: Connection;
  beforeAll(async () => {
    conn = await connect('app', 'rupai');
  });
  afterAll(async () => conn.end());

  it.each([
    ['CREATE TABLE', 'CREATE TABLE p003_should_fail (id INT PRIMARY KEY)'],
    ['DROP TABLE', 'DROP TABLE IF EXISTS any_table'],
    ['CREATE DATABASE', 'CREATE DATABASE p003_should_fail'],
  ])('cannot run DDL: %s', async (_label, sql) => {
    await expect(conn.query(sql)).rejects.toMatchObject({ errno: expect.any(Number) });
  });

  it('holds only SELECT and INSERT database-wide; UPDATE/DELETE come per table from migrations', async () => {
    const grants = (await conn.query<Record<string, string>[]>('SHOW GRANTS FOR CURRENT_USER()')).map(
      (g) => Object.values(g)[0] ?? '',
    );
    const dbWide = grants.find((g) => g.includes('ON `rupai`.*'));
    expect(dbWide).toMatch(/GRANT SELECT, INSERT ON `rupai`\.\*/);
    expect(grants.join('\n')).not.toMatch(/ALL PRIVILEGES|CREATE|DROP|ALTER/);
  });
});

describe('migration account rupai_migrator', () => {
  it('can create and drop tables (DDL)', async () => {
    const conn = await connect('migrator', 'rupai');
    try {
      await conn.query('CREATE TABLE p003_probe_ddl (id INT PRIMARY KEY)');
      await conn.query('DROP TABLE p003_probe_ddl');
    } finally {
      await conn.end();
    }
  });
});
