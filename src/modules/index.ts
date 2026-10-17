import type { Logger } from 'pino';

import type { ApiModule } from '../app.js';
import type { Config } from '../config/env.js';
import type { AccessLog } from '../core/audit/access-log.js';
import type { PermissionResolver } from '../core/auth/authorize.js';
import type { SessionStore } from '../core/auth/sessions.js';
import type { TokenSigner } from '../core/auth/tokens.js';
import type { Database } from '../core/db/prisma.js';
import type { JobQueue } from '../core/jobs/queue.js';
import { registerJob, type ScheduleDefinition } from '../core/jobs/registry.js';
import type { Mailer } from '../core/mail/mailer.js';
import type { Platform } from '../core/platform.js';
import type { FileStorage } from '../core/storage/storage.js';
import { APPROVAL_SCHEDULES, approvalNotifyJob, recheckUnresolvedJob } from './approvals/approvals.jobs.js';
import { approvalsModule } from './approvals/approvals.routes.js';
import { auditModule } from './audit/audit.routes.js';
import { concentrationReviewJob, IDENTITY_SCHEDULES, purgeTokensJob } from './identity/identity.jobs.js';
import { identityModules } from './identity/identity.routes.js';
import { JOB_SCHEDULES, purgeJobsJob, selfTestJob } from './jobs/jobs.jobs.js';
import { jobsModules } from './jobs/jobs.routes.js';
import { lookupModules } from './lookups/lookup.routes.js';
import { calendarModules } from './calendar/calendar.routes.js';
import { dashboardModule } from './dashboard/dashboard.routes.js';
import { DOCUMENT_SCHEDULES, documentExpiryJob } from './documents/documents.jobs.js';
import { documentsModule } from './documents/documents.routes.js';
import { facilitiesModules } from './facilities/facilities.routes.js';
import {
  deliverJob,
  NOTIFICATION_SCHEDULES,
  purgeNotificationsJob,
} from './notifications/notifications.jobs.js';
import { notificationsModules } from './notifications/notifications.routes.js';
import { organisationModules } from './organisation/organisation.routes.js';
import { systemModules } from './system/system.routes.js';
import { workflowsModule } from './workflows/workflows.routes.js';

export interface ModuleDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  /** Server-side session state: checked by `authenticate`, revoked by logout, disable, password change. */
  readonly sessions: SessionStore;
  readonly signer: TokenSigner;
  readonly mailer: Mailer;
  /** Authentication events and permission/scope denials (P1.05). Writes outside any transaction. */
  readonly accessLog: AccessLog;
  /** Where uploaded documents are kept (P1.12). */
  readonly storage: FileStorage;
  /** Where new jobs are announced (P1.15): Redis, in-process in development, or nowhere (tests). */
  readonly jobs: JobQueue;
}

/**
 * The application's modules, in mount order. Each epic adds its module here, starting with P1.01
 * (users, roles, permissions), P1.02 (auth), P1.05 (audit), P1.07 (organisation and estate hierarchy) P1.08 (facilities, parties, contacts) P1.09 (calendars) P1.10 (reference lookups), P1.11 (numbering, settings), P1.12 (document attachments), P1.13 (approval workflow definitions), P1.14 (approval runtime and queue), P1.15 (jobs and schedules), P1.16 (notifications) and R.5 (dashboards). server.ts mounts them, and the OpenAPI document is
 * generated from them.
 */
export function buildModules(deps: ModuleDeps): ApiModule[] {
  // The API creates jobs and labels them, so it knows every definition too.
  registerJobs(deps);
  return [
    ...identityModules(deps),
    auditModule(deps),
    ...organisationModules(deps),
    ...facilitiesModules(deps),
    ...calendarModules(deps),
    ...lookupModules(deps),
    ...systemModules(deps),
    documentsModule(deps),
    workflowsModule(deps),
    approvalsModule(deps),
    ...jobsModules({ ...deps, schedules: JOB_CATALOGUE_SCHEDULES }),
    ...notificationsModules(deps),
    dashboardModule(deps),
  ];
}

/** Every recurring job (P1.15). The scheduler fires them; GET /system/schedules lists them. */
export const JOB_CATALOGUE_SCHEDULES: readonly ScheduleDefinition[] = [
  ...JOB_SCHEDULES,
  ...IDENTITY_SCHEDULES,
  ...APPROVAL_SCHEDULES,
  ...DOCUMENT_SCHEDULES,
  ...NOTIFICATION_SCHEDULES,
];

/**
 * Every job the modules define, registered so a worker can run them (and the API can create them).
 * Each module adds its jobs here, as it adds its routes to buildModules. Call once per process.
 */
export function registerJobs(deps: {
  readonly db: Database;
  readonly config: Pick<Config, 'timezone' | 'app'>;
  readonly mailer: Mailer;
}): void {
  const { db, config, mailer } = deps;
  registerJob(selfTestJob(db));
  registerJob(purgeJobsJob(db));
  registerJob(purgeTokensJob(db));
  registerJob(concentrationReviewJob(db, config.timezone));
  registerJob(recheckUnresolvedJob(db));
  registerJob(approvalNotifyJob(db, config.timezone));
  registerJob(documentExpiryJob(db, config.timezone));
  registerJob(deliverJob(db, mailer, config.app.publicUrl));
  registerJob(purgeNotificationsJob(db));
}
