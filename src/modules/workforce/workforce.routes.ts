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
import {
  CreateProfileBody,
  EMPLOYMENT_TYPES,
  ENGAGEMENT_TYPES,
  JOB_NATURES,
  LinkUserBody,
  PatchProfileBody,
  PROFILE_STATUSES,
  ProfileOut,
  ReplaceProfileBody,
  SeparateBody,
  ServiceSummaryOut,
  SummaryQuery,
  SuspendBody,
  WORKING_LOCATIONS,
  WorkforceSummaryOut,
} from './profile.schema.js';
import { profileService } from './profile.service.js';

/** HTTP surface of the workforce module: persons (P2.01) and employment profiles (P2.02); Spec P4 §8.3. */

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
  const profiles = profileService({ db, accessLog, authz, timezone: config.timezone });
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

  m.route({
    method: 'get',
    path: '/:id/employment-profiles',
    summary: 'A person’s employment history',
    description:
      'Every profile of the person you may see, newest first: worker, then staff, seasonal engagements.',
    auth: { permission: 'person.view' },
    ...byId,
    success: { status: 200, description: 'The profiles', schema: ProfileOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await profiles.ofPerson(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'get',
    path: '/:id/service-summary',
    summary: 'A person’s service across profiles',
    description:
      'Days of service across every profile of the person (also in estates you cannot see: the service is ' +
      'theirs), and the continuous part that gratuity counts (O-11).',
    auth: { permission: 'person.view' },
    ...byId,
    success: { status: 200, description: 'The service summary', schema: ServiceSummaryOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await profiles.serviceSummary(params.id));
    },
  });

  return m.build();
}

function profilesModule({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule {
  const svc = profileService({ db, accessLog, authz, timezone: config.timezone });
  const m = defineModule({
    name: 'employment-profiles',
    path: '/employment-profiles',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List employment profiles',
    description:
      'The Worker / Employee Management lists: filter[employment_type]=worker|employee, estate, status, ' +
      'engagement type, category, job nature, working location, grade, supervisor, joining date. ' +
      'filter[q]=… searches the profile number, name, national ID and phone. Each row carries the person ' +
      '(name, father, mobile, photo document) for the list columns.',
    auth: { permission: 'employment.view' },
    list: {
      pagination: 'page',
      filters: {
        q: { type: 'string', ops: ['eq'] },
        employment_type: { type: { enum: EMPLOYMENT_TYPES } },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        person_id: { type: 'id', ops: ['eq'] },
        status: { type: { enum: PROFILE_STATUSES }, ops: ['eq', 'in'] },
        engagement_type: { type: { enum: ENGAGEMENT_TYPES }, ops: ['eq', 'in'] },
        category_id: { type: 'id', ops: ['eq', 'in'] },
        job_nature: { type: { enum: JOB_NATURES }, ops: ['eq', 'in'] },
        working_location: { type: { enum: WORKING_LOCATIONS }, ops: ['eq', 'in'] },
        job_grade_id: { type: 'id', ops: ['eq', 'in'] },
        supervisor_profile_id: { type: 'id', ops: ['eq'] },
        joining_date: { type: 'date', ops: ['from', 'to'] },
      },
      sorts: ['profile_number', 'joining_date'],
      defaultSort: ['profile_number'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of profiles', schema: ProfileOut },
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
    method: 'get',
    path: '/summary',
    summary: 'The workforce figures',
    description:
      'The cards and charts of Worker / Employee Management, within your scope: totals by status with ' +
      'percentages, new and exits this month, average tenure, by category, engagement type, gender, age ' +
      'group and length of service, birthdays and service anniversaries this month.',
    auth: { permission: 'employment.view' },
    query: SummaryQuery,
    success: { status: 200, description: 'The figures', schema: WorkforceSummaryOut },
    errors: [],
    handler: async (_req, res) => {
      const { query } = getValidated(res, { query: SummaryQuery });
      sendOne(res, await svc.summary(query.employment_type, query.estate_id));
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Open an employment profile',
    description:
      'A person’s employment at an estate: worker or employee. profile_number (the Worker ID / Employee ID) ' +
      'is numbered by the worker / employee format when omitted. One active profile per person and type: a ' +
      'second is refused (422 DUPLICATE_KEY on person_id). category_id is a worker_category for a worker, ' +
      'an employee_category for an employee.',
    auth: { permission: 'employment.create' },
    body: CreateProfileBody,
    success: { status: 201, description: 'Opened', schema: ProfileOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateProfileBody });
      const p = await svc.create(body, currentActorId());
      sendCreated(res, p, `/api/v1/employment-profiles/${p.id}`, p.version);
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get an employment profile',
    auth: { permission: 'employment.view' },
    ...byId,
    success: { status: 200, description: 'The profile', schema: ProfileOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const p = await svc.get(params.id);
      sendOne(res, p, { version: p.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceProfileBody, 'Replace a profile’s details'],
    ['patch', PatchProfileBody, 'Update some of a profile’s details'],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      description:
        'The person, estate and type never change (a new profile instead). A separated profile is read-only (409).',
      auth: { permission: 'employment.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: ProfileOut },
      errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: PatchProfileBody });
        const p = await svc.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, p, { version: p.version });
      },
    });
  }

  m.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a profile opened in error',
    description:
      'Only while nothing refers to it (a user, a manager link, a reporting line). Otherwise separate it.',
    auth: { permission: 'employment.delete' },
    ...byId,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['REFERENCED_RECORD', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  m.route({
    method: 'post',
    path: '/:id/separate',
    summary: 'Separate (end) an employment',
    description:
      'Resignation, retirement, termination, death or end of contract, with its date (not in the future, not ' +
      'before joining) and reason. Final: the profile becomes read-only. Final settlement follows with payroll ' +
      '(Phase 9).',
    auth: { permission: 'employment.approve' },
    ...byId,
    body: SeparateBody,
    ifMatch: true,
    success: { status: 200, description: 'Separated', schema: ProfileOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: SeparateBody });
      const p = await svc.separate(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, p, { version: p.version });
    },
  });

  for (const [action, summary] of [
    ['suspend', 'Suspend an employment'],
    ['reinstate', 'Reinstate a suspended employment'],
  ] as const) {
    m.route({
      method: 'post',
      path: `/:id/${action}`,
      summary,
      description: 'With a reason, recorded in the audit trail and the status history.',
      auth: { permission: 'employment.edit' },
      ...byId,
      body: SuspendBody,
      ifMatch: true,
      success: { status: 200, description: 'Changed', schema: ProfileOut },
      errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params, body } = getValidated(res, { ...byId, body: SuspendBody });
        const version = requireIfMatch(req);
        const p =
          action === 'suspend'
            ? await svc.suspend(params.id, version, body.reason, currentActorId())
            : await svc.reinstate(params.id, version, body.reason, currentActorId());
        sendOne(res, p, { version: p.version });
      },
    });
  }

  m.route({
    method: 'post',
    path: '/:id/link-user',
    summary: 'Link the profile’s user account',
    description:
      'The account that signs in as this profile (it then sees its own records: self scope). user_id null ' +
      'unlinks. Needs user.edit as well.',
    auth: { permission: 'employment.edit' },
    ...byId,
    body: LinkUserBody,
    ifMatch: true,
    success: { status: 200, description: 'Linked', schema: ProfileOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: LinkUserBody });
      const p = await svc.linkUser(params.id, requireIfMatch(req), body, currentActorId(), req.originalUrl);
      sendOne(res, p, { version: p.version });
    },
  });

  return m.build();
}

export function workforceModules(deps: WorkforceDeps): ApiModule[] {
  return [personsModule(deps), profilesModule(deps)];
}
