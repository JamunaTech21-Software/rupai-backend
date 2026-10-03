import { Router } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { idempotency } from '../../src/core/http/idempotency.js';
import { RedisIdempotencyStore } from '../../src/core/http/idempotency-redis.js';
import { createRateLimiter } from '../../src/core/http/rate-limit.js';
import { sendOne } from '../../src/core/http/response.js';
import { redisPlatform } from '../../src/core/platform.js';
import { createRedis, type RedisClient } from '../../src/core/redis/redis.js';
import { buildTestApp } from '../helpers/test-app.js';

/**
 * P0.07: idempotency records and rate-limit counters in Redis are SHARED between API processes. Two
 * app instances built here stand in for two processes behind the reverse proxy.
 */
describe('Redis-backed platform', () => {
  let redis: RedisClient;
  const redisUrl = inject('testRedisUrl');

  beforeAll(async () => {
    redis = createRedis(redisUrl);
    await redis.connect();
  });
  afterAll(async () => {
    await redis.quit();
  });

  describe('RedisIdempotencyStore', () => {
    it('lets exactly one of many concurrent reservations win (SET NX)', async () => {
      const store = new RedisIdempotencyStore(redis);
      const key = `race-${String(Date.now())}`;
      const results = await Promise.all(Array.from({ length: 20 }, () => store.reserve(key, 'fp', 60_000)));
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(results.filter((r) => r?.state === 'in_progress')).toHaveLength(19);
    });

    it('stores a completed response for replay, and release clears the key', async () => {
      const store = new RedisIdempotencyStore(redis);
      const key = `done-${String(Date.now())}`;
      await store.reserve(key, 'fp', 60_000);
      await store.complete(key, 'fp', { status: 200, body: { ok: true }, headers: { etag: '"2"' } }, 60_000);
      expect(await store.reserve(key, 'fp', 60_000)).toEqual({
        state: 'completed',
        fingerprint: 'fp',
        response: { status: 200, body: { ok: true }, headers: { etag: '"2"' } },
      });
      await store.release(key);
      expect(await store.reserve(key, 'fp', 60_000)).toBeNull();
    });

    it('expires records after their TTL', async () => {
      const store = new RedisIdempotencyStore(redis);
      const key = `ttl-${String(Date.now())}`;
      await store.reserve(key, 'fp', 50);
      await new Promise((r) => setTimeout(r, 120));
      expect(await store.reserve(key, 'fp', 60_000)).toBeNull();
    });

    it('keys are namespaced and bounded (rupai:idem:<sha256>)', async () => {
      const store = new RedisIdempotencyStore(redis);
      await store.reserve('x'.repeat(5000), 'fp', 60_000);
      const keys = await redis.keys('idem:*'); // keyPrefix is applied by ioredis
      expect(keys.every((k) => /^rupai:idem:[0-9a-f]{64}$/.test(k))).toBe(true);
    });
  });

  describe('shared across two API processes', () => {
    function twoProcesses(limit: number) {
      const platform = redisPlatform(redis);
      const name = `test-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`;
      let runs = 0;
      const sharedStore = () => {
        const store = platform.rateLimitStore(name);
        if (!store) throw new Error('the Redis platform must provide a rate-limit store');
        return store;
      };
      const build = () => {
        const router = Router();
        router.get(
          '/limited',
          createRateLimiter({ name, limit, windowMs: 60_000, store: sharedStore() }),
          (_q, res) => {
            sendOne(res, { ok: true });
          },
        );
        router.post('/approve', idempotency({ store: platform.idempotencyStore }), (_q, res) => {
          runs += 1;
          sendOne(res, { run: runs });
        });
        return buildTestApp({}, [{ name: 't', path: '/t', router }], platform).app;
      };
      return { a: build(), b: build(), runs: () => runs };
    }

    it('a retried approval sent to the OTHER process is replayed, not run again', async () => {
      const { a, b, runs } = twoProcesses(100);
      const key = `cross-${String(Date.now())}`;
      const first = await request(a).post('/api/v1/t/approve').set('Idempotency-Key', key).send({});
      const retry = await request(b).post('/api/v1/t/approve').set('Idempotency-Key', key).send({});
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(runs()).toBe(1);
    });

    it('rate-limit counts are shared: the limit applies across processes, not per process', async () => {
      const { a, b } = twoProcesses(2);
      await request(a).get('/api/v1/t/limited').expect(200);
      await request(b).get('/api/v1/t/limited').expect(200);
      const third = await request(a).get('/api/v1/t/limited');
      expect(third.status).toBe(429);
      expect(third.body.error.code).toBe('RATE_LIMITED');
    });

    it('rate-limit keys are namespaced once: rupai:rl:<limiter>:<ip or user>', async () => {
      const { a } = twoProcesses(5);
      await request(a).get('/api/v1/t/limited').expect(200);
      const keys = (await redis.call('KEYS', '*rl:*')) as string[]; // raw: returns full key names
      // The app's default read/write limiters write here too.
      expect(keys.some((k) => /^rupai:rl:test-[^:]+:ip:/.test(k))).toBe(true);
      expect(keys.every((k) => /^rupai:rl:[a-z0-9-]+:(ip|user):.+$/.test(k))).toBe(true);
    });
  });

  describe('readiness', () => {
    it('/health/ready reports Redis', async () => {
      const app = buildTestApp({}, [], redisPlatform(redis)).app;
      const res = await request(app).get('/health/ready');
      expect(res.body.data.checks.redis).toBe('ok');
    });

    it('/health/ready is 503 when Redis is unreachable', async () => {
      const dead = createRedis('redis://127.0.0.1:1');
      const app = buildTestApp({}, [], redisPlatform(dead)).app;
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.data.checks.redis).toBe('failing');
      dead.disconnect();
    });
  });
});
