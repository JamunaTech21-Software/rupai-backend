import type { ApiModule } from '../../app.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import type { SessionStore } from '../../core/auth/sessions.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendCreated, sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import {
  AccessCheckOut,
  ALL_ACTIONS,
  AssignRolesBody,
  AuthorisationOut,
  AuthorisationParams,
  CheckRolesBody,
  ConcentrationReportOut,
  CreateRoleBody,
  CreateScopeGrantBody,
  CreateUserBody,
  EffectivePermissionsOut,
  IdParams,
  PatchRoleBody,
  PatchScopeGrantBody,
  PatchUserBody,
  PermissionOut,
  ReactivateRoleBody,
  ReplaceRoleBody,
  ReplaceUserBody,
  ROLE_STATUSES,
  RoleOut,
  ScopeGrantOut,
  ScopeGrantParams,
  SodRuleOut,
  USER_STATUSES,
  UserOut,
} from './identity.schema.js';
import { accessService } from './access.service.js';
import { authModule, type AuthModuleDeps } from './auth.routes.js';
import { listPermissions } from './identity.repository.js';
import { PERMISSION_BY_KEY } from './permission-catalogue.js';
import { rolesService } from './roles.service.js';
import { userScopesService } from './user-scopes.service.js';
import { usersService } from './users.service.js';

/** HTTP surface of the identity module (Spec P4 §14.1). */

export interface IdentityDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly sessions: SessionStore;
  readonly accessLog: AccessLog;
}

const PAGE = { pagination: 'page' } as const;

function usersModule({ db, platform, authz, sessions, accessLog }: IdentityDeps): ApiModule {
  const users = usersService(db, authz, sessions);
  const m = defineModule({ name: 'users', path: '/users', tag: 'Users', platform, authz, accessLog });
  const byId = { params: IdParams };

  m.route({
    method: 'get',
    path: '/',
    summary: 'List users',
    auth: { permission: 'user.view' },
    list: {
      ...PAGE,
      filters: {
        status: { type: { enum: USER_STATUSES } },
        username: { type: 'string', ops: ['eq', 'like'] },
        email: { type: 'string', ops: ['eq', 'like', 'null'] },
        role_id: { type: 'id', ops: ['eq', 'in'] },
      },
      sorts: ['username', 'email'],
      defaultSort: ['username'],
    },
    success: { status: 200, description: 'A page of users, each with its roles', schema: UserOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await users.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Create a user',
    description:
      'The new user has no roles and must change the initial password at first sign-in. The password is never returned.',
    auth: { permission: 'user.create' },
    body: CreateUserBody,
    success: { status: 201, description: 'Created', schema: UserOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateUserBody });
      const user = await users.create(body, currentActorId());
      sendCreated(res, user, `/api/v1/users/${user.id}`, user.version);
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a user',
    auth: { permission: 'user.view' },
    ...byId,
    success: { status: 200, description: 'The user, with its roles', schema: UserOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const user = await users.get(params.id);
      sendOne(res, user, { version: user.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceUserBody, 'Replace a user’s details'],
    ['patch', PatchUserBody, 'Update some of a user’s details'],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      description: 'Username, email and phone. Status and roles have their own endpoints.',
      auth: { permission: 'user.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: UserOut },
      errors: ['DUPLICATE_KEY'],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: PatchUserBody });
        const user = await users.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, user, { version: user.version });
      },
    });
  }

  m.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a user created in error',
    description: 'Only an account that has never signed in and is not referenced. Otherwise disable it.',
    auth: { permission: 'user.delete' },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['REFERENCED_RECORD', 'LAST_ADMINISTRATOR', 'INVARIANT_VIOLATED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await users.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  for (const [path, status, summary] of [
    ['/:id/deactivate', 'disabled', 'Disable a user (access ends immediately)'],
    ['/:id/reactivate', 'active', 'Re-enable a disabled user'],
  ] as const) {
    m.route({
      method: 'post',
      path,
      summary,
      auth: { permission: 'user.edit' },
      ...byId,
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: 'The user in its new status', schema: UserOut },
      errors: status === 'disabled' ? ['LAST_ADMINISTRATOR'] : [],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const user = await users.setStatus(params.id, requireIfMatch(req), status, currentActorId());
        sendOne(res, user, { version: user.version });
      },
    });
  }

  m.route({
    method: 'post',
    path: '/:id/roles',
    summary: 'Set a user’s roles',
    description:
      'Replaces the user’s complete set of roles. A grant may carry expires_at for temporary cover; it lapses by itself. ' +
      'If the resulting roles hold a prohibited combination (separation of duties) or a sensitive permission without an ' +
      'active authorisation, the change is refused with 422 AUTHORISATION_REQUIRED, whose details carry each `key`: ' +
      'resend with `authorisations: [{key, reason}]` to record a named, written authorisation for each.',
    auth: { permission: 'user.edit' },
    ...byId,
    body: AssignRolesBody,
    ifMatch: true,
    idempotent: true,
    success: { status: 200, description: 'The user with its new roles', schema: UserOut },
    errors: ['LAST_ADMINISTRATOR', 'AUTHORISATION_REQUIRED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: AssignRolesBody });
      const user = await users.assignRoles(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, user, { version: user.version });
    },
  });

  m.route({
    method: 'get',
    path: '/:id/permissions',
    summary: 'A user’s effective permissions',
    description: 'The union of the user’s active, unexpired roles. Empty for a disabled user.',
    auth: { permission: 'user.view' },
    ...byId,
    success: { status: 200, description: 'Effective permission keys', schema: EffectivePermissionsOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await users.effectivePermissions(params.id));
    },
  });

  const access = accessService(db);
  const byAuthorisation = { params: AuthorisationParams };

  m.route({
    method: 'post',
    path: '/:id/roles/check',
    summary: 'Preview the separation-of-duties check for a role set',
    description:
      'Changes nothing. Lists every prohibited combination and sensitive permission the roles would give the user, ' +
      'and whether an active authorisation already covers it. Use it to show the conflict dialog (P6 Fig 9.1).',
    auth: { permission: 'user.edit' },
    ...byId,
    body: CheckRolesBody,
    success: { status: 200, description: 'What the roles would require', schema: AccessCheckOut },
    errors: [],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CheckRolesBody });
      sendOne(res, await access.check(params.id, body.roles));
    },
  });

  m.route({
    method: 'get',
    path: '/:id/authorisations',
    summary: 'A user’s recorded authorisations',
    description:
      'Overrides of prohibited combinations and sensitive-permission grants, active and removed, newest first.',
    auth: { permission: 'user.view' },
    ...byId,
    list: { pagination: 'page', filters: {}, sorts: [] },
    success: { status: 200, description: 'The user’s authorisations', schema: AuthorisationOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const q = getListQuery(res);
      const page = q.page ?? { page: 1, perPage: 25 };
      const all = await access.listForUser(params.id);
      const start = (page.page - 1) * page.perPage;
      sendPage(req, res, all.slice(start, start + page.perPage), { pagination: page, total: all.length });
    },
  });

  m.route({
    method: 'delete',
    path: '/:id/authorisations/:authorisationId',
    summary: 'Remove an authorisation',
    description:
      'Recorded as removed (who and when), never deleted. If the user still holds the combination, it reappears on ' +
      'the concentration report as unauthorised, and the next role change needs a new authorisation.',
    auth: { permission: 'user.edit' },
    ...byAuthorisation,
    success: { status: 204, description: 'Removed' },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byAuthorisation);
      await access.remove(params.id, params.authorisationId, currentActorId());
      sendNoContent(res);
    },
  });

  const scopes = userScopesService(db);
  const byGrant = { params: ScopeGrantParams };

  m.route({
    method: 'get',
    path: '/:id/scopes',
    summary: 'A user’s data-scope grants',
    description:
      'Which estates, divisions, sections, departments, factories or warehouses the user may touch. The effective scope is the ' +
      'union of the active grants, plus implicit self. Expired grants are listed with active=false.',
    auth: { permission: 'user.view' },
    ...byId,
    list: { pagination: 'page', filters: {}, sorts: [] },
    success: { status: 200, description: 'The user’s grants', schema: ScopeGrantOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const q = getListQuery(res);
      const page = q.page ?? { page: 1, perPage: 25 };
      const all = await scopes.list(params.id);
      const start = (page.page - 1) * page.perPage;
      sendPage(req, res, all.slice(start, start + page.perPage), { pagination: page, total: all.length });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/scopes',
    summary: 'Grant a data scope',
    description:
      'scope_type all_estates (no scope_id), or estate | division | section | department | factory | warehouse with scope_id. ' +
      'expires_at makes it temporary. self is implicit for everyone and cannot be granted. Applies to the ' +
      'user’s next request.',
    auth: { permission: 'user.edit' },
    ...byId,
    body: CreateScopeGrantBody,
    idempotent: true,
    success: { status: 201, description: 'Granted', schema: ScopeGrantOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CreateScopeGrantBody });
      const grant = await scopes.grant(params.id, body, currentActorId());
      sendCreated(res, grant, `/api/v1/users/${params.id.toString()}/scopes/${grant.id}`, grant.version);
    },
  });

  m.route({
    method: 'patch',
    path: '/:id/scopes/:grantId',
    summary: 'Change a scope grant’s expiry',
    description: 'Set or remove (null) expires_at. The target never changes: revoke and grant again instead.',
    auth: { permission: 'user.edit' },
    ...byGrant,
    body: PatchScopeGrantBody,
    ifMatch: true,
    success: { status: 200, description: 'Updated', schema: ScopeGrantOut },
    errors: [],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byGrant, body: PatchScopeGrantBody });
      const grant = await scopes.setExpiry(
        params.id,
        params.grantId,
        requireIfMatch(req),
        body.expires_at,
        currentActorId(),
      );
      sendOne(res, grant, { version: grant.version });
    },
  });

  m.route({
    method: 'delete',
    path: '/:id/scopes/:grantId',
    summary: 'Revoke a scope grant',
    description: 'Takes effect on the user’s next request.',
    auth: { permission: 'user.edit' },
    ...byGrant,
    success: { status: 204, description: 'Revoked' },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byGrant);
      await scopes.revoke(params.id, params.grantId, currentActorId());
      sendNoContent(res);
    },
  });

  return m.build();
}

function rolesModule({ db, platform, authz, accessLog }: IdentityDeps): ApiModule {
  const roles = rolesService(db);
  const m = defineModule({ name: 'roles', path: '/roles', tag: 'Roles', platform, authz, accessLog });
  const byId = { params: IdParams };

  m.route({
    method: 'get',
    path: '/',
    summary: 'List roles',
    auth: { permission: 'role.view' },
    list: {
      ...PAGE,
      filters: {
        status: { type: { enum: ROLE_STATUSES } },
        code: { type: 'string', ops: ['eq', 'in', 'like'] },
        is_system: { type: 'bool' },
      },
      // The role table is small (tens of rows), so ordering by unindexed name/sort_order is cheap.
      sorts: ['code', 'name', 'sort_order'],
      defaultSort: ['sort_order', 'code'],
    },
    success: { status: 200, description: 'A page of roles with their permissions', schema: RoleOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await roles.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Create a role',
    auth: { permission: 'role.create' },
    body: CreateRoleBody,
    success: { status: 201, description: 'Created', schema: RoleOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateRoleBody });
      const role = await roles.create(body, currentActorId());
      sendCreated(res, role, `/api/v1/roles/${role.id}`, role.version);
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a role',
    auth: { permission: 'role.view' },
    ...byId,
    success: { status: 200, description: 'The role with its permissions', schema: RoleOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const role = await roles.get(params.id);
      sendOne(res, role, { version: role.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceRoleBody, 'Replace a role, including its permission set'],
    ['patch', PatchRoleBody, 'Update some of a role'],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      description:
        'A system role may only be renamed or re-described. Changing permissions re-checks every holder (separation of ' +
        'duties): send `authorisations: [{user_id, key, reason}]` for each item AUTHORISATION_REQUIRED lists.',
      auth: { permission: 'role.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: RoleOut },
      errors: ['DUPLICATE_KEY', 'SYSTEM_RECORD', 'AUTHORISATION_REQUIRED'],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: PatchRoleBody });
        const role = await roles.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, role, { version: role.version });
      },
    });
  }

  m.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a role no user holds',
    auth: { permission: 'role.delete' },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['REFERENCED_RECORD', 'SYSTEM_RECORD'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await roles.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  for (const [path, status, summary] of [
    ['/:id/deactivate', 'inactive', 'Deactivate a role (holders lose its permissions immediately)'],
    ['/:id/reactivate', 'active', 'Reactivate a role'],
  ] as const) {
    m.route({
      method: 'post',
      path,
      summary,
      auth: { permission: 'role.edit' },
      ...byId,
      ...(status === 'active' ? { body: ReactivateRoleBody } : {}),
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: 'The role in its new status', schema: RoleOut },
      errors: status === 'inactive' ? ['SYSTEM_RECORD'] : ['AUTHORISATION_REQUIRED'],
      handler: async (req, res) => {
        const { params, body } = getValidated(res, { ...byId, body: ReactivateRoleBody });
        const role = await roles.setStatus(
          params.id,
          requireIfMatch(req),
          status,
          currentActorId(),
          status === 'active' ? (body.authorisations ?? []) : [],
        );
        sendOne(res, role, { version: role.version });
      },
    });
  }

  return m.build();
}

const PERMISSION_LIST_FIELDS: ListFieldMap = {
  module: { field: 'module' },
  action: { field: 'action' },
};

function permissionsModule({ db, platform, authz, accessLog }: IdentityDeps): ApiModule {
  const m = defineModule({
    name: 'permissions',
    path: '/permissions',
    tag: 'Roles',
    platform,
    authz,
    accessLog,
  });
  m.route({
    method: 'get',
    path: '/',
    summary: 'The permission catalogue',
    description:
      'Every module.action the application enforces, with its navigation group, module class and whether it is sensitive (P6 §10). System data: not editable.',
    auth: { permission: 'role.view' },
    list: {
      ...PAGE,
      filters: {
        module: { type: 'string', ops: ['eq', 'in'] },
        action: { type: { enum: ALL_ACTIONS } },
      },
      sorts: ['module', 'action'],
      defaultSort: ['module', 'action'],
    },
    success: { status: 200, description: 'A page of permissions', schema: PermissionOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { rows, total } = await listPermissions(db, {
        where: toWhere(q, PERMISSION_LIST_FIELDS),
        orderBy: [...toOrderBy(q.sort, PERMISSION_LIST_FIELDS), { id: 'asc' }],
        ...toPaging(q),
      });
      const items = rows.map((p) => {
        const key = `${p.module}.${p.action}`;
        const meta = PERMISSION_BY_KEY.get(key);
        return {
          id: p.id.toString(),
          key,
          module: p.module,
          action: p.action,
          group: meta?.group ?? 'Other',
          module_class: meta?.moduleClass ?? 'derived',
          description: p.description,
          sensitive: meta?.sensitive ?? false,
        };
      });
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });
  return m.build();
}

function accessModule({ db, platform, authz, accessLog }: IdentityDeps): ApiModule {
  const access = accessService(db);
  const m = defineModule({
    name: 'access',
    path: '/access',
    tag: 'Access control',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/sod-rules',
    summary: 'The separation-of-duties rules',
    description:
      'P6 Table 5.1, expanded into concrete permission combinations. Holding every permission of one combination is a ' +
      'conflict that needs a recorded override.',
    auth: { permission: 'role.view' },
    list: { pagination: 'page', filters: {}, sorts: [], maxPageSize: 50 },
    success: { status: 200, description: 'The rules', schema: SodRuleOut },
    errors: [],
    handler: (req, res) => {
      const q = getListQuery(res);
      const page = q.page ?? { page: 1, perPage: 25 };
      const all = access.rules();
      const start = (page.page - 1) * page.perPage;
      sendPage(req, res, all.slice(start, start + page.perPage), { pagination: page, total: all.length });
    },
  });

  m.route({
    method: 'get',
    path: '/concentration-report',
    summary: 'The concentration report',
    description:
      'P6 §9.2: every active override, every sensitive permission held, users with four or more roles, users holding ' +
      'approve and post in the same domain, and — the review — every conflict or sensitive permission held without an ' +
      'authorisation. Active users only.',
    auth: { permission: 'user.view' },
    success: { status: 200, description: 'The report', schema: ConcentrationReportOut },
    errors: [],
    handler: async (_req, res) => {
      sendOne(res, await access.concentrationReport());
    },
  });

  return m.build();
}

export function identityModules(deps: AuthModuleDeps): ApiModule[] {
  return [
    authModule(deps),
    usersModule(deps),
    rolesModule(deps),
    permissionsModule(deps),
    accessModule(deps),
  ];
}
