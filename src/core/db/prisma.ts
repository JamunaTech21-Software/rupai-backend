import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import type { PoolConfig } from 'mariadb';

import type { Config } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { scopeExtension } from '../scope/extension.js';
import { SCOPED_MODELS, type ScopeRegistry } from '../scope/scoped-models.js';

export type Database = PrismaClient;

/** Default limits for interactive transactions. Transactions must stay short (Spec P2 §3.5). */
export const TRANSACTION_DEFAULTS = {
  isolationLevel: 'ReadCommitted',
  maxWait: 5_000,
  timeout: 15_000,
} as const;

/**
 * Turns a mysql:// URL into driver pool settings. Decoding happens here so that passwords containing
 * reserved characters work when URL-encoded.
 */
export function poolConfigFromUrl(
  url: string,
  options: { poolSize: number; allowPublicKeyRetrieval: boolean },
): PoolConfig {
  const u = new URL(url);
  if (u.protocol !== 'mysql:') throw new Error('database URL must use the mysql:// scheme');
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (!database) throw new Error('database URL must name a database');

  return {
    host: u.hostname,
    port: u.port ? Number.parseInt(u.port, 10) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    connectionLimit: options.poolSize,
    allowPublicKeyRetrieval: options.allowPublicKeyRetrieval,
    // The server stores UTC and so does the connection. Display timezone is applied at the edge (P2 §2.7).
    timezone: 'Z',
    charset: 'utf8mb4',
  };
}

/**
 * Creates the application's Prisma client. It connects as the DML-only app account (Spec P14 §5.2),
 * defaults every interactive transaction to READ COMMITTED (Spec P2 §2.8), and filters every query on a
 * scoped model by the request's data scope (P1.03, core/scope/extension.ts).
 *
 * Create one per process and pass it down. Call `$disconnect()` on shutdown.
 */
export function createDatabase(
  config: Pick<Config, 'database'>,
  options: { scopedModels?: ScopeRegistry } = {},
): Database {
  const adapter = new PrismaMariaDb(
    poolConfigFromUrl(config.database.url, {
      poolSize: config.database.poolSize,
      allowPublicKeyRetrieval: config.database.allowPublicKeyRetrieval,
    }),
  );
  const client = new PrismaClient({ adapter, transactionOptions: TRANSACTION_DEFAULTS });
  // A query-only extension leaves every model's type unchanged, so the client keeps the plain type.
  return client.$extends(scopeExtension(options.scopedModels ?? SCOPED_MODELS)) as unknown as Database;
}
