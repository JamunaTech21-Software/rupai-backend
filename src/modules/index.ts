import type { Logger } from 'pino';

import type { ApiModule } from '../app.js';
import type { Config } from '../config/env.js';
import type { AccessLog } from '../core/audit/access-log.js';
import type { PermissionResolver } from '../core/auth/authorize.js';
import type { SessionStore } from '../core/auth/sessions.js';
import type { TokenSigner } from '../core/auth/tokens.js';
import type { Database } from '../core/db/prisma.js';
import type { Mailer } from '../core/mail/mailer.js';
import type { Platform } from '../core/platform.js';
import type { FileStorage } from '../core/storage/storage.js';
import { auditModule } from './audit/audit.routes.js';
import { identityModules } from './identity/identity.routes.js';
import { lookupModules } from './lookups/lookup.routes.js';
import { calendarModules } from './calendar/calendar.routes.js';
import { documentsModule } from './documents/documents.routes.js';
import { facilitiesModules } from './facilities/facilities.routes.js';
import { organisationModules } from './organisation/organisation.routes.js';
import { systemModules } from './system/system.routes.js';

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
}

/**
 * The application's modules, in mount order. Each epic adds its module here, starting with P1.01
 * (users, roles, permissions), P1.02 (auth), P1.05 (audit), P1.07 (organisation and estate hierarchy) P1.08 (facilities, parties, contacts) P1.09 (calendars) P1.10 (reference lookups), P1.11 (numbering, settings) and P1.12 (document attachments). server.ts mounts them, and the OpenAPI document is
 * generated from them.
 */
export function buildModules(deps: ModuleDeps): ApiModule[] {
  return [
    ...identityModules(deps),
    auditModule(deps),
    ...organisationModules(deps),
    ...facilitiesModules(deps),
    ...calendarModules(deps),
    ...lookupModules(deps),
    ...systemModules(deps),
    documentsModule(deps),
  ];
}
