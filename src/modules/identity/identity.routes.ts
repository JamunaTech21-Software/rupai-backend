import type { ApiModule } from '../../app.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
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
  ALL_ACTIONS,
  AssignRolesBody,
  CreateRoleBody,
  CreateScopeGrantBody,
  CreateUserBody,
  EffectivePermissionsOut,
  IdParams,
  PatchRoleBody,
  PatchScopeGrantBody,
  PatchUserBody,
  PermissionOut,
  ReplaceRoleBody,
  ReplaceUserBody,
  ROLE_STATUSES,
  RoleOut,
  ScopeGrantOut,
  ScopeGrantParams,
  USER_STATUSES,
  UserOut,
} from './identity.schema.js';
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
}

const PAGE = { pagination: 'page' } as const;

function usersModule({ db, platform, authz, sessions }: IdentityDeps): ApiModule {
  const users = usersService(db, authz, sessions);
  const m = defineModule({ name: 'users', path: '/users', tag: 'Users', platform, authz });
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
      'Replaces the user’s complete set of roles. A grant may carry expires_at for temporary cover; it lapses by itself.',
    auth: { permission: 'user.edit' },
    ...byId,
    body: AssignRolesBody,
    ifMatch: true,
    idempotent: true,
    success: { status: 200, description: 'The user with its new roles', schema: UserOut },
    errors: ['LAST_ADMINISTRATOR'],
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

  const scopes = userScopesService(db);
  const byGrant = { params: ScopeGrantParams };

  m.route({
    method: 'get',
    path: '/:id/scopes',
    summary: 'A user’s data-scope grants',
    description:
      'Which estates, divisions, sections, departments or facilities the user may touch. The effective scope is the ' +
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
      'scope_type all_estates (no scope_id), or estate | division | section | department | facility with scope_id. ' +
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
      await scopes.revoke(params.id, params.grantId);
      sendNoContent(res);
    },
  });

  return m.build();
}

function rolesModule({ db, platform, authz }: IdentityDeps): ApiModule {
  const roles = rolesService(db);
  const m = defineModule({ name: 'roles', path: '/roles', tag: 'Roles', platform, authz });
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
      description: 'A system role may only be renamed or re-described.',
      auth: { permission: 'role.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: RoleOut },
      errors: ['DUPLICATE_KEY', 'SYSTEM_RECORD'],
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
      await roles.remove(params.id);
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
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: 'The role in its new status', schema: RoleOut },
      errors: status === 'inactive' ? ['SYSTEM_RECORD'] : [],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const role = await roles.setStatus(params.id, requireIfMatch(req), status, currentActorId());
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

function permissionsModule({ db, platform, authz }: IdentityDeps): ApiModule {
  const m = defineModule({ name: 'permissions', path: '/permissions', tag: 'Roles', platform, authz });
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

export function identityModules(deps: AuthModuleDeps): ApiModule[] {
  return [authModule(deps), usersModule(deps), rolesModule(deps), permissionsModule(deps)];
}
