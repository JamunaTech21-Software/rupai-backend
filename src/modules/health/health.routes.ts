import { z } from 'zod';

import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import type { PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { sendOne } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import type { Platform } from '../../core/platform.js';
import type { FileStorage } from '../../core/storage/storage.js';
import { healthService } from './health.service.js';

/** HTTP surface of the operational health view (P1.18; Spec P4 §14.1). */

export interface HealthDeps {
  readonly config: Config;
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly storage: FileStorage;
}

const STATUSES = ['ok', 'warning', 'critical', 'unknown', 'not_applicable'] as const;

export const HealthOut = z.object({
  /** The worst check: ok, warning, critical, or unknown when a check could not be read. */
  status: z.enum(['ok', 'warning', 'critical', 'unknown']),
  as_of: z.string(),
  took_ms: z.number().int(),
  version: z.object({
    app: z.string(),
    commit: z.string(),
    environment: z.string(),
    node: z.string(),
    uptime_seconds: z.number().int(),
  }),
  checks: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      status: z.enum(STATUSES),
      value: z.string().nullable(),
      detail: z.string(),
      data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    }),
  ),
});

export function healthModule({ config, db, platform, authz, accessLog, storage }: HealthDeps): ApiModule {
  const svc = healthService({ db, config, storage });
  const m = defineModule({
    name: 'system-health',
    path: '/system',
    tag: 'System',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/health',
    summary: 'System health',
    description:
      'The morning check and what a monitor polls (P14 §10). One check per signal: database and its ' +
      'connections, slow queries, the job queue and failed jobs, workers, the scheduler and late schedules, ' +
      'disk, the last backup, failed logins. Signals whose source comes later are listed as not_applicable ' +
      'with the phase. A check that cannot be read is unknown; the page itself always answers. The public ' +
      'liveness and readiness probes stay at /health and /health/ready.',
    auth: { permission: 'system.view' },
    success: { status: 200, description: 'The health report', schema: HealthOut },
    errors: [],
    handler: async (_req, res) => {
      const report = await svc.report();
      res.setHeader('Cache-Control', 'no-store');
      sendOne(res, report satisfies z.infer<typeof HealthOut>);
    },
  });

  return m.build();
}
