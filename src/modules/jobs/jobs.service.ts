import type { z } from 'zod';

import { auditUpdate, type AuditedRecord } from '../../core/audit/audit.js';
import { holdsPermission, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { HEARTBEAT_SECONDS } from '../../core/jobs/heartbeat.js';
import type { JobQueue } from '../../core/jobs/queue.js';
import { jobDefinition, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { createJob, wholeSecond } from '../../core/jobs/store.js';
import type { Job, Prisma } from '../../generated/prisma/client.js';
import type { JobOut, ProcessOut, ScheduleOut, SelfTestBody } from './jobs.schema.js';

/** The job resource, the schedules and the process list (Spec P4 §5.3, §14.1, P14 §2.1, §10). */

type JobOutT = z.infer<typeof JobOut>;
type JobRow = Job & { requester: { id: bigint; username: string } | null };

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const POLL_AFTER_SECONDS = 5;

export function toJobOut(j: JobRow): JobOutT {
  const live = j.state === 'queued' || j.state === 'running';
  return {
    id: j.id.toString(),
    job_id: j.id.toString(),
    type: j.type,
    label: jobDefinition(j.type)?.label ?? j.type,
    state: j.state as JobOutT['state'],
    progress: { done: j.progressDone, total: j.progressTotal },
    poll_after_seconds: live ? POLL_AFTER_SECONDS : null,
    attempts: j.attempts,
    max_attempts: j.maxAttempts,
    next_attempt_at: j.state === 'queued' && j.attempts > 0 ? iso(j.availableAt) : null,
    queued_at: j.queuedAt.toISOString(),
    started_at: iso(j.startedAt),
    finished_at: iso(j.finishedAt),
    result: (j.result as Record<string, unknown> | null) ?? null,
    error: j.errorCode ? { code: j.errorCode, message: j.errorMessage ?? '' } : null,
    requested_by: j.requester ? { id: j.requester.id.toString(), username: j.requester.username } : null,
    schedule: j.scheduleName,
    expires_at: iso(j.expiresAt),
  };
}

const JOB_AUDIT: AuditedRecord = { type: 'job', class: 'operational', fields: ['state'] };
const SCHEDULE_AUDIT: AuditedRecord = { type: 'job_schedule', class: 'master', fields: ['is_paused'] };
const include = { requester: { select: { id: true, username: true } } } as const;

const values = (q: ListQuery, field: string) =>
  q.filters
    .filter((f) => f.field === field)
    .flatMap((f) => (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]));

export interface JobsServiceDeps {
  readonly db: Database;
  readonly queue: JobQueue;
  readonly authz: PermissionResolver;
}

export function jobsService({ db, queue, authz }: JobsServiceDeps) {
  /** Everyone sees the jobs they started; system.view sees every job (scheduled ones included). */
  const seesAll = () => holdsPermission(authz, 'system.view');

  async function visible(id: bigint, actorId: bigint): Promise<JobRow> {
    const j = await db.job.findUnique({ where: { id }, include });
    // Someone else's job is not found, rather than forbidden (P4 §4.3).
    if (!j || (j.requestedBy !== actorId && !(await seesAll()))) throw Errors.notFound('No such job.');
    return j;
  }

  return {
    async list(q: ListQuery, actorId: bigint): Promise<{ items: JobOutT[]; total: number }> {
      const all = await seesAll();
      const states = values(q, 'state');
      const types = values(q, 'type');
      const requester = values(q, 'requested_by')[0];
      const mine = values(q, 'mine')[0] === 'true';
      const where: Prisma.JobWhereInput = {
        ...(states.length ? { state: { in: states } } : {}),
        ...(types.length ? { type: { in: types } } : {}),
        ...(!all || mine ? { requestedBy: actorId } : requester ? { requestedBy: BigInt(requester) } : {}),
      };
      const { page, perPage } = q.page ?? { page: 1, perPage: 25 };
      const [rows, total] = await Promise.all([
        db.job.findMany({
          where,
          include,
          orderBy: { id: 'desc' },
          skip: (page - 1) * perPage,
          take: perPage,
        }),
        db.job.count({ where }),
      ]);
      return { items: rows.map(toJobOut), total };
    },

    async get(id: bigint, actorId: bigint): Promise<JobOutT> {
      return toJobOut(await visible(id, actorId));
    },

    /** Starts a job for a user: one live job per key, and the queue is told after the commit. */
    async start(input: Parameters<typeof createJob>[1]): Promise<JobOutT> {
      const { job, created } = await withTransaction(db, (tx) => createJob(tx, input));
      if (created) await queue.dispatch(job.id);
      return toJobOut(await db.job.findUniqueOrThrow({ where: { id: job.id }, include }));
    },

    async selfTest(body: z.infer<typeof SelfTestBody>, actorId: bigint): Promise<JobOutT> {
      return this.start({ type: 'system.self_test', payload: body, requestedBy: actorId });
    },

    /**
     * Sends a failed job round again, from where it stopped: its checkpoint and processing keys are
     * kept, so nothing it already did is repeated. The dead letter's way back (P4 §5.3).
     */
    async retry(id: bigint, actorId: bigint): Promise<JobOutT> {
      await withTransaction(db, async (tx) => {
        const j = await tx.job.findUnique({ where: { id } });
        if (!j) throw Errors.notFound('No such job.');
        if (j.state !== 'failed') {
          throw new AppError(
            'INVALID_TRANSITION',
            `Only a failed job can be retried; this one is ${j.state}.`,
            [
              {
                code: 'INVALID_TRANSITION',
                message: 'Retry is for failed jobs.',
                context: { state: j.state },
              },
            ],
          );
        }
        if (j.dedupeKey !== null && (await tx.job.findUnique({ where: { activeKey: j.dedupeKey } }))) {
          throw new AppError(
            'INVALID_TRANSITION',
            'The same work is already queued or running in another job.',
            [
              {
                code: 'INVALID_TRANSITION',
                message: 'Wait for the other job.',
                context: { dedupe_key: j.dedupeKey },
              },
            ],
          );
        }
        await tx.job.update({
          where: { id },
          data: {
            state: 'queued',
            attempts: 0,
            availableAt: wholeSecond(),
            finishedAt: null,
            expiresAt: null,
            version: { increment: 1 },
            updatedAt: new Date(),
          },
        });
        await auditUpdate(tx, JOB_AUDIT, id, { state: 'failed' }, { state: 'queued' }, { actorId });
      });
      await queue.dispatch(id);
      return toJobOut(await db.job.findUniqueOrThrow({ where: { id }, include }));
    },
  };
}

export interface SchedulesServiceDeps {
  readonly db: Database;
  readonly queue: JobQueue;
  readonly timezone: string;
  readonly schedules: readonly ScheduleDefinition[];
}

export function schedulesService({ db, queue, timezone, schedules }: SchedulesServiceDeps) {
  const defOf = (name: string) => {
    const d = schedules.find((s) => s.name === name);
    if (!d) throw Errors.notFound('No such schedule.');
    return d;
  };

  async function out(name: string): Promise<z.infer<typeof ScheduleOut>> {
    const d = defOf(name);
    const row = await db.jobSchedule.findUnique({ where: { name } });
    const last = row?.lastJobId ? await db.job.findUnique({ where: { id: row.lastJobId } }) : null;
    return {
      name: d.name,
      description: d.description,
      job_type: d.jobType,
      job_label: jobDefinition(d.jobType)?.label ?? d.jobType,
      cron: d.cron,
      timezone,
      is_paused: row?.isPaused ?? false,
      next_run_at: iso(row?.nextRunAt ?? null),
      last_run_at: iso(row?.lastRunAt ?? null),
      last_job: last
        ? { id: last.id.toString(), state: last.state as JobOutT['state'], finished_at: iso(last.finishedAt) }
        : null,
      version: row?.version ?? 0,
    };
  }

  async function setPaused(name: string, paused: boolean, actorId: bigint) {
    defOf(name);
    await withTransaction(db, async (tx) => {
      const row = await tx.jobSchedule.findUnique({ where: { name } });
      // The scheduler creates the row when it first starts.
      if (!row) throw new AppError('INVALID_TRANSITION', 'The scheduler has not started yet.', []);
      if (row.isPaused === paused) return;
      await tx.jobSchedule.update({
        where: { id: row.id },
        data: { isPaused: paused, version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId },
      });
      await auditUpdate(
        tx,
        SCHEDULE_AUDIT,
        row.id,
        { is_paused: row.isPaused },
        { is_paused: paused },
        { actorId },
      );
    });
    return out(name);
  }

  return {
    async list() {
      return Promise.all(schedules.map((s) => out(s.name)));
    },
    get: out,
    pause: (name: string, actorId: bigint) => setPaused(name, true, actorId),
    resume: (name: string, actorId: bigint) => setPaused(name, false, actorId),
    /** Runs a schedule's job now, outside its timetable. Its next scheduled run is unchanged. */
    async runNow(name: string, actorId: bigint) {
      const d = defOf(name);
      const { job, created } = await withTransaction(db, (tx) =>
        createJob(tx, {
          type: d.jobType,
          payload: d.payload ?? {},
          dedupeKey: `schedule:${d.name}`,
          scheduleName: d.name,
          requestedBy: actorId,
        }),
      );
      if (created) await queue.dispatch(job.id);
      return toJobOut(await db.job.findUniqueOrThrow({ where: { id: job.id }, include }));
    },
  };
}

export async function listProcesses(db: Database): Promise<z.infer<typeof ProcessOut>[]> {
  const rows = await db.processHeartbeat.findMany({ orderBy: [{ kind: 'asc' }, { processKey: 'asc' }] });
  const cutoff = Date.now() - 3 * HEARTBEAT_SECONDS * 1000;
  return rows.map((r) => ({
    kind: r.kind as 'scheduler' | 'worker',
    key: r.processKey,
    host: r.host,
    pid: r.pid,
    app_version: r.appVersion,
    started_at: r.startedAt.toISOString(),
    last_beat_at: r.beatAt.toISOString(),
    stopped_at: iso(r.stoppedAt),
    is_alive: r.stoppedAt === null && r.beatAt.getTime() >= cutoff,
  }));
}
