import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';

/** Request and response schemas of the job resource and the scheduler (Spec P4 §5.3, P5 §4.7). */

export const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'partial'] as const;
export const IdParams = z.object({ id: zId });
export const ScheduleParams = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_.]*$/)
    .max(60),
});

const UserRef = z.object({ id: z.string(), username: z.string() });

export const JobOut = z.object({
  id: z.string(),
  /** The same as id: the name P4 Figure 5.1 gives it in a 202 response. */
  job_id: z.string(),
  type: z.string(),
  label: z.string(),
  state: z.enum(JOB_STATES),
  /** total is null while unknown. */
  progress: z.object({ done: z.number().int(), total: z.number().int().nullable() }),
  /** While queued or running: when to poll again (P5 §4.7). null once finished. */
  poll_after_seconds: z.number().int().nullable(),
  attempts: z.number().int(),
  max_attempts: z.number().int(),
  /** Queued after a failed attempt: not before this. */
  next_attempt_at: z.string().nullable(),
  queued_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  /** completed / partial: a summary, or a link to what was produced. */
  result: z.record(z.string(), z.unknown()).nullable(),
  /** failed: why. While retrying: why the last attempt failed. */
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  requested_by: UserRef.nullable(),
  /** Set when the scheduler started it. */
  schedule: z.string().nullable(),
  /** When the finished job and its result are purged. */
  expires_at: z.string().nullable(),
});

export const SelfTestBody = z.strictObject({
  /** Units of work. Each is guarded by a processing key, so a re-run never repeats one. */
  steps: z.number().int().min(1).max(1000).default(10),
  /** How long each unit takes. Long enough to stop the worker mid-way and watch it resume. */
  step_ms: z.number().int().min(0).max(60_000).default(500),
  /** Fail this many attempts half way through, to see the retries and, past the limit, the failure. */
  fail_attempts: z.number().int().min(0).max(10).default(0),
});

export const ScheduleOut = z.object({
  name: z.string(),
  description: z.string(),
  job_type: z.string(),
  job_label: z.string(),
  /** Five-field cron in `timezone`. */
  cron: z.string(),
  timezone: z.string(),
  is_paused: z.boolean(),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_job: z
    .object({ id: z.string(), state: z.enum(JOB_STATES), finished_at: z.string().nullable() })
    .nullable(),
  version: z.number().int(),
});

export const ProcessOut = z.object({
  /** scheduler | worker */
  kind: z.enum(['scheduler', 'worker']),
  key: z.string(),
  host: z.string(),
  pid: z.number().int(),
  app_version: z.string(),
  started_at: z.string(),
  last_beat_at: z.string(),
  stopped_at: z.string().nullable(),
  /** Beat within the last 90 seconds and not stopped. */
  is_alive: z.boolean(),
});
