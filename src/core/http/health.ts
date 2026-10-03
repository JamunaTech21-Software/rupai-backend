import { Router } from 'express';

import type { Config } from '../../config/env.js';
import type { Database } from '../db/prisma.js';

/**
 * Process health endpoints for the reverse proxy and the process supervisor (Spec P14 §6). They are not
 * under /api/v1 and need no authentication:
 *
 *   GET /health        liveness: the process is up and serving. Never touches dependencies
 *   GET /health/ready  readiness: the database is reachable. 503 otherwise, so the proxy stops routing
 *                      to an instance that is still starting or has lost its database
 *
 * The richer operational view (queue depth, failed jobs, pool usage, reconciliation status) is the
 * authenticated /api/v1/system/health of P1.18.
 */

export interface ReadinessCheck {
  readonly name: string;
  run(): Promise<void>;
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout(p: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(t);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function databaseCheck(db: Database): ReadinessCheck {
  return {
    name: 'database',
    async run() {
      await db.$queryRaw`SELECT 1`;
    },
  };
}

export function healthRouter(deps: {
  config: Config;
  checks: readonly ReadinessCheck[];
  startedAt?: number;
}): Router {
  const router = Router();
  const startedAt = deps.startedAt ?? Date.now();

  router.get('/health', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      data: {
        status: 'ok',
        version: deps.config.build.version,
        commit: deps.config.build.commit,
        uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      },
    });
  });

  router.get('/health/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const results: Record<string, 'ok' | 'failing'> = {};
    await Promise.all(
      deps.checks.map(async (check) => {
        try {
          await withTimeout(check.run(), CHECK_TIMEOUT_MS);
          results[check.name] = 'ok';
        } catch {
          // The reason is deliberately not exposed: the endpoint is unauthenticated.
          results[check.name] = 'failing';
        }
      }),
    );
    const ready = Object.values(results).every((r) => r === 'ok');
    res.status(ready ? 200 : 503).json({ data: { status: ready ? 'ready' : 'not_ready', checks: results } });
  });

  return router;
}
