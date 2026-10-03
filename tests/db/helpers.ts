import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import { createConnection, type Connection } from 'mariadb';
import { inject } from 'vitest';

import type { Database } from '../../src/core/db/prisma.js';
import { withTransaction, type Tx } from '../../src/core/db/transaction.js';

/**
 * Database test helpers. The server is provided by tests/db/global-setup.ts: a Testcontainers MySQL 8.4
 * by default, or the server named by TEST_DB_HOST / TEST_DB_PORT. Account names and passwords come from
 * docker/mysql/init, which both use.
 */
const server = inject('testDb');

export const DB = {
  host: server.host,
  port: server.port,
  migrator: {
    user: 'rupai_migrator',
    password: process.env.TEST_DB_MIGRATOR_PASSWORD ?? 'rupai_migrator_dev',
  },
  app: { user: 'rupai_app', password: process.env.TEST_DB_APP_PASSWORD ?? 'rupai_app_dev' },
} as const;

type Account = keyof Pick<typeof DB, 'migrator' | 'app'>;

export function url(account: Account, database: string): string {
  const a = DB[account];
  return `mysql://${a.user}:${encodeURIComponent(a.password)}@${DB.host}:${DB.port}/${database}`;
}

export function connect(account: Account, database?: string): Promise<Connection> {
  const a = DB[account];
  return createConnection({
    host: DB.host,
    port: DB.port,
    user: a.user,
    password: a.password,
    allowPublicKeyRetrieval: true,
    ...(database ? { database } : {}),
  });
}

/** Tables the probe fixture migration grants UPDATE/DELETE on (see its migration.sql). */
const FIXTURE_GRANTED_TABLES = ['probe_item', 'probe_lookup'];

/** A throwaway database (rupai_tmp_*), plus its shadow, created by the migration account. */
export interface TempDatabase {
  readonly name: string;
  readonly shadow: string;
  drop(): Promise<void>;
}

export async function createTempDatabase(): Promise<TempDatabase> {
  const name = `rupai_tmp_${randomBytes(4).toString('hex')}`;
  const shadow = `${name}_shadow`;
  const conn = await connect('migrator');
  try {
    for (const db of [name, shadow]) {
      await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    }
  } finally {
    await conn.end();
  }

  return {
    name,
    shadow,
    async drop() {
      const c = await connect('migrator');
      try {
        for (const db of [name, shadow]) {
          // MySQL keeps table-level grants after a database is dropped, and the migration account
          // cannot read mysql.tables_priv. Revoke for every table that exists now plus every table a
          // fixture migration may have granted on (a shadow database may already be emptied).
          const existing = await c.query<{ t: string }[]>(
            `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
            [db],
          );
          const tables = new Set([...existing.map((r) => r.t), ...FIXTURE_GRANTED_TABLES]);
          for (const t of tables) {
            await c.query(`REVOKE IF EXISTS ALL PRIVILEGES ON \`${db}\`.\`${t}\` FROM '${DB.app.user}'@'%'`);
          }
          await c.query(`DROP DATABASE IF EXISTS \`${db}\``);
        }
      } finally {
        await c.end();
      }
    },
  };
}

export const BACKEND = resolve(import.meta.dirname, '../..');
export const PROBE_DIR = resolve(BACKEND, 'tests/fixtures/prisma-probe');

/** Runs the Prisma CLI against the probe fixture, pointed at the given temporary database. */
export function prismaProbe(tmp: TempDatabase, args: string[]) {
  return spawnSync(resolve(BACKEND, 'node_modules/.bin/prisma'), [...args, '--config', 'prisma.config.ts'], {
    cwd: PROBE_DIR,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      PRISMA_HIDE_UPDATE_MESSAGE: '1',
      PROBE_DATABASE_URL: url('migrator', tmp.name),
      PROBE_SHADOW_DATABASE_URL: url('migrator', tmp.shadow),
    },
    timeout: 120_000,
  });
}

class Rollback extends Error {}

/**
 * Per-test isolation: runs `work` in a transaction and ALWAYS rolls it back, so the test leaves the
 * database exactly as it found it. Use it for tests that write to a shared database. Suites that need
 * DDL or several connections use createTempDatabase() instead.
 */
export async function withRollback<T>(db: Database, work: (tx: Tx) => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  try {
    await withTransaction(db, async (tx) => {
      result = { value: await work(tx) };
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  if (!result) throw new Error('withRollback: work did not complete');
  return result.value;
}
