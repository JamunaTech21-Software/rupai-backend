import { createHash } from 'node:crypto';

import type { RequestHandler, Response } from 'express';

import { getRequestContext } from '../context/request-context.js';
import { AppError, Errors } from '../errors/app-error.js';

/**
 * Idempotency-Key for write and transition endpoints (Spec P4 §5.2).
 *
 * The network can fail after the server committed, typically on approve or post. A client that retries
 * with the same Idempotency-Key gets the ORIGINAL response back instead of a second approval. Combined
 * with the posting_link constraint (Spec P3 §27.5), a retried approval is safe at both the API and the
 * database layer.
 *
 *   key unseen                    → reserve, run the handler, store the response for 24 h
 *   same key + same request       → replay the stored response (header Idempotent-Replayed: true)
 *   same key + different request  → 422 IDEMPOTENCY_KEY_REUSED
 *   same key, first still running → 409 IDEMPOTENCY_IN_PROGRESS (Retry-After: 1)
 *   handler answered 5xx          → the reservation is released, so a retry runs again
 *
 * Records are keyed by user, endpoint and key, and retained for 24 hours.
 */

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export type IdempotencyEntry =
  | { readonly state: 'in_progress'; readonly fingerprint: string }
  | { readonly state: 'completed'; readonly fingerprint: string; readonly response: StoredResponse };

/**
 * Storage for idempotency records. It must make `reserve` atomic (set-if-absent).
 * MemoryIdempotencyStore is for development and tests. RedisIdempotencyStore (idempotency-redis.ts) is
 * used whenever REDIS_URL is set, because several API processes must see the same records.
 */
export interface IdempotencyStore {
  /** Atomically reserves the key, or returns the existing entry. */
  reserve(key: string, fingerprint: string, ttlMs: number): Promise<IdempotencyEntry | null>;
  complete(key: string, fingerprint: string, response: StoredResponse, ttlMs: number): Promise<void>;
  release(key: string): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { entry: IdempotencyEntry; expiresAt: number }>();

  reserve(key: string, fingerprint: string, ttlMs: number): Promise<IdempotencyEntry | null> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > now) return Promise.resolve(existing.entry);
    this.entries.set(key, { entry: { state: 'in_progress', fingerprint }, expiresAt: now + ttlMs });
    return Promise.resolve(null);
  }

  complete(key: string, fingerprint: string, response: StoredResponse, ttlMs: number): Promise<void> {
    this.entries.set(key, {
      entry: { state: 'completed', fingerprint, response },
      expiresAt: Date.now() + ttlMs,
    });
    return Promise.resolve();
  }

  release(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }
}

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;
/** Response headers worth replaying. Everything else is regenerated per request. */
const REPLAYED_HEADERS = ['etag', 'location'];

/** Stable JSON: object keys sorted, so the same payload always gives the same fingerprint. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function captureHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of REPLAYED_HEADERS) {
    const v = res.getHeader(h);
    if (v !== undefined) out[h] = String(v);
  }
  return out;
}

export interface IdempotencyOptions {
  readonly store: IdempotencyStore;
  /** Refuse requests without the header. Mandatory for device sync batches (Spec P12 §7.3). */
  readonly required?: boolean;
  readonly ttlMs?: number;
}

export function idempotency({
  store,
  required = false,
  ttlMs = IDEMPOTENCY_TTL_MS,
}: IdempotencyOptions): RequestHandler {
  return async (req, res, next) => {
    const key = req.get('Idempotency-Key');
    if (key === undefined || key === '') {
      if (required) {
        throw Errors.validation([
          {
            field: 'Idempotency-Key',
            code: 'VALIDATION_FAILED',
            message: 'This endpoint requires an Idempotency-Key header.',
          },
        ]);
      }
      next();
      return;
    }
    if (!KEY_FORMAT.test(key)) {
      throw Errors.malformed('Idempotency-Key must be 8–128 characters of letters, digits, "-" or "_".');
    }

    const actor = getRequestContext()?.actorId ?? 'anonymous';
    const endpoint = `${req.method} ${req.originalUrl.split('?')[0] ?? ''}`;
    const storeKey = `${actor}|${endpoint}|${key}`;
    const fingerprint = createHash('sha256')
      .update(`${endpoint}\n${canonical(req.body)}`)
      .digest('hex');

    const existing = await store.reserve(storeKey, fingerprint, ttlMs);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request.',
          [
            {
              field: 'Idempotency-Key',
              code: 'IDEMPOTENCY_KEY_REUSED',
              message: 'Generate a new key for a new attempt.',
            },
          ],
        );
      }
      if (existing.state === 'in_progress') {
        throw new AppError(
          'IDEMPOTENCY_IN_PROGRESS',
          'The original request with this Idempotency-Key is still being processed.',
          [],
          { 'Retry-After': '1' },
        );
      }
      for (const [h, v] of Object.entries(existing.response.headers)) res.setHeader(h, v);
      res.setHeader('Idempotent-Replayed', 'true');
      if (existing.response.body === undefined) res.status(existing.response.status).end();
      else res.status(existing.response.status).json(existing.response.body);
      return;
    }

    // First attempt: capture the response so a retry can replay it.
    let settled = false;
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      settled = true;
      const status = res.statusCode;
      const done =
        status >= 500
          ? store.release(storeKey)
          : store.complete(storeKey, fingerprint, { status, body, headers: captureHeaders(res) }, ttlMs);
      void done.finally(() => originalJson(body));
      return res;
    };
    res.on('finish', () => {
      if (settled) return; // stored via res.json
      if (res.statusCode >= 500) void store.release(storeKey);
      else
        void store.complete(
          storeKey,
          fingerprint,
          { status: res.statusCode, body: undefined, headers: captureHeaders(res) },
          ttlMs,
        );
    });
    next();
  };
}
