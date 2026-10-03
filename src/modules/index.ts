import type { ApiModule } from '../app.js';
import type { Platform } from '../core/platform.js';

export interface ModuleDeps {
  readonly platform: Platform;
}

/**
 * The application's modules, in mount order. Each epic adds its module here, starting with P1.01
 * (users, roles, permissions). server.ts mounts them, and the OpenAPI document is generated from them.
 */
export function buildModules(_deps: ModuleDeps): ApiModule[] {
  return [];
}
