import { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { BOOTSTRAP_ADMIN_ID } from '../identity/identity.seed.js';
import { performanceService } from './performance.service.js';

/**
 * The nightly goal states (P2.10; Spec P3 §24.2: "transitions to delayed and overdue are computed nightly
 * from due_date and progress, not keyed by a user"). Recorded in the status history as the system.
 */
export const GOAL_STATES_JOB = 'goal.refresh_states';

export function goalStatesJob(db: Database, accessLog: AccessLog, timezone: string) {
  const svc = performanceService({ db, accessLog, timezone });
  return defineJob({
    type: GOAL_STATES_JOB,
    label: 'Mark goals delayed or overdue',
    payload: z.object({}),
    async run() {
      return { result: await svc.goals.refreshAll(BOOTSTRAP_ADMIN_ID) };
    },
  });
}

export const PERFORMANCE_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'goal.refresh_states',
    description: 'Marks goals delayed or overdue from their due dates and progress.',
    cron: '30 0 * * *',
    jobType: GOAL_STATES_JOB,
  },
];
