import type { Logger } from 'pino';
import type { z } from 'zod';

import type { Tx } from '../db/transaction.js';

/**
 * What a job is (Spec P4 §5.3, P1 §2.7). A module defines each of its jobs once, with the payload it
 * takes and the code that runs it; the worker looks the definition up by `type` when the job comes due.
 *
 * The contract every handler keeps (P1 §2.7, §7.7):
 *   - safe to run twice and safe to resume: any attempt may be cut off at any point and run again
 *   - each effect is guarded by a processing key written IN THE SAME TRANSACTION as the effect
 *     (`ctx.once`), or by the document's own unique constraint — never by a status flag alone
 *   - progress is reported, with a checkpoint where the work is long, so a re-run resumes
 */

export const JOB_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export interface JobContext<P> {
  readonly jobId: bigint;
  readonly type: string;
  readonly payload: P;
  /** 1 on the first run. */
  readonly attempt: number;
  /** What the last run saved with `progress`, or null on a fresh start. */
  readonly checkpoint: unknown;
  /** Who asked for it; null for scheduled work. */
  readonly requestedBy: bigint | null;
  readonly logger: Logger;
  /**
   * Aborted when this run must stop: the worker is shutting down, or the run lost its lease and another
   * has taken the job over. Check it between units of work.
   */
  readonly signal: AbortSignal;
  /** Reports progress (and renews the lease). `checkpoint` is where a re-run picks up. */
  progress(done: number, total?: number | null, checkpoint?: unknown): Promise<void>;
  /**
   * Claims a processing key inside the transaction that makes the effect. false: the effect was already
   * made by an earlier attempt, so skip it. The key is `<document>:<id>:<purpose>[:<part>]`.
   */
  once(tx: Tx, key: string): Promise<boolean>;
}

export interface JobOutcome {
  /** partial: some of the work was refused, e.g. an import that committed some rows (P4 §5.3). */
  readonly state?: 'completed' | 'partial';
  /** A summary or a link, shown to whoever polls the job. Plain JSON. */
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface JobDefinition<P = unknown> {
  readonly type: string;
  /** For the job page, e.g. "Purge finished jobs". */
  readonly label: string;
  readonly payload: z.ZodType<P>;
  /** Attempts before the job is failed for good. Default 3. */
  readonly maxAttempts?: number;
  run(ctx: JobContext<P>): Promise<JobOutcome | undefined>;
}

/** A recurring job (P14 §2.1: run by the one scheduler). The cron is in the organisation's timezone. */
export interface ScheduleDefinition {
  /** Stable name, e.g. jobs.purge. */
  readonly name: string;
  readonly description: string;
  /** Five-field cron: minute hour day-of-month month day-of-week. */
  readonly cron: string;
  readonly jobType: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** A failure that no retry can cure: the job is failed at once. */
export class PermanentJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PermanentJobError';
  }
}

const definitions = new Map<string, JobDefinition>();

export function defineJob<P>(def: JobDefinition<P>): JobDefinition<P> {
  if (!JOB_TYPE_PATTERN.test(def.type))
    throw new Error(`job type "${def.type}" must look like module.purpose`);
  const max = def.maxAttempts ?? 3;
  if (!Number.isInteger(max) || max < 1 || max > 10)
    throw new Error(`job ${def.type}: maxAttempts must be 1–10`);
  return def;
}

/** Registers a job's definition. Idempotent for the same object; a different one under a used type is a bug. */
export function registerJob<P>(def: JobDefinition<P>): void {
  const existing = definitions.get(def.type);
  if (existing && existing !== def && process.env.NODE_ENV !== 'test') {
    throw new Error(`job type ${def.type} is registered twice`);
  }
  definitions.set(def.type, def);
}

export function jobDefinition(type: string): JobDefinition | undefined {
  return definitions.get(type);
}

export function registeredJobs(): readonly JobDefinition[] {
  return [...definitions.values()];
}
