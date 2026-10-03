import { Redis } from 'ioredis';

import type { ReadinessCheck } from '../http/health.js';

/**
 * Redis (Spec P14 §3.3): bound to localhost, password-protected, never exposed on a network interface.
 * One client per process, created at start-up and passed down. Keys are namespaced `rupai:<area>:…`.
 */
export type RedisClient = Redis;

export const KEY_PREFIX = 'rupai:';

export function createRedis(url: string): RedisClient {
  return new Redis(url, {
    keyPrefix: KEY_PREFIX,
    // Fail fast instead of queueing commands forever while Redis is down, so readiness reports it and
    // requests fail with a clear 500 rather than hanging.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    lazyConnect: true,
  });
}

export function redisCheck(redis: RedisClient): ReadinessCheck {
  return {
    name: 'redis',
    async run() {
      if (redis.status === 'wait') await redis.connect();
      await redis.ping();
    },
  };
}
