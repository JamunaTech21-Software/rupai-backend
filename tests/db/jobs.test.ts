import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { z } from 'zod';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import { startHeartbeat } from '../../src/core/jobs/heartbeat.js';
import { noQueue, redisConsumer, redisQueue } from '../../src/core/jobs/queue.js';
import {
  defineJob,
  PermanentJobError,
  registerJob,
  type ScheduleDefinition,
} from '../../src/core/jobs/registry.js';
import { runJob, type RunnerDeps } from '../../src/core/jobs/runner.js';
import {
  acquireSchedulerLock,
  fireDueSchedules,
  SchedulerLockHeld,
  syncSchedules,
} from '../../src/core/jobs/scheduler.js';
import { claimProcessingKey, createJob, wholeSecond } from '../../src/core/jobs/store.js';
import { startWorker } from '../../src/core/jobs/worker.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules, JOB_CATALOGUE_SCHEDULES } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P1.15 — the job system on real MySQL: the job resource, idempotent and resumable runs, leases, retries
 * and the dead letter, the worker's poll, the singleton scheduler, and the HTTP surface.
 */

const ADMIN = '1';
let mdb: MigratedDatabase;
let app: Express;
let runner: RunnerDeps;
let timezone = '';
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

interface Body {
  id: string;
  state: string;
  [k: string]: unknown;
}
const one = (res: { body: unknown }) => (res.body as { data: Body }).data;
const many = (res: { body: unknown }) => (res.body as { data: Body[] }).data;
const json = (res: { status: number; body: unknown }) => `${String(res.status)} ${JSON.stringify(res.body)}`;
const get = (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, body: object = {}, actor = ADMIN) =>
  as(request(app).post(`/api/v1${path}`), actor).send(body);
async function ok(r: request.Test, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return one(res);
}

const job = (id: bigint) => mdb.migrator.job.findUniqueOrThrow({ where: { id } });
/** Makes a queued job due now (skips its backoff), or a running one's lease lapse. */
const due = (id: bigint) =>
  mdb.migrator.$executeRaw`UPDATE job SET available_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND,
    lease_until = CASE WHEN state = 'running' THEN UTC_TIMESTAMP() - INTERVAL 1 SECOND END WHERE id = ${id}`;
const selfTest = async (payload: object, requestedBy: bigint | null = 1n) =>
  (
    await createJob(mdb.db, {
      type: 'system.self_test',
      payload: { steps: 4, step_ms: 0, fail_attempts: 0, ...payload },
      requestedBy,
    })
  ).job.id;

// ---- stand-in jobs, written as a real module's would be -------------------------------------------

/** Each step makes one effect (a processing key) and checkpoints. Optionally hangs after a given step. */
const hangs = new Map<bigint, { afterStep: number; release: () => void }>();
const effectsJob = defineJob({
  type: 'test.effects',
  label: 'Test effects',
  payload: z.object({ steps: z.number().int() }),
  async run(ctx) {
    const from = (ctx.checkpoint as { next?: number } | null)?.next ?? 0;
    let made = 0;
    let skipped = 0;
    for (let i = from; i < ctx.payload.steps; i += 1) {
      const fresh = await withTransaction(mdb.db, (tx) =>
        ctx.once(tx, `test:${ctx.jobId.toString()}:step:${String(i)}`),
      );
      if (fresh) made += 1;
      else skipped += 1;
      const hang = hangs.get(ctx.jobId);
      if (hang && ctx.attempt === 1 && i === hang.afterStep) {
        // The effect is committed, the checkpoint is not: exactly where a kill hurts most.
        await new Promise<void>((resolve) => {
          hang.release = resolve;
          ctx.signal.addEventListener('abort', () => {
            resolve();
          });
        });
        ctx.signal.throwIfAborted();
      }
      await ctx.progress(i + 1, ctx.payload.steps, { next: i + 1 });
    }
    return { result: { made, skipped } };
  },
});
const permanentJob = defineJob({
  type: 'test.permanent',
  label: 'Always refused',
  payload: z.object({}),
  run() {
    throw new PermanentJobError('NOTHING_TO_DO', 'This can never succeed.');
  },
});
const patientJob = defineJob({
  type: 'test.patient',
  label: 'Waits until stopped',
  payload: z.object({}),
  async run(ctx) {
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener('abort', () => {
        resolve();
      });
    });
    ctx.signal.throwIfAborted();
    return undefined;
  },
});

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  timezone = config.timezone;
  const deps = testModuleDeps({
    config,
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
  });
  app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
    authenticate: testActor(),
  });
  registerJob(effectsJob);
  registerJob(permanentJob);
  registerJob(patientJob);
  runner = { db: mdb.db, logger: silentLogger(), leaseSeconds: 30, retentionDays: 7 };
}, 180_000);

afterAll(async () => {
  await mdb.drop();
});

describe('the job resource and its contract', () => {
  it('runs a job to completion, with progress, a result and a retention date', async () => {
    const id = await selfTest({ steps: 5 });
    expect((await job(id)).state).toBe('queued');
    expect(await runJob(runner, id)).toEqual({ outcome: 'completed' });
    const j = await job(id);
    expect(j).toMatchObject({
      state: 'completed',
      attempts: 1,
      progressDone: 5,
      progressTotal: 5,
      runToken: null,
    });
    expect(j.result).toMatchObject({ steps: 5, performed_this_attempt: 5, processing_keys: 5 });
    const days = ((j.expiresAt?.getTime() ?? 0) - (j.finishedAt?.getTime() ?? 0)) / 86_400_000;
    expect(days).toBe(7);
    // A redelivery of a finished job does nothing.
    expect(await runJob(runner, id)).toEqual({ outcome: 'skipped' });
  });

  it('returns the live job for the same (document, purpose) instead of starting a second', async () => {
    const key = `test_doc:${unique('')}:calculate`;
    const input = { type: 'test.effects', payload: { steps: 1 }, dedupeKey: key };
    const [a, b] = await Promise.all([createJob(mdb.db, input), createJob(mdb.db, input)]);
    expect(a.job.id).toBe(b.job.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    await runJob(runner, a.job.id);
    // Finished: the next request starts a new one.
    const c = await createJob(mdb.db, input);
    expect(c.created).toBe(true);
    expect(c.job.id).not.toBe(a.job.id);
  });

  it('lets exactly one of several simultaneous runs hold a job', async () => {
    const id = (await createJob(mdb.db, { type: 'test.effects', payload: { steps: 3 } })).job.id;
    const results = await Promise.all([1, 2, 3, 4].map(() => runJob(runner, id)));
    expect(results.filter((r) => r.outcome === 'completed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'skipped')).toHaveLength(3);
    expect(await mdb.migrator.jobProcessingKey.count({ where: { jobId: id } })).toBe(3);
  });

  it('a killed run is taken over once its lease lapses, resumes, and repeats no effect', async () => {
    const id = (await createJob(mdb.db, { type: 'test.effects', payload: { steps: 6 } })).job.id;
    hangs.set(id, { afterStep: 2, release: () => undefined });
    const first = runJob(runner, id); // makes effects 0, 1, 2, checkpoints 0 and 1, then "dies"
    for (
      let i = 0;
      i < 50 && (await mdb.migrator.jobProcessingKey.count({ where: { jobId: id } })) < 3;
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // Its lease lapses (as when the process is killed and stops renewing it).
    await due(id);
    const second = await runJob(runner, id);
    expect(second).toEqual({ outcome: 'completed' });
    // The first run wakes up to find it has lost the job, and its result is discarded.
    hangs.get(id)?.release();
    expect(await first).toEqual({ outcome: 'lost' });
    const j = await job(id);
    expect(j.attempts).toBe(2);
    // Steps 0–1 were checkpointed; step 2 was made but not checkpointed, so it is found, not repeated.
    expect(j.result).toEqual({ made: 3, skipped: 1 });
    const keys = await mdb.migrator.jobProcessingKey.findMany({ where: { jobId: id } });
    expect(keys).toHaveLength(6);
    expect(new Set(keys.map((k) => k.key)).size).toBe(6);
  });

  it('a processing key claimed in a transaction that rolls back is free again', async () => {
    const key = `test_doc:${unique('')}:post`;
    await expect(
      withTransaction(mdb.db, async (tx) => {
        expect(await claimProcessingKey(tx, key, null)).toBe(true);
        throw new Error('the effect failed');
      }),
    ).rejects.toThrow('the effect failed');
    expect(await withTransaction(mdb.db, (tx) => claimProcessingKey(tx, key, null))).toBe(true);
    expect(await withTransaction(mdb.db, (tx) => claimProcessingKey(tx, key, null))).toBe(false);
  });

  it('retries a failed attempt after a backoff, resuming where it stopped', async () => {
    const id = await selfTest({ steps: 6, fail_attempts: 1 });
    expect(await runJob(runner, id)).toEqual({ outcome: 'retry', retryInSeconds: 5 });
    let j = await job(id);
    expect(j).toMatchObject({ state: 'queued', attempts: 1, errorCode: 'JOB_FAILED', progressDone: 3 });
    expect(j.availableAt.getTime()).toBeGreaterThan(Date.now());
    // Not before its backoff.
    expect(await runJob(runner, id)).toEqual({ outcome: 'skipped' });
    await due(id);
    expect(await runJob(runner, id)).toEqual({ outcome: 'completed' });
    j = await job(id);
    expect(j.result).toMatchObject({ resumed_from_step: 3, performed_this_attempt: 3, processing_keys: 6 });
    expect(j.errorCode).toBeNull();
  });

  it('fails for good after its last attempt: the dead letter, kept and visible', async () => {
    const id = await selfTest({ steps: 2, fail_attempts: 5 });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      expect((await runJob(runner, id)).outcome).toBe('retry');
      await due(id);
    }
    expect(await runJob(runner, id)).toEqual({ outcome: 'failed' });
    const j = await job(id);
    expect(j).toMatchObject({ state: 'failed', attempts: 5, errorCode: 'JOB_FAILED' });
    expect(j.errorMessage).toContain('attempt 5');
    expect(j.expiresAt).not.toBeNull();
  });

  it('fails at once on a permanent error, an unknown type or a bad payload', async () => {
    const p = (await createJob(mdb.db, { type: 'test.permanent', payload: {} })).job.id;
    expect(await runJob(runner, p)).toEqual({ outcome: 'failed' });
    expect(await job(p)).toMatchObject({ state: 'failed', attempts: 1, errorCode: 'NOTHING_TO_DO' });

    const unknown = await mdb.migrator.job.create({
      data: { type: 'test.gone', payload: {}, maxAttempts: 3, availableAt: wholeSecond() },
    });
    expect(await runJob(runner, unknown.id)).toEqual({ outcome: 'failed' });
    expect((await job(unknown.id)).errorCode).toBe('UNKNOWN_JOB_TYPE');

    const bad = await mdb.migrator.job.create({
      data: { type: 'test.effects', payload: { steps: 'x' }, maxAttempts: 3, availableAt: wholeSecond() },
    });
    expect(await runJob(runner, bad.id)).toEqual({ outcome: 'failed' });
    expect((await job(bad.id)).errorCode).toBe('INVALID_JOB_PAYLOAD');
  });

  it('a run that died on its last attempt is failed, not retried', async () => {
    const id = (await createJob(mdb.db, { type: 'test.effects', payload: { steps: 1 } })).job.id;
    await mdb.migrator.$executeRaw`UPDATE job SET state = 'running', attempts = max_attempts,
      run_token = '01JQ7F0000000000000000DEAD', lease_until = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE id = ${id}`;
    expect(await runJob(runner, id)).toEqual({ outcome: 'failed' });
    expect(await job(id)).toMatchObject({ state: 'failed', errorCode: 'JOB_ABANDONED', runToken: null });
  });

  it('hands a job back unfinished on shutdown, without spending an attempt', async () => {
    const id = (await createJob(mdb.db, { type: 'test.patient', payload: {} })).job.id;
    const stop = new AbortController();
    const run = runJob(runner, id, { shutdown: stop.signal });
    for (let i = 0; i < 50 && (await job(id)).state !== 'running'; i += 1)
      await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    expect(await run).toEqual({ outcome: 'released' });
    expect(await job(id)).toMatchObject({ state: 'queued', attempts: 0, runToken: null, leaseUntil: null });
    await mdb.migrator.job.delete({ where: { id } });
  });

  it('the database refuses a job state the lifecycle does not allow', async () => {
    const id = await selfTest({});
    await expect(mdb.migrator.$executeRaw`UPDATE job SET state = 'running' WHERE id = ${id}`).rejects.toThrow(
      /ck_job_lease/,
    );
    await expect(mdb.migrator.$executeRaw`UPDATE job SET state = 'done' WHERE id = ${id}`).rejects.toThrow(
      /ck_job_state/,
    );
    // The app account may not rewrite history: processing keys are insert-only.
    await expect(mdb.db.$executeRaw`DELETE FROM job_processing_key`).rejects.toThrow(/DELETE command denied/);
    await runJob(runner, id);
  });
});

describe('the worker', () => {
  it('finds due jobs by polling, within its concurrency, and stops cleanly', async () => {
    await mdb.migrator.$executeRaw`UPDATE job SET state = 'failed', run_token = NULL, lease_until = NULL,
      finished_at = UTC_TIMESTAMP(), expires_at = UTC_TIMESTAMP() WHERE state IN ('queued', 'running')`;
    const ids = await Promise.all([1, 2, 3].map(() => selfTest({ steps: 2, step_ms: 50 })));
    const retries: bigint[] = [];
    const worker = startWorker({
      ...runner,
      concurrency: 2,
      pollSeconds: 3600,
      shutdownSeconds: 5,
      queue: noQueue((id) => retries.push(id)),
    });
    expect(await worker.poll()).toBe(2);
    expect(worker.active).toBe(2);
    await new Promise((r) => setTimeout(r, 400));
    expect(await worker.poll()).toBe(1);
    await worker.stop();
    for (const id of ids) expect((await job(id)).state).toBe('completed');
  });

  it('takes jobs from Redis as soon as they are queued', async () => {
    const redisUrl = inject('testRedisUrl');
    const worker = startWorker({
      ...runner,
      concurrency: 1,
      pollSeconds: 3600,
      shutdownSeconds: 5,
      queue: noQueue(),
    });
    const consumer = redisConsumer(redisUrl, silentLogger(), 1, (id) => worker.deliver(id));
    const queue = redisQueue(redisUrl, silentLogger());
    try {
      const id = await selfTest({ steps: 1 });
      await queue.dispatch(id);
      for (let i = 0; i < 100 && (await job(id)).state !== 'completed'; i += 1)
        await new Promise((r) => setTimeout(r, 50));
      expect((await job(id)).state).toBe('completed');
    } finally {
      await consumer.close();
      await queue.close();
      await worker.stop();
    }
  });
});

describe('the scheduler', () => {
  const database = () => ({ url: url('app', mdb.name), allowPublicKeyRetrieval: true });
  const SCHEDULE: ScheduleDefinition = {
    name: 'test.every_minute',
    description: 'Test',
    cron: '* * * * *',
    jobType: 'test.effects',
    payload: { steps: 1 },
  };
  const deps = () => ({ db: mdb.db, logger: silentLogger(), timezone, queue: noQueue() });

  it('refuses a second scheduler while the first holds the lock', async () => {
    const first = await acquireSchedulerLock(database(), () => undefined);
    await expect(acquireSchedulerLock(database(), () => undefined)).rejects.toBeInstanceOf(SchedulerLockHeld);
    await first.release();
    const again = await acquireSchedulerLock(database(), () => undefined);
    await again.release();
  });

  it('syncs one row per schedule, timed in the organisation’s timezone', async () => {
    const now = new Date('2026-10-14T05:00:00Z');
    await syncSchedules(deps(), JOB_CATALOGUE_SCHEDULES, now);
    const purge = await mdb.migrator.jobSchedule.findUniqueOrThrow({ where: { name: 'system.purge_jobs' } });
    // 03:00 in Dhaka (UTC+6) is 21:00 UTC the day before.
    expect(purge.nextRunAt?.toISOString()).toBe('2026-10-14T21:00:00.000Z');
    expect(await mdb.migrator.jobSchedule.count()).toBe(JOB_CATALOGUE_SCHEDULES.length);
  });

  it('fires a due schedule exactly once, even from two schedulers at once', async () => {
    await syncSchedules(deps(), [SCHEDULE]);
    await mdb.migrator.jobSchedule.update({
      where: { name: SCHEDULE.name },
      data: { nextRunAt: new Date(Date.now() - 3 * 3600_000) }, // three hours of missed slots
    });
    const [a, b] = await Promise.all([
      fireDueSchedules(deps(), [SCHEDULE]),
      fireDueSchedules(deps(), [SCHEDULE]),
    ]);
    const fired = [...a, ...b].filter((r) => r.outcome === 'fired');
    expect(fired).toHaveLength(1);
    const row = await mdb.migrator.jobSchedule.findUniqueOrThrow({ where: { name: SCHEDULE.name } });
    // Missed slots fire once; the next run is in the future.
    expect(row.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(row.lastJobId).toBe(fired[0]?.jobId);
    const j = await job(fired[0]?.jobId ?? 0n);
    expect(j).toMatchObject({
      scheduleName: SCHEDULE.name,
      requestedBy: null,
      dedupeKey: `schedule:${SCHEDULE.name}`,
    });

    // While that run is still queued, the next slot is skipped rather than starting a second.
    await mdb.migrator.jobSchedule.update({
      where: { name: SCHEDULE.name },
      data: { nextRunAt: new Date(Date.now() - 1000) },
    });
    expect((await fireDueSchedules(deps(), [SCHEDULE]))[0]?.outcome).toBe('busy');

    // Paused: not fired at all.
    await runJob(runner, j.id);
    await mdb.migrator.jobSchedule.update({
      where: { name: SCHEDULE.name },
      data: { nextRunAt: new Date(Date.now() - 1000), isPaused: true },
    });
    expect(await fireDueSchedules(deps(), [SCHEDULE])).toEqual([]);
  });

  it('records heartbeats, and a clean stop', async () => {
    const hb = await startHeartbeat(mdb.db, silentLogger(), { kind: 'worker', appVersion: 'test' });
    const r = await ok(get('/system/processes'));
    expect(r).toBeDefined();
    const live = many(await get('/system/processes')).find((p) => p.key === hb.key);
    expect(live).toMatchObject({ kind: 'worker', is_alive: true, stopped_at: null });
    await hb.stop();
    const stopped = many(await get('/system/processes')).find((p) => p.key === hb.key);
    expect(stopped).toMatchObject({ is_alive: false });
  });
});

describe('the scheduled jobs of the modules', () => {
  it('each runs to completion on the app account’s rights', async () => {
    for (const type of [
      'system.purge_jobs',
      'auth.purge_tokens',
      'role.concentration_review',
      'approval.recheck_unresolved',
    ]) {
      const id = (await createJob(mdb.db, { type, payload: {} })).job.id;
      expect(await runJob(runner, id), type).toEqual({ outcome: 'completed' });
    }
  });

  it('the purge removes finished jobs past retention, and nothing else', async () => {
    const old = await selfTest({});
    await runJob(runner, old);
    await mdb.migrator
      .$executeRaw`UPDATE job SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ${old}`;
    const fresh = await selfTest({});
    await runJob(runner, fresh);
    const waiting = await selfTest({});
    const purge = (await createJob(mdb.db, { type: 'system.purge_jobs', payload: {} })).job.id;
    await runJob(runner, purge);
    expect(await mdb.migrator.job.findUnique({ where: { id: old } })).toBeNull();
    expect(await mdb.migrator.job.findUnique({ where: { id: fresh } })).not.toBeNull();
    expect(await mdb.migrator.job.findUnique({ where: { id: waiting } })).not.toBeNull();
    // Its processing keys outlive it.
    expect(await mdb.migrator.jobProcessingKey.count({ where: { jobId: old } })).toBe(4);
  });
});

describe('HTTP', () => {
  let someone = '';
  let viewer = '';
  beforeAll(async () => {
    const u = await mdb.migrator.user.create({
      data: { username: unique('jobs'), passwordHash: 'x', createdBy: 1n },
    });
    someone = u.id.toString();
    const role = await ok(
      post('/roles', { code: unique('R_'), name: 'System viewer', permissions: ['system.view'] }),
      201,
    );
    const v = await mdb.migrator.user.create({
      data: { username: unique('sysv'), passwordHash: 'x', createdBy: 1n },
    });
    viewer = v.id.toString();
    const current = await get(`/users/${viewer}`);
    const set = await as(request(app).post(`/api/v1/users/${viewer}/roles`), ADMIN)
      .set('If-Match', `"${String(one(current).version as number)}"`)
      .send({ roles: [{ role_id: role.id }] });
    expect(set.status, json(set)).toBe(200);
  });

  it('starts the self-test with 202 and a pollable job', async () => {
    const j = await ok(post('/jobs/self-test', { steps: 3, step_ms: 0 }), 202);
    expect(j).toMatchObject({
      type: 'system.self_test',
      label: 'Job system self-test',
      state: 'queued',
      progress: { done: 0, total: null },
      poll_after_seconds: 5,
      requested_by: { id: ADMIN },
    });
    expect(j.job_id).toBe(j.id);
    await runJob(runner, BigInt(j.id));
    const done = await ok(get(`/jobs/${j.id}`));
    expect(done).toMatchObject({
      state: 'completed',
      progress: { done: 3, total: 3 },
      poll_after_seconds: null,
      error: null,
    });
    expect(done.result).toMatchObject({ steps: 3, processing_keys: 3 });
    // Starting it needs system.edit.
    expect((await post('/jobs/self-test', {}, viewer)).status).toBe(403);
  });

  it('shows a job to whoever started it, to system.view, and to nobody else', async () => {
    const mine = await selfTest({}, BigInt(someone));
    const admins = await selfTest({}, 1n);
    expect((await get(`/jobs/${mine.toString()}`, someone)).status).toBe(200);
    expect((await get(`/jobs/${admins.toString()}`, someone)).status).toBe(404);
    expect((await get(`/jobs/${admins.toString()}`, viewer)).status).toBe(200);

    const ownList = many(await get('/jobs', someone));
    expect(ownList.map((j) => j.id)).toEqual([mine.toString()]);
    const everyone = many(await get('/jobs?per_page=100', viewer)).map((j) => j.id);
    expect(everyone).toEqual(expect.arrayContaining([mine.toString(), admins.toString()]));
    const live = many(await get('/jobs?filter[mine]=true&filter[state][in]=queued,running', someone));
    expect(live.map((j) => j.id)).toEqual([mine.toString()]);
  });

  it('retries a failed job from the dead letter, and only a failed one', async () => {
    const id = (await createJob(mdb.db, { type: 'test.permanent', payload: {} })).job.id;
    await runJob(runner, id);
    const listed = many(await get('/jobs?filter[state]=failed&per_page=100')).map((j) => j.id);
    expect(listed).toContain(id.toString());
    const again = await ok(post(`/jobs/${id.toString()}/retry`), 202);
    expect(again).toMatchObject({ state: 'queued', attempts: 0, error: { code: 'NOTHING_TO_DO' } });
    expect((await post(`/jobs/${id.toString()}/retry`)).status).toBe(409);
    expect((await post(`/jobs/${id.toString()}/retry`, {}, viewer)).status).toBe(403);
    await runJob(runner, id);
  });

  it('lists, pauses, resumes and runs the schedules', async () => {
    await syncSchedules({ db: mdb.db, timezone }, JOB_CATALOGUE_SCHEDULES);
    const list = many(await get('/system/schedules'));
    expect(list.map((s) => s.name)).toEqual(JOB_CATALOGUE_SCHEDULES.map((s) => s.name));
    expect(list[0]).toMatchObject({ timezone: 'Asia/Dhaka', is_paused: false });

    expect(await ok(post('/system/schedules/approval.recheck_unresolved/pause'))).toMatchObject({
      is_paused: true,
    });
    expect(await ok(post('/system/schedules/approval.recheck_unresolved/resume'))).toMatchObject({
      is_paused: false,
    });
    expect((await post('/system/schedules/approval.recheck_unresolved/pause', {}, viewer)).status).toBe(403);
    expect((await post('/system/schedules/no.such/pause')).status).toBe(404);

    const run = await ok(post('/system/schedules/approval.recheck_unresolved/run'), 202);
    expect(run).toMatchObject({
      type: 'approval.recheck_unresolved',
      schedule: 'approval.recheck_unresolved',
    });
    // Still queued: running it again returns the same job.
    const again = await ok(post('/system/schedules/approval.recheck_unresolved/run'), 202);
    expect(again.id).toBe(run.id);
    await runJob(runner, BigInt(run.id));
    expect((await get('/system/schedules', someone)).status).toBe(403);
  });
});
