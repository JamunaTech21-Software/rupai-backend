import type { Store } from 'express-rate-limit';
import type { Logger } from 'pino';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

import type { Config } from '../config/env.js';
import type { ReadinessCheck } from './http/health.js';
import { MemoryIdempotencyStore, type IdempotencyStore } from './http/idempotency.js';
import { RedisIdempotencyStore } from './http/idempotency-redis.js';
import { createRedis, redisCheck, type RedisClient } from './redis/redis.js';

/**
 * Shared infrastructure the HTTP layer and the modules depend on: where idempotency records and
 * rate-limit counters live, plus extra readiness checks.
 *
 *   REDIS_URL set   → Redis, shared by every API process (required in production)
 *   REDIS_URL unset → in-memory, per process (development and tests only)
 */
export interface Platform {
  readonly idempotencyStore: IdempotencyStore;
  /** A fresh rate-limit store for one named limiter, or undefined for the in-memory default. */
  readonly rateLimitStore: (name: string) => Store | undefined;
  readonly readinessChecks: readonly ReadinessCheck[];
  readonly redis: RedisClient | null;
  close(): Promise<void>;
}

export function memoryPlatform(): Platform {
  return {
    idempotencyStore: new MemoryIdempotencyStore(),
    rateLimitStore: () => undefined,
    readinessChecks: [],
    redis: null,
    close: () => Promise.resolve(),
  };
}

/** Builds the platform for a Redis client that is already connected. */
export function redisPlatform(redis: RedisClient): Platform {
  return {
    idempotencyStore: new RedisIdempotencyStore(redis),
    // ioredis applies its `rupai:` keyPrefix to these raw commands too, and the limiter's own key already
    // carries the class name, so the store adds only `rl:` → rupai:rl:<class>:<user|ip>.
    rateLimitStore: (_name) =>
      new RedisStore({
        prefix: 'rl:',
        sendCommand: (command: string, ...args: string[]) =>
          redis.call(command, ...args) as Promise<RedisReply>,
      }),
    readinessChecks: [redisCheck(redis)],
    redis,
    async close() {
      await redis.quit();
    },
  };
}

/** Creates the platform for this process. With Redis configured, the connection is opened first. */
export async function createPlatform(config: Pick<Config, 'redis'>, logger: Logger): Promise<Platform> {
  if (!config.redis.url) {
    logger.warn(
      'REDIS_URL not set: idempotency records and rate limits are in memory, per process. Development only.',
    );
    return memoryPlatform();
  }
  const redis = createRedis(config.redis.url);
  await redis.connect();
  return redisPlatform(redis);
}
