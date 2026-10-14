import { createConnection, type Connection } from 'mariadb';
import type { Logger } from 'pino';

import type { Database } from '../db/prisma.js';
import { poolConfigFromUrl } from '../db/prisma.js';
import { withTransaction } from '../db/transaction.js';
import { checkCron, nextRun } from './cron.js';
import type { JobQueue } from './queue.js';
import { jobDefinition, type ScheduleDefinition } from './registry.js';
import { createJob } from './store.js';

/**
 * The scheduler (P14 §2.1: "Exactly 1"). It fires recurring jobs; it never runs them (a worker does).
 *
 * Singularity is asserted at start-up with a MySQL named lock held on a connection of its own: a second
 * scheduler cannot take it and refuses to start, and the lock goes with the connection if the process
 * dies, so a crashed scheduler never blocks its replacement. As a second line, firing a schedule is a
 * compare-and-set on its next_run_at, so even two schedulers could not fire one slot twice.
 */

export class SchedulerLockHeld extends Error {
  constructor(lockName: string) {
    super(`another scheduler is running (it holds the lock ${lockName}); exactly one may run (P14 §2.1)`);
    this.name = 'SchedulerLockHeld';
  }
}

export interface SchedulerLock {
  readonly name: string;
  release(): Promise<void>;
}

/** Lock names are server-wide: the database name keeps two installations on one server apart. */
export function schedulerLockName(databaseUrl: string): string {
  const database = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ''));
  return `rupai.scheduler.${database}`.slice(0, 64);
}

/**
 * Takes the scheduler lock or throws SchedulerLockHeld. `onLost` is called if the lock's connection
 * fails: the lock is gone with it, so the process must exit and be restarted by its supervisor.
 */
export async function acquireSchedulerLock(
  database: { url: string; allowPublicKeyRetrieval: boolean },
  onLost: (err: unknown) => void,
): Promise<SchedulerLock> {
  const { connectionLimit: _unused, ...config } = poolConfigFromUrl(database.url, {
    poolSize: 1,
    allowPublicKeyRetrieval: database.allowPublicKeyRetrieval,
  });
  const name = schedulerLockName(database.url);
  const conn: Connection = await createConnection(config);
  const [row] = await conn.query<{ got: number | bigint | null }[]>('SELECT GET_LOCK(?, 0) AS got', [name]);
  if (Number(row?.got ?? 0) !== 1) {
    await conn.end();
    throw new SchedulerLockHeld(name);
  }
  let released = false;
  // Keep the connection alive (and notice at once if it is lost).
  const timer = setInterval(() => {
    conn.ping().catch((err: unknown) => {
      if (!released) {
        released = true;
        clearInterval(timer);
        onLost(err);
      }
    });
  }, 15_000);
  timer.unref();
  return {
    name,
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [name]);
      } finally {
        await conn.end();
      }
    },
  };
}

export interface SchedulerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly timezone: string;
  readonly queue: JobQueue;
}

const seconds = (d: Date) => {
  const c = new Date(d);
  c.setUTCMilliseconds(0);
  return c;
};

/** Checks the definitions (a bad cron or an unknown job type stops the scheduler from starting). */
export function checkSchedules(defs: readonly ScheduleDefinition[], timezone: string): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const d of defs) {
    if (names.has(d.name)) problems.push(`schedule ${d.name} is defined twice`);
    names.add(d.name);
    if (!/^[a-z][a-z0-9_.]*$/.test(d.name)) problems.push(`schedule ${d.name}: bad name`);
    const cron = checkCron(d.cron, timezone);
    if (cron) problems.push(`schedule ${d.name}: cron "${d.cron}" ${cron}`);
    const job = jobDefinition(d.jobType);
    if (!job) problems.push(`schedule ${d.name}: no job is registered as ${d.jobType}`);
    else if (!job.payload.safeParse(d.payload ?? {}).success)
      problems.push(`schedule ${d.name}: bad payload`);
  }
  return problems;
}

/**
 * One row per definition. A new schedule starts at its next slot; a changed cron is re-timed. Pausing
 * is the only state an administrator changes, and it survives a sync.
 */
export async function syncSchedules(
  deps: Pick<SchedulerDeps, 'db' | 'timezone'>,
  defs: readonly ScheduleDefinition[],
  now = new Date(),
): Promise<void> {
  for (const d of defs) {
    const row = await deps.db.jobSchedule.findUnique({ where: { name: d.name } });
    if (!row) {
      await deps.db.jobSchedule.create({
        data: {
          name: d.name,
          jobType: d.jobType,
          cron: d.cron,
          nextRunAt: nextRun(d.cron, now, deps.timezone),
        },
      });
    } else if (row.cron !== d.cron || row.jobType !== d.jobType || row.nextRunAt === null) {
      await deps.db.jobSchedule.update({
        where: { id: row.id },
        data: {
          cron: d.cron,
          jobType: d.jobType,
          nextRunAt: nextRun(d.cron, now, deps.timezone),
          version: { increment: 1 },
          updatedAt: seconds(now),
        },
      });
    }
  }
}

export interface FireResult {
  readonly name: string;
  readonly jobId: bigint | null;
  /** fired: a job was created. busy: the last run is still queued or running, so this slot is skipped. */
  readonly outcome: 'fired' | 'busy' | 'raced';
}

/**
 * Fires every schedule that is due. A schedule that missed several slots (the scheduler was down) fires
 * once, not once per missed slot, and moves on to its next future slot.
 */
export async function fireDueSchedules(
  deps: SchedulerDeps,
  defs: readonly ScheduleDefinition[],
  now = new Date(),
): Promise<FireResult[]> {
  const byName = new Map(defs.map((d) => [d.name, d]));
  const due = await deps.db.jobSchedule.findMany({
    where: { isPaused: false, nextRunAt: { lte: now } },
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
  });
  const results: FireResult[] = [];
  for (const row of due) {
    const def = byName.get(row.name);
    if (!def) continue; // removed from the code: kept as history, never fired
    const r = await withTransaction(deps.db, async (tx) => {
      // Compare-and-set on the slot: of two schedulers (which the lock should prevent), one fires.
      const moved = await tx.jobSchedule.updateMany({
        where: { id: row.id, nextRunAt: row.nextRunAt, isPaused: false },
        data: {
          nextRunAt: nextRun(def.cron, now, deps.timezone),
          lastRunAt: seconds(now),
          version: { increment: 1 },
          updatedAt: seconds(now),
        },
      });
      if (moved.count !== 1) return { name: row.name, jobId: null, outcome: 'raced' as const };
      const { job, created } = await createJob(tx, {
        type: def.jobType,
        payload: def.payload ?? {},
        dedupeKey: `schedule:${def.name}`,
        scheduleName: def.name,
      });
      if (created) await tx.jobSchedule.update({ where: { id: row.id }, data: { lastJobId: job.id } });
      return { name: row.name, jobId: job.id, outcome: created ? ('fired' as const) : ('busy' as const) };
    });
    if (r.outcome === 'fired') await deps.queue.dispatch(r.jobId);
    if (r.outcome === 'busy')
      deps.logger.warn({ schedule: r.name }, 'previous run still going; this slot is skipped');
    else if (r.outcome === 'fired')
      deps.logger.info({ schedule: r.name, job_id: String(r.jobId) }, 'schedule fired');
    results.push(r);
  }
  return results;
}

/** Runs `fireDueSchedules` every `tickSeconds`. */
export function startScheduleLoop(
  deps: SchedulerDeps,
  defs: readonly ScheduleDefinition[],
  tickSeconds = 15,
): { stop(): Promise<void> } {
  let current: Promise<unknown> = Promise.resolve();
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    current = fireDueSchedules(deps, defs)
      .catch((err: unknown) => {
        deps.logger.error({ err }, 'schedule tick failed');
      })
      .finally(() => {
        busy = false;
      });
  }, tickSeconds * 1000);
  return {
    async stop() {
      clearInterval(timer);
      await current;
    },
  };
}
