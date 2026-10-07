import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import type { PoolConfig } from 'mariadb';

import type { Config } from '../../config/env.js';
import { PrismaClient } from '../../generated/prisma/client.js';
import { getRequestContext } from '../context/request-context.js';
import { scopeExtension, type ScopeDenialHooks } from '../scope/extension.js';
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
  return client.$extends(
    scopeExtension(options.scopedModels ?? SCOPED_MODELS, scopeDenialHooks(client)),
  ) as unknown as Database;
}

interface Delegate {
  findUnique(args: { where: unknown }): Promise<unknown>;
}
const stringify = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)).slice(0, 100);

/**
 * Scope denials go to the access log (P4 §4.3: "the access_log records it as a scope denial regardless
 * of what the caller was told"). Both hooks use the PLAIN client: outside the scope filter, and outside
 * the caller's transaction, so the denial is recorded even though the request fails.
 */
function scopeDenialHooks(client: PrismaClient): ScopeDenialHooks {
  return {
    async exists(model, where) {
      const delegate = (client as unknown as Record<string, Delegate | undefined>)[
        model.charAt(0).toLowerCase() + model.slice(1)
      ];
      if (!delegate) return false;
      const row = await delegate.findUnique({ where }).catch(() => null);
      return row !== null && row !== undefined;
    },
    async denied({ model, operation, target }) {
      const ctx = getRequestContext();
      await client.accessLog
        .create({
          data: {
            userId: ctx?.actorId && /^\d+$/.test(ctx.actorId) ? BigInt(ctx.actorId) : null,
            eventType: 'scope_denied',
            module: model.slice(0, 40),
            recordReference: stringify(target),
            ipAddress: ctx?.clientIp ?? null,
            userAgent: ctx?.userAgent ?? null,
            detail: { operation },
          },
        })
        .catch(() => undefined); // never turn a 404 into a 500
    },
  };
}
