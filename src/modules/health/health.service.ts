import { access, readdir, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { Config } from '../../config/env.js';
import type { Database } from '../../core/db/prisma.js';
import { HEARTBEAT_SECONDS } from '../../core/jobs/heartbeat.js';
import type { FileStorage } from '../../core/storage/storage.js';

/**
 * GET /system/health (P1.18; Spec P4 §14.1, P14 §9.5, §10.1): the operational view somebody reads every
 * morning (O-20) and a monitor polls. One check per signal of P14 Table 10.1 that exists in Phase 1;
 * the others are listed as not yet applicable, with the phase that brings them, so nothing is silently
 * missing.
 *
 * Each check is independent: one that throws is `unknown`, never a failed page.
 */

export type CheckStatus = 'ok' | 'warning' | 'critical' | 'unknown' | 'not_applicable';

export interface HealthCheck {
  readonly key: string;
  readonly label: string;
  readonly status: CheckStatus;
  /** The figure, as text: "12 / 200 (6 %)", "3", "14 h ago". */
  readonly value: string | null;
  /** What it means, or what to do. */
  readonly detail: string;
  /** Machine-readable figures for a chart or a monitor. */
  readonly data: Readonly<Record<string, string | number | boolean | null>>;
}

/** Thresholds (P14 Table 10.1). */
export const THRESHOLDS = {
  diskWarningPct: 75,
  diskCriticalPct: 85,
  connectionsWarningPct: 70,
  connectionsCriticalPct: 90,
  /** A due job not started for this long means no worker is taking jobs. */
  queueWarningMinutes: 5,
  queueCriticalMinutes: 30,
  /** A schedule this late has not fired: the scheduler is stuck. */
  scheduleLateMinutes: 10,
  backupCriticalHours: 26,
  failedLoginsWarningPerHour: 20,
} as const;

const ALIVE_MS = 3 * HEARTBEAT_SECONDS * 1000;
const RANK: Readonly<Record<CheckStatus, number>> = {
  ok: 0,
  not_applicable: 0,
  unknown: 1,
  warning: 2,
  critical: 3,
};

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${String(m)} min ago`;
  const h = Math.round(m / 6) / 10;
  return h < 48 ? `${String(h)} h ago` : `${String(Math.round(h / 24))} days ago`;
};
/** The directory itself, or the nearest one above it that exists (the uploads directory is made on first use). */
async function existing(dir: string): Promise<string> {
  let at = resolve(dir);
  for (;;) {
    try {
      await access(at);
      return at;
    } catch {
      const up = dirname(at);
      if (up === at) return at;
      at = up;
    }
  }
}
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const check = (
  key: string,
  label: string,
  status: CheckStatus,
  value: string | null,
  detail: string,
  data: HealthCheck['data'] = {},
): HealthCheck => ({ key, label, status, value, detail, data });

/** Signals of P14 Table 10.1 whose source arrives later. */
const LATER: readonly (readonly [string, string, string])[] = [
  ['failed_postings', 'Failed postings', 'Phase 3 — Accounting'],
  ['consistency_checks', 'Consistency checks', 'Phase 11 — Reports & consistency'],
  ['device_fleet', 'Field devices without sync', 'Phase 12 — Mobile field app'],
  ['response_time', 'Response time (p95)', 'Read from the logs; a metrics store is Phase 13 — Hardening'],
  ['error_rate', '5xx error rate', 'Read from the logs; a metrics store is Phase 13 — Hardening'],
  ['certificate', 'Certificate expiry', 'At deployment (O-19)'],
];

export interface HealthDeps {
  readonly db: Database;
  readonly config: Config;
  readonly storage: FileStorage;
}

export function healthService({ db, config, storage }: HealthDeps) {
  async function database(): Promise<HealthCheck[]> {
    const started = Date.now();
    await db.$queryRaw`SELECT 1`;
    const latency = Date.now() - started;
    const status = await db.$queryRaw<{ Variable_name: string; Value: string }[]>`
      SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Max_used_connections', 'Slow_queries', 'Uptime')`;
    const [max] = await db.$queryRaw<{ m: bigint | number }[]>`SELECT @@max_connections AS m`;
    const v = (name: string) => Number(status.find((s) => s.Variable_name === name)?.Value ?? 0);
    const connected = v('Threads_connected');
    const limit = Number(max?.m ?? 0);
    const used = pct(connected, limit);
    return [
      check(
        'database',
        'Database',
        latency > 1000 ? 'warning' : 'ok',
        `${String(latency)} ms`,
        'Answers a query.',
        {
          latency_ms: latency,
          uptime_seconds: v('Uptime'),
        },
      ),
      check(
        'db_connections',
        'Database connections',
        used >= THRESHOLDS.connectionsCriticalPct
          ? 'critical'
          : used >= THRESHOLDS.connectionsWarningPct
            ? 'warning'
            : 'ok',
        `${String(connected)} / ${String(limit)} (${String(used)} %)`,
        `Pool of ${String(config.database.poolSize)} per process. At the ceiling the system looks completely down (P2 §3.3).`,
        {
          connected,
          max_connections: limit,
          used_pct: used,
          peak: v('Max_used_connections'),
          pool_size: config.database.poolSize,
        },
      ),
      check(
        'slow_queries',
        'Slow queries',
        'ok',
        String(v('Slow_queries')),
        'Since the database started; watch whether it rises.',
        {
          count: v('Slow_queries'),
        },
      ),
    ];
  }

  async function queue(): Promise<HealthCheck[]> {
    const now = new Date();
    const [due, running, oldest, failed24, failedOpen] = await Promise.all([
      db.job.count({ where: { state: 'queued', availableAt: { lte: now } } }),
      db.job.count({ where: { state: 'running' } }),
      db.job.findFirst({
        where: { state: 'queued', availableAt: { lte: now } },
        orderBy: { availableAt: 'asc' },
        select: { availableAt: true },
      }),
      db.job.count({ where: { state: 'failed', finishedAt: { gte: new Date(now.getTime() - 86_400_000) } } }),
      db.job.count({ where: { state: 'failed' } }),
    ]);
    const waitMin = oldest ? (now.getTime() - oldest.availableAt.getTime()) / 60_000 : 0;
    return [
      check(
        'queue',
        'Job queue',
        waitMin >= THRESHOLDS.queueCriticalMinutes
          ? 'critical'
          : waitMin >= THRESHOLDS.queueWarningMinutes
            ? 'warning'
            : 'ok',
        `${String(due)} waiting, ${String(running)} running`,
        oldest
          ? `The oldest has waited ${String(Math.round(waitMin))} min. Growing and not draining means no worker is taking jobs.`
          : 'Nothing waiting.',
        { waiting: due, running, oldest_wait_minutes: Math.round(waitMin) },
      ),
      check(
        'failed_jobs',
        'Failed jobs',
        failed24 > 0 ? 'warning' : 'ok',
        `${String(failed24)} in 24 h`,
        failedOpen > 0
          ? `${String(failedOpen)} failed job(s) kept: see GET /jobs?filter[state]=failed and retry them.`
          : 'None.',
        { last_24h: failed24, kept: failedOpen },
      ),
    ];
  }

  async function processes(): Promise<HealthCheck[]> {
    const cutoff = new Date(Date.now() - ALIVE_MS);
    const [workers, scheduler, late] = await Promise.all([
      db.processHeartbeat.count({ where: { kind: 'worker', beatAt: { gte: cutoff }, stoppedAt: null } }),
      db.processHeartbeat.findFirst({
        where: { kind: 'scheduler', stoppedAt: null },
        orderBy: { beatAt: 'desc' },
      }),
      db.jobSchedule.findMany({
        where: {
          isPaused: false,
          nextRunAt: { lt: new Date(Date.now() - THRESHOLDS.scheduleLateMinutes * 60_000) },
        },
        select: { name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    const lastRun = await db.jobSchedule.aggregate({ _max: { lastRunAt: true } });
    const schedulerAlive = scheduler !== null && scheduler.beatAt >= cutoff;
    const last = lastRun._max.lastRunAt;
    return [
      check(
        'workers',
        'Workers',
        workers === 0 ? 'critical' : 'ok',
        `${String(workers)} running`,
        workers === 0 ? 'No worker: jobs (imports, emails, payroll) silently stop.' : 'Taking jobs.',
        { alive: workers },
      ),
      check(
        'scheduler',
        'Scheduler',
        !schedulerAlive ? 'critical' : late.length > 0 ? 'warning' : 'ok',
        last ? `last run ${ago(Date.now() - last.getTime())}` : 'never ran',
        !schedulerAlive
          ? 'The scheduler is not running: no reminders, no purges, no reviews.'
          : late.length > 0
            ? `Late: ${late.map((l) => l.name).join(', ')}.`
            : 'Running, every schedule on time.',
        { alive: schedulerAlive, last_run_at: last?.toISOString() ?? null, late: late.length },
      ),
    ];
  }

  async function files(): Promise<HealthCheck[]> {
    await storage.check();
    const fs = await statfs(await existing(config.storage.dir));
    const total = fs.blocks * fs.bsize;
    const free = fs.bavail * fs.bsize;
    const used = pct(total - free, total);
    return [
      check(
        'disk',
        'Disk (uploads)',
        used >= THRESHOLDS.diskCriticalPct
          ? 'critical'
          : used >= THRESHOLDS.diskWarningPct
            ? 'warning'
            : 'ok',
        `${String(used)} % used`,
        `${mb(free)} free of ${mb(total)}. A full disk stops MySQL (P14 §10.1).`,
        { used_pct: used, free_bytes: free, total_bytes: total },
      ),
    ];
  }

  async function backup(): Promise<HealthCheck[]> {
    const dir = config.storage.backupDir;
    if (dir === null) {
      return [
        check(
          'backup',
          'Backup',
          'unknown',
          null,
          'BACKUP_DIR is not set, so the API cannot see the backups.',
        ),
      ];
    }
    const names = (await readdir(dir)).filter((n) => /^rupai-.*\.sql\.gz$/.test(n)).sort();
    const newest = names.at(-1);
    if (!newest) return [check('backup', 'Backup', 'critical', 'none', 'No backup has been written.')];
    const [last, previous] = await Promise.all([
      stat(join(dir, newest)),
      names.length > 1 ? stat(join(dir, names.at(-2) ?? newest)) : Promise.resolve(null),
    ]);
    const age = Date.now() - last.mtime.getTime();
    const halved = previous !== null && last.size < previous.size / 2;
    return [
      check(
        'backup',
        'Backup',
        age > THRESHOLDS.backupCriticalHours * 3_600_000 ? 'critical' : halved ? 'warning' : 'ok',
        `${ago(age)}, ${mb(last.size)}`,
        halved
          ? 'Less than half the size of the one before: a failing backup (P14 §9.5).'
          : `${String(names.length)} kept. Copy them off the machine too.`,
        {
          newest: newest,
          age_hours: Math.round(age / 360_000) / 10,
          size_bytes: last.size,
          previous_bytes: previous?.size ?? null,
        },
      ),
    ];
  }

  async function logins(): Promise<HealthCheck[]> {
    const n = await db.accessLog.count({
      where: { eventType: 'failed_login', occurredAt: { gte: new Date(Date.now() - 3_600_000) } },
    });
    return [
      check(
        'failed_logins',
        'Failed logins',
        n > THRESHOLDS.failedLoginsWarningPerHour ? 'warning' : 'ok',
        `${String(n)} in the last hour`,
        'An unusual rate is someone guessing passwords (P6 §11.4): see GET /audit/access-log.',
        { last_hour: n },
      ),
    ];
  }

  const GROUPS: readonly (readonly [string[], string, () => Promise<HealthCheck[]>])[] = [
    [['database', 'db_connections', 'slow_queries'], 'Database', database],
    [['queue', 'failed_jobs'], 'Job queue', queue],
    [['workers', 'scheduler'], 'Processes', processes],
    [['disk'], 'Disk', files],
    [['backup'], 'Backup', backup],
    [['failed_logins'], 'Failed logins', logins],
  ];

  return {
    async report() {
      const started = Date.now();
      const results = await Promise.all(
        GROUPS.map(async ([keys, label, run]) => {
          try {
            return await run();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return keys.map((k) =>
              check(k, label, 'unknown', null, `Could not be read: ${message.slice(0, 200)}`),
            );
          }
        }),
      );
      const checks = [
        ...results.flat(),
        ...LATER.map(([key, label, from]) =>
          check(key, label, 'not_applicable', null, `Not yet: ${from}.`, { available_from: from }),
        ),
      ];
      const worst = checks.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'ok');
      return {
        status: worst === 'not_applicable' ? 'ok' : worst,
        as_of: new Date().toISOString(),
        took_ms: Date.now() - started,
        version: {
          app: config.build.version,
          commit: config.build.commit,
          environment: config.appEnv,
          node: process.version,
          uptime_seconds: Math.round(process.uptime()),
        },
        checks,
      };
    },
  };
}
