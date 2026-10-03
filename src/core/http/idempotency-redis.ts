import { createHash } from 'node:crypto';

import type { RedisClient } from '../redis/redis.js';
import type { IdempotencyEntry, IdempotencyStore, StoredResponse } from './idempotency.js';

/**
 * Idempotency records in Redis, shared by every API process (Spec P4 §5.2). Reservation is atomic:
 * `SET … NX PX`. Only one process can claim a key, so two copies of the same retried request can never
 * both run.
 */
export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(private readonly redis: RedisClient) {}

  /** Bounded key length whatever the endpoint path; the user/endpoint/key triple is hashed. */
  private key(storeKey: string): string {
    return `idem:${createHash('sha256').update(storeKey).digest('hex')}`;
  }

  async reserve(storeKey: string, fingerprint: string, ttlMs: number): Promise<IdempotencyEntry | null> {
    const key = this.key(storeKey);
    const entry: IdempotencyEntry = { state: 'in_progress', fingerprint };
    for (let attempt = 0; attempt < 2; attempt++) {
      const ok = await this.redis.set(key, JSON.stringify(entry), 'PX', ttlMs, 'NX');
      if (ok === 'OK') return null;
      const existing = await this.redis.get(key);
      if (existing !== null) return JSON.parse(existing) as IdempotencyEntry;
      // Expired between SET and GET: try once more.
    }
    throw new Error('idempotency reservation contended');
  }

  async complete(
    storeKey: string,
    fingerprint: string,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<void> {
    const entry: IdempotencyEntry = { state: 'completed', fingerprint, response };
    await this.redis.set(this.key(storeKey), JSON.stringify(entry), 'PX', ttlMs);
  }

  async release(storeKey: string): Promise<void> {
    await this.redis.del(this.key(storeKey));
  }
}
