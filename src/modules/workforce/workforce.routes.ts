import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { masterItemRoutes } from '../../core/http/master.js';
import { sendCreated, sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { appliedScope } from '../../core/scope/scope.js';
import './person.scope.js';
import {
  CreateDependentBody,
  CreatePersonBody,
  DependentOut,
  DependentParams,
  GENDERS,
  IdParams,
  PatchDependentBody,
  PatchPersonBody,
  PersonOut,
  ReplacePersonBody,
  STATUSES,
} from './person.schema.js';
import { personService } from './person.service.js';

/** HTTP surface of the workforce module: the person registry (P2.01; Spec P4 §8.3). */

export interface WorkforceDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly config: { readonly timezone: string };
}

const byId = { params: IdParams };
const byDependent = { params: DependentParams };

function personsModule({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule {
  const svc = personService(db, accessLog, config.timezone);
  const m = defineModule({ name: 'persons', path: '/persons', tag: 'Workforce', platform, authz, accessLog });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List persons',
    description:
      'People in your data scope (the estate that registered them, until an employment profile places ' +
      'them). filter[q]=… searches name, person code, national ID and phone.',
    auth: { permission: 'person.view' },
    list: {
      pagination: 'page',
      filters: {
        q: { type: 'string', ops: ['eq'] },
        status: { type: { enum: STATUSES } },
        gender: { type: { enum: GENDERS } },
        registered_estate_id: { type: 'id', ops: ['eq', 'in'] },
        person_code: { type: 'string', ops: ['eq', 'like'] },
        national_id: { type: 'string', ops: ['eq'] },
        full_name: { type: 'string', ops: ['like'] },
        created_at: { type: 'datetime', ops: ['from', 'to'] },
      },
      sorts: ['person_code', 'full_name', 'created_at'],
      defaultSort: ['full_name'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of persons', schema: PersonOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Register a person',
    description:
      'Identity only (P4 §8.3): an employment attribute (department, designation, wage, joining date, worker ' +
      'type …) is refused with 422; those go on the employment profile. person_code is numbered by the ' +
      '`person` number format. national_id is unique. An estate-scoped user registers people in their ' +
      'own estate (registered_estate_id).',
    auth: { permission: 'person.create' },
    body: CreatePersonBody,
    success: { status: 201, description: 'Registered', schema: PersonOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreatePersonBody });
      const p = await svc.create(body, currentActorId());
      sendCreated(res, p, `/api/v1/persons/${p.id}`, p.version);
    },
  });

  masterItemRoutes(m, {
    module: 'person',
    label: 'person',
    out: PersonOut,
    replace: ReplacePersonBody,
    patch: PatchPersonBody,
    svc,
    updateErrors: ['DUPLICATE_KEY'],
    deleteHelp: 'Only a person registered in error, with no employment profile. Otherwise deactivate.',
  });

  // ---- dependents (the design's Dependents tab) -------------------------------------------------------
  m.route({
    method: 'get',
    path: '/:id/dependents',
    summary: 'List a person’s dependents',
    auth: { permission: 'person.view' },
    ...byId,
    success: { status: 200, description: 'The dependents', schema: DependentOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await svc.dependents.list(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/dependents',
    summary: 'Add a dependent',
    description: 'A member of the person’s family: name, relation, occupation, date of birth, gender.',
    auth: { permission: 'person.edit' },
    ...byId,
    body: CreateDependentBody,
    success: { status: 201, description: 'Added', schema: DependentOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CreateDependentBody });
      const d = await svc.dependents.create(params.id, body, currentActorId());
      sendCreated(res, d, `/api/v1/persons/${params.id.toString()}/dependents/${d.id}`, d.version);
    },
  });

  m.route({
    method: 'patch',
    path: '/:id/dependents/:dependentId',
    summary: 'Change a dependent',
    auth: { permission: 'person.edit' },
    ...byDependent,
    body: PatchDependentBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: DependentOut },
    errors: ['SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byDependent, body: PatchDependentBody });
      const d = await svc.dependents.update(
        params.id,
        params.dependentId,
        requireIfMatch(req),
        body,
        currentActorId(),
      );
      sendOne(res, d, { version: d.version });
    },
  });

  m.route({
    method: 'delete',
    path: '/:id/dependents/:dependentId',
    summary: 'Remove a dependent',
    auth: { permission: 'person.edit' },
    ...byDependent,
    success: { status: 204, description: 'Removed' },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byDependent);
      await svc.dependents.remove(params.id, params.dependentId, currentActorId());
      sendNoContent(res);
    },
  });

  return m.build();
}

export function workforceModules(deps: WorkforceDeps): ApiModule[] {
  return [personsModule(deps)];
}
