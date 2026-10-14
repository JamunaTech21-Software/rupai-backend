import { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { accessService } from './access.service.js';

/** Scheduled work of the identity module (P1.02 D-1.02-2, P1.04 D-1.04-7). */

/** Refresh and reset tokens are kept this long after they expire, then purged. */
export const TOKEN_KEEP_DAYS = 30;

/**
 * Removes refresh and password-reset tokens that expired more than 30 days ago. An expired token can
 * never be used again, so nothing is lost; auth_session, the record of who was signed in, is kept.
 */
export function purgeTokensJob(db: Database) {
  return defineJob({
    type: 'auth.purge_tokens',
    label: 'Purge expired sign-in tokens',
    payload: z.object({}),
    async run(ctx) {
      let refresh = 0;
      for (;;) {
        ctx.signal.throwIfAborted();
        const n = await db.$executeRaw`
          DELETE FROM auth_refresh_token
           WHERE expires_at < UTC_TIMESTAMP() - INTERVAL ${TOKEN_KEEP_DAYS} DAY ORDER BY id LIMIT 1000`;
        refresh += n;
        await ctx.progress(refresh);
        if (n < 1000) break;
      }
      const reset = await db.$executeRaw`
        DELETE FROM password_reset_token WHERE expires_at < UTC_TIMESTAMP() - INTERVAL ${TOKEN_KEEP_DAYS} DAY`;
      return { result: { refresh_tokens_deleted: refresh, reset_tokens_deleted: reset } };
    },
  });
}

/**
 * The scheduled access review (P6 §9.1): the concentration report, run weekly, its findings kept on the
 * job. Telling the administrator arrives with notifications (P1.16).
 */
export function concentrationReviewJob(db: Database) {
  const access = accessService(db);
  return defineJob({
    type: 'role.concentration_review',
    label: 'Access concentration review',
    payload: z.object({}),
    async run() {
      const r = await access.concentrationReport();
      return {
        result: {
          generated_at: r.generated_at,
          unauthorised: r.unauthorised.length,
          approve_and_post: r.approve_and_post.length,
          users_with_many_roles: r.users_with_many_roles.length,
          active_overrides: r.active_overrides.length,
          overrides_no_longer_held: r.active_overrides.filter((o) => !o.still_held).length,
          unauthorised_users: r.unauthorised.slice(0, 50).map((u) => ({
            id: u.id,
            username: u.username,
            requirements: u.requirements.length,
          })),
          report: '/api/v1/access/concentration-report',
        },
      };
    },
  });
}

export const IDENTITY_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'auth.purge_tokens',
    description: 'Removes sign-in and password-reset tokens 30 days after they expire.',
    cron: '15 3 * * *',
    jobType: 'auth.purge_tokens',
  },
  {
    name: 'role.concentration_review',
    description: 'The weekly access review: conflicting or sensitive permissions held without authorisation.',
    cron: '0 7 * * 0',
    jobType: 'role.concentration_review',
  },
];
