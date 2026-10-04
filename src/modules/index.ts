import type { Logger } from 'pino';

import type { ApiModule } from '../app.js';
import type { Config } from '../config/env.js';
import type { PermissionResolver } from '../core/auth/authorize.js';
import type { SessionStore } from '../core/auth/sessions.js';
import type { TokenSigner } from '../core/auth/tokens.js';
import type { Database } from '../core/db/prisma.js';
import type { Mailer } from '../core/mail/mailer.js';
import type { Platform } from '../core/platform.js';
import { identityModules } from './identity/identity.routes.js';

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
}

/**
 * The application's modules, in mount order. Each epic adds its module here, starting with P1.01
 * (users, roles, permissions) and P1.02 (auth). server.ts mounts them, and the OpenAPI document is
 * generated from them.
 */
export function buildModules(deps: ModuleDeps): ApiModule[] {
  return [...identityModules(deps)];
}
