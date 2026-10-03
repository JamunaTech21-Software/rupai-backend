import { resolve } from 'node:path';

import { MySqlContainer, type StartedMySqlContainer } from '@testcontainers/mysql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

/**
 * Global setup for the `db` test project (P0.06, Spec P13 §8.1: integration tests run against a REAL
 * MySQL, never an in-memory substitute).
 *
 * By default it starts a throwaway MySQL 8.4 container with Testcontainers, configured exactly like the
 * local and production servers (the same conf.d settings and the same init script that creates the
 * migrator and app accounts). It needs only a running Docker daemon. Nothing has to be started by hand,
 * and the container is removed afterwards.
 *
 * It also starts a throwaway Redis 7.4 for the Redis-backed stores.
 *
 * To run against already-running servers instead (e.g. `npm run stack:up`, which is faster when
 * iterating), set TEST_DB_HOST (and optionally TEST_DB_PORT) and TEST_REDIS_URL.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    testDb: { host: string; port: number };
    /** redis:// URL of the test Redis. */
    testRedisUrl: string;
  }
}

const BACKEND = resolve(import.meta.dirname, '../..');
const MYSQL_IMAGE = 'mysql:8.4';

let container: StartedMySqlContainer | undefined;
let redisContainer: StartedTestContainer | undefined;
const REDIS_PASSWORD = 'rupai_redis_test';

async function setupRedis(project: TestProject): Promise<void> {
  if (process.env.TEST_REDIS_URL) {
    project.provide('testRedisUrl', process.env.TEST_REDIS_URL);
    return;
  }
  redisContainer = await new GenericContainer('redis:7.4-alpine')
    .withCommand(['redis-server', '--requirepass', REDIS_PASSWORD, '--maxmemory-policy', 'noeviction'])
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .start();
  project.provide(
    'testRedisUrl',
    `redis://:${REDIS_PASSWORD}@${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`,
  );
}

export async function setup(project: TestProject): Promise<void> {
  await setupRedis(project);
  const externalHost = process.env.TEST_DB_HOST;
  if (externalHost) {
    project.provide('testDb', {
      host: externalHost,
      port: Number.parseInt(process.env.TEST_DB_PORT ?? '3306', 10),
    });
    return;
  }

  container = await new MySqlContainer(MYSQL_IMAGE)
    .withRootPassword('rupai_root_test')
    .withCopyFilesToContainer([
      {
        source: resolve(BACKEND, 'docker/mysql/conf.d/rupai.cnf'),
        target: '/etc/mysql/conf.d/rupai.cnf',
        mode: 0o644,
      },
      {
        source: resolve(BACKEND, 'docker/mysql/init/01-databases-and-accounts.sql'),
        target: '/docker-entrypoint-initdb.d/01-databases-and-accounts.sql',
        mode: 0o644,
      },
    ])
    .withStartupTimeout(180_000)
    .start();

  project.provide('testDb', { host: container.getHost(), port: container.getPort() });
}

export async function teardown(): Promise<void> {
  await Promise.all([container?.stop(), redisContainer?.stop()]);
}
