import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendAccepted, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { JobQueue } from '../../core/jobs/queue.js';
import type { ScheduleDefinition } from '../../core/jobs/registry.js';
import type { Platform } from '../../core/platform.js';
import {
  IdParams,
  JOB_STATES,
  JobOut,
  ProcessOut,
  ScheduleOut,
  ScheduleParams,
  SelfTestBody,
} from './jobs.schema.js';
import { jobsService, listProcesses, schedulesService } from './jobs.service.js';

/** HTTP surface of the job resource (P4 §5.3) and of the scheduler (P14 §2.1). */

export interface JobsDeps {
  readonly config: { readonly timezone: string };
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly jobs: JobQueue;
  readonly schedules: readonly ScheduleDefinition[];
}

const byId = { params: IdParams };
const byName = { params: ScheduleParams };
const all = (res: Parameters<typeof sendPage>[1], req: Parameters<typeof sendPage>[0], items: unknown[]) => {
  sendPage(req, res, items, {
    pagination: { page: 1, perPage: Math.max(items.length, 1) },
    total: items.length,
  });
};

function jobsResourceModule({ db, platform, authz, accessLog, jobs }: JobsDeps): ApiModule {
  const svc = jobsService({ db, queue: jobs, authz });
  const m = defineModule({ name: 'jobs', path: '/jobs', tag: 'Jobs', platform, authz, accessLog });
  const OWN = 'Everyone may follow the jobs they started; system.view sees every job.';

  m.route({
    method: 'get',
    path: '/',
    summary: 'List jobs',
    description:
      'Newest first. Your own jobs; with system.view, everyone’s (filter[mine]=true for yours only). The ' +
      'top bar’s running-jobs indicator is filter[mine]=true&filter[state][in]=queued,running (P5 §4.7). ' +
      'filter[state]=failed is the dead-letter list.',
    auth: { signedIn: true, reason: OWN },
    list: {
      pagination: 'page',
      filters: {
        state: { type: { enum: JOB_STATES }, ops: ['eq', 'in'] },
        type: { type: 'string', ops: ['eq', 'in'] },
        requested_by: { type: 'id', ops: ['eq'] },
        mine: { type: 'bool' },
      },
      sorts: [],
      maxPageSize: 100,
    },
    success: { status: 200, description: 'A page of jobs', schema: JobOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q, currentActorId());
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'post',
    path: '/self-test',
    summary: 'Run the job system self-test',
    description:
      'Starts a job of `steps` units, each guarded by a processing key. Stop the worker part way and it ' +
      'resumes; the result shows performed + found_already_done = steps. fail_attempts makes that many ' +
      'attempts fail, to show the retries and the failed (dead-letter) state.',
    auth: { permission: 'system.edit' },
    body: SelfTestBody,
    success: { status: 202, description: 'The job', schema: JobOut },
    errors: [],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: SelfTestBody });
      sendAccepted(res, await svc.selfTest(body, currentActorId()));
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Read a job',
    description:
      'Poll while queued or running, every poll_after_seconds, backing off to 10 s (P5 §4.7). completed and ' +
      'partial carry a result; failed carries the error. 404 if it is not yours to see.',
    auth: { signedIn: true, reason: OWN },
    ...byId,
    success: { status: 200, description: 'The job', schema: JobOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await svc.get(params.id, currentActorId()));
    },
  });

  m.route({
    method: 'post',
    path: '/:id/retry',
    summary: 'Retry a failed job',
    description:
      'Queues it again with a fresh set of attempts. It resumes from its checkpoint, and work it already ' +
      'did is not repeated. 409 INVALID_TRANSITION unless it failed, or while the same work is live in ' +
      'another job.',
    auth: { permission: 'system.edit' },
    ...byId,
    idempotent: true,
    success: { status: 202, description: 'The job, queued', schema: JobOut },
    errors: ['INVALID_TRANSITION'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendAccepted(res, await svc.retry(params.id, currentActorId()));
    },
  });

  return m.build();
}

function schedulesModule({ db, platform, authz, accessLog, jobs, config, schedules }: JobsDeps): ApiModule {
  const svc = schedulesService({ db, queue: jobs, timezone: config.timezone, schedules });
  const m = defineModule({
    name: 'schedules',
    path: '/system',
    tag: 'Jobs',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/schedules',
    summary: 'List recurring jobs',
    description: 'Each with its timetable, its next and last run, and how the last run ended.',
    auth: { permission: 'system.view' },
    success: { status: 200, description: 'The schedules', schema: ScheduleOut },
    errors: [],
    handler: async (req, res) => {
      all(res, req, await svc.list());
    },
  });

  const toggle = (action: 'pause' | 'resume', summary: string, description: string) => {
    m.route({
      method: 'post',
      path: `/schedules/:name/${action}`,
      summary,
      description,
      auth: { permission: 'system.edit' },
      ...byName,
      idempotent: true,
      success: { status: 200, description: 'The schedule', schema: ScheduleOut },
      errors: ['INVALID_TRANSITION'],
      handler: async (_req, res) => {
        const { params } = getValidated(res, byName);
        sendOne(res, await svc[action](params.name, currentActorId()));
      },
    });
  };
  toggle('pause', 'Pause a recurring job', 'It is not fired until resumed. A run already started finishes.');
  toggle(
    'resume',
    'Resume a recurring job',
    'It fires again from its next slot; missed slots are not replayed.',
  );

  m.route({
    method: 'post',
    path: '/schedules/:name/run',
    summary: 'Run a recurring job now',
    description:
      'Outside its timetable, which is unchanged. If its previous run is still queued or running, that job ' +
      'is returned instead of starting a second.',
    auth: { permission: 'system.edit' },
    ...byName,
    idempotent: true,
    success: { status: 202, description: 'The job', schema: JobOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byName);
      sendAccepted(res, await svc.runNow(params.name, currentActorId()));
    },
  });

  m.route({
    method: 'get',
    path: '/processes',
    summary: 'Workers and the scheduler',
    description:
      'Every worker and scheduler process that has reported in, and whether it is alive now (a beat in the ' +
      'last 90 seconds). Exactly one scheduler should be alive (P14 §2.1).',
    auth: { permission: 'system.view' },
    success: { status: 200, description: 'The processes', schema: ProcessOut },
    errors: [],
    handler: async (req, res) => {
      all(res, req, await listProcesses(db));
    },
  });

  return m.build();
}

export function jobsModules(deps: JobsDeps): ApiModule[] {
  return [jobsResourceModule(deps), schedulesModule(deps)];
}
