import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery, type ListQuery } from '../../core/http/list-query.js';
import { masterItemRoutes } from '../../core/http/master.js';
import { sendCreated, sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { registerApprovalAdapter } from '../../core/approval/adapters.js';
import { appliedScope } from '../../core/scope/scope.js';
import {
  ASSIGNMENT_STATES,
  AsOfQuery,
  AssignmentOut,
  AssignmentParams,
  CHANGE_REASONS,
  CreateAssignmentBody,
  PatchAssignmentBody,
  ReplaceAssignmentBody,
  WAGE_BASES,
} from './assignment.schema.js';
import { assignmentService } from './assignment.service.js';
import {
  BenefitEntitlementOut,
  BenefitIssueOut,
  BENEFICIARY_TYPES,
  CASE_STATES,
  CloseBody,
  CreateCaseBody,
  CreateEntitlementBody as CreateBenefitEntitlementBody,
  CreateIssueBody,
  DisburseBody,
  ENTITLEMENT_STATES as BENEFIT_ENTITLEMENT_STATES,
  GenerateIssuesBody,
  GenerateIssuesOut,
  IdParams as BenefitParams,
  ISSUE_STATES,
  PatchCaseBody,
  PatchEntitlementBody as PatchBenefitEntitlementBody,
  WELFARE_CATEGORIES,
  WelfareCaseOut,
  WithdrawBody,
} from './benefit.schema.js';
import { benefitService } from './benefit.service.js';
import {
  AddParticipantsBody,
  CancelProgramBody,
  CreateProgramBody,
  IdParams as TrainingParams,
  ParticipantOut,
  ParticipantParams,
  PatchProgramBody,
  PROGRAM_STATES,
  ProgramOut,
  RecordParticipantBody,
  TRAINER_TYPES,
  TRAINING_TYPES,
} from './training.schema.js';
import { trainingService } from './training.service.js';
import {
  AcknowledgeBody,
  CalendarOut,
  CalendarQuery,
  CancelGoalBody,
  CreateEvaluationBody,
  CreateGoalBody,
  EVALUATION_STATES,
  EVALUATION_TYPES,
  EvaluationOut,
  GOAL_OWNER_TYPES,
  GOAL_STATES,
  GoalOut,
  IdParams as PerformanceParams,
  LinesBody,
  OverviewOut,
  OverviewQuery,
  PatchEvaluationBody,
  PatchGoalBody,
  ProgressBody,
  ProgressOut,
} from './performance.schema.js';
import { performanceService } from './performance.service.js';
import { contactsService } from '../facilities/contacts.service.js';
import { contactRoutes } from '../facilities/facilities.routes.js';
import {
  BlacklistBody,
  CONTRACT_STATES,
  CONTRACT_STATUSES,
  CONTRACTOR_STATUSES,
  CONTRACTOR_TYPES,
  ContractOut,
  ContractorOut,
  ContractorSummaryOut,
  CreateContractBody,
  CreateContractorBody,
  CreateLabourBody,
  IdParams as ContractorParams,
  LabourOut,
  LabourParams,
  PatchContractBody,
  PatchContractorBody,
  PatchLabourBody,
  RATE_BASES,
  ReplaceContractBody,
  ReplaceContractorBody,
  SummaryQuery as ContractorSummaryQuery,
  TerminateBody,
  WORK_LOCATIONS as CONTRACT_WORK_LOCATIONS,
  WORK_TYPES,
} from './contractor.schema.js';
import { contractorService } from './contractor.service.js';
import {
  AdjustBody,
  CancelBody,
  CreateLeaveBody,
  EntitlementOut,
  GenerateBody,
  GenerateOut,
  IdParams as LeaveParams,
  LEAVE_STATES,
  LeaveOut,
  PatchLeaveBody,
} from './leave.schema.js';
import { leaveService } from './leave.service.js';
import { setWorkforceScopeTimezone } from './person.scope.js';
import {
  AddMembersBody,
  CreateTeamBody,
  EndMemberBody,
  MemberOut,
  MemberParams,
  MembersQuery,
  PatchMemberBody,
  PatchTeamBody,
  ReplaceTeamBody,
  TEAM_STATUSES,
  TEAM_TYPES,
  TeamOut,
  TeamParams,
} from './team.schema.js';
import { teamService } from './team.service.js';
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

/**
 * HTTP surface of the workforce module: persons (P2.01), employment profiles (P2.02), employment
 * assignments (P2.03), worker teams (P2.04), contractors (P2.05), leave (P2.07) and benefits and welfare
 * (P2.08), training (P2.09) and goals and evaluations (P2.10); Spec P4 §8.3, §6.5, §12.4.
 */

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
      'engagement type, category, job nature, working location, grade, supervisor, joining date, and by the ' +
      'current assignment: department, designation, division, section, job / task. ' +
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
        department_id: { type: 'id', ops: ['eq', 'in'] },
        designation_id: { type: 'id', ops: ['eq', 'in'] },
        division_id: { type: 'id', ops: ['eq', 'in'] },
        section_id: { type: 'id', ops: ['eq', 'in'] },
        activity_type_id: { type: 'id', ops: ['eq', 'in'] },
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
      'percentages, new and exits this month, average tenure, by category, department, engagement type, gender, age ' +
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

  // ---- assignments of a profile (P2.03) ----------------------------------------------------------------
  const assignments = assignmentService({ db, accessLog, timezone: config.timezone });
  m.route({
    method: 'get',
    path: '/:id/assignments',
    summary: 'A profile’s assignment timeline',
    description:
      'Every assignment of the profile, latest start first: approved ones (the closed ones with effective_to), ' +
      'the pending change (draft or submitted) and rejected ones. is_current marks the one in force today.',
    auth: { permission: 'employment.view' },
    ...byId,
    success: { status: 200, description: 'The assignments', schema: AssignmentOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await assignments.ofProfile(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'get',
    path: '/:id/assignments/resolve',
    summary: 'The assignment in force on a date',
    description:
      'The approved assignment that applied on as_of (today when omitted): what payroll, attendance and cost ' +
      'attribution of that date use. 404 when none was in force (before joining).',
    auth: { permission: 'employment.view' },
    ...byId,
    query: AsOfQuery,
    success: { status: 200, description: 'The assignment', schema: AssignmentOut },
    errors: [],
    handler: async (_req, res) => {
      const { params, query } = getValidated(res, { ...byId, query: AsOfQuery });
      sendOne(res, await assignments.resolve(params.id, query.as_of));
    },
  });

  m.route({
    method: 'post',
    path: '/:id/assignments',
    summary: 'Start an assignment (a draft)',
    description:
      'A transfer, promotion, demotion, wage revision or other change from effective_from, as a DRAFT: submit ' +
      'it to put it into effect. Fields left out are carried over from the latest approved assignment (a ' +
      'transfer names only the new section; its division follows the section); null clears one. The first ' +
      'assignment starts on the joining date with change_reason joining; a later one starts after the latest ' +
      'approved one. An employee needs department and designation, a worker section and job / task ' +
      '(activity_type_id). One pending change per profile (422 DUPLICATE_KEY).',
    auth: { permission: 'employment.create' },
    ...byId,
    body: CreateAssignmentBody,
    success: { status: 201, description: 'Drafted', schema: AssignmentOut },
    errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CreateAssignmentBody });
      const a = await assignments.create(params.id, body, currentActorId());
      sendCreated(res, a, `/api/v1/employment-assignments/${a.id}`, a.version);
    },
  });

  const training = trainingService({ db, accessLog, timezone: config.timezone });
  m.route({
    method: 'get',
    path: '/:id/trainings',
    summary: 'A profile’s training history',
    description:
      'Every programme the profile took part in, latest first, with attendance, result and certificate.',
    auth: { permission: 'training.view' },
    ...byId,
    success: { status: 200, description: 'The trainings', schema: ParticipantOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await training.participants.ofProfile(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  const teams = teamService({ db, accessLog, timezone: config.timezone });
  m.route({
    method: 'get',
    path: '/:id/teams',
    summary: 'A worker’s team memberships',
    description: 'Every team the worker was, is or will be in, latest first; is_current marks today’s.',
    auth: { permission: 'team.view' },
    ...byId,
    success: { status: 200, description: 'The memberships', schema: MemberOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await teams.ofProfile(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  return m.build();
}

function teamsModule({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule {
  const svc = teamService({ db, accessLog, timezone: config.timezone });
  const m = defineModule({
    name: 'worker-teams',
    path: '/worker-teams',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });
  const byMember = { params: MemberParams };

  m.route({
    method: 'get',
    path: '/',
    summary: 'List worker teams',
    description:
      'Teams in your scope, with today’s member count and leader: filter by estate, division, section, type, ' +
      'supervisor, status; filter[name] / filter[code] like.',
    auth: { permission: 'team.view' },
    list: {
      pagination: 'page',
      filters: {
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        division_id: { type: 'id', ops: ['eq', 'in'] },
        section_id: { type: 'id', ops: ['eq', 'in'] },
        supervisor_profile_id: { type: 'id', ops: ['eq'] },
        team_type: { type: { enum: TEAM_TYPES }, ops: ['eq', 'in'] },
        status: { type: { enum: TEAM_STATUSES } },
        code: { type: 'string', ops: ['eq', 'like'] },
        name: { type: 'string', ops: ['like'] },
      },
      sorts: ['code', 'name'],
      defaultSort: ['code'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of teams', schema: TeamOut },
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
    summary: 'Create a worker team',
    description:
      'A plucking, field, factory or general team of an estate: code unique within the estate, an optional ' +
      'sardar / supervisor (a profile of the estate), division and section (the division follows the section).',
    auth: { permission: 'team.create' },
    body: CreateTeamBody,
    success: { status: 201, description: 'Created', schema: TeamOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateTeamBody });
      const t = await svc.create(body, currentActorId());
      sendCreated(res, t, `/api/v1/worker-teams/${t.id}`, t.version);
    },
  });

  masterItemRoutes(m, {
    module: 'team',
    label: 'team',
    out: TeamOut,
    replace: ReplaceTeamBody,
    patch: PatchTeamBody,
    svc,
    updateErrors: ['DUPLICATE_KEY'],
    deleteHelp: 'Only a team that never had a member. Otherwise end the memberships and deactivate it.',
  });

  m.route({
    method: 'get',
    path: '/:id/members',
    summary: 'A team’s members',
    description:
      'The members on as_of (today when omitted), leader first: what a team distribution of that date uses. ' +
      'history=true lists every membership, past and future, latest first.',
    auth: { permission: 'team.view' },
    params: TeamParams,
    query: MembersQuery,
    success: { status: 200, description: 'The members', schema: MemberOut },
    errors: [],
    handler: async (req, res) => {
      const { params, query } = getValidated(res, { params: TeamParams, query: MembersQuery });
      const items = await svc.members(params.id, query.as_of, query.history === 'true');
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/members',
    summary: 'Add members',
    description:
      'Workers join from effective_from, as member, leader or assistant (one leader at a time). Each must be a ' +
      'worker profile of the team’s estate, not separated, joined by then. A worker is in one team at a time: ' +
      'one still in another team is refused (422 DUPLICATE_KEY, naming it) unless move_from_other_team, which ' +
      'ends that membership the day before. All or nothing.',
    auth: { permission: 'team.edit' },
    params: TeamParams,
    body: AddMembersBody,
    success: { status: 200, description: 'The memberships added', schema: MemberOut },
    errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { params: TeamParams, body: AddMembersBody });
      const items = await svc.addMembers(params.id, body, currentActorId());
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/members/:memberId/end',
    summary: 'End a membership',
    description:
      'effective_to is the worker’s last day in the team. The membership itself stays in the history.',
    auth: { permission: 'team.edit' },
    ...byMember,
    body: EndMemberBody,
    ifMatch: true,
    success: { status: 200, description: 'Ended', schema: MemberOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byMember, body: EndMemberBody });
      const m2 = await svc.endMember(
        params.id,
        params.memberId,
        requireIfMatch(req),
        body.effective_to,
        currentActorId(),
      );
      sendOne(res, m2, { version: m2.version });
    },
  });

  m.route({
    method: 'patch',
    path: '/:id/members/:memberId',
    summary: 'Change a member’s role',
    description: 'member, leader or assistant: one leader at a time over the membership’s dates.',
    auth: { permission: 'team.edit' },
    ...byMember,
    body: PatchMemberBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: MemberOut },
    errors: ['SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byMember, body: PatchMemberBody });
      const m2 = await svc.setRole(
        params.id,
        params.memberId,
        requireIfMatch(req),
        body.role_in_team,
        currentActorId(),
      );
      sendOne(res, m2, { version: m2.version });
    },
  });

  m.route({
    method: 'delete',
    path: '/:id/members/:memberId',
    summary: 'Delete a membership entered in error',
    description: 'A worker who left is ended (POST …/end), not deleted.',
    auth: { permission: 'team.edit' },
    ...byMember,
    success: { status: 204, description: 'Deleted' },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byMember);
      await svc.removeMember(params.id, params.memberId, currentActorId());
      sendNoContent(res);
    },
  });

  return m.build();
}

function contractorsModule({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule[] {
  const svc = contractorService({ db, accessLog, timezone: config.timezone });
  registerApprovalAdapter(svc.adapter);
  const byId = { params: ContractorParams };
  const byLabour = { params: LabourParams };
  const m = defineModule({
    name: 'contractors',
    path: '/contractors',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List contractors',
    description:
      'Contractor Management: filter by contractor type, trade category, status, registering estate, and by ' +
      'where their contracts are (estate_id, division_id, work_location). filter[q]=… searches ID, name, short ' +
      'name and mobile. Each row carries current_contract (start, end, value, location) and number_of_workers.',
    auth: { permission: 'contractor.view' },
    list: {
      pagination: 'page',
      filters: {
        q: { type: 'string', ops: ['eq'] },
        contractor_type: { type: { enum: CONTRACTOR_TYPES }, ops: ['eq', 'in'] },
        trade_category_id: { type: 'id', ops: ['eq', 'in'] },
        status: { type: { enum: CONTRACTOR_STATUSES }, ops: ['eq', 'in'] },
        registered_estate_id: { type: 'id', ops: ['eq', 'in'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        division_id: { type: 'id', ops: ['eq', 'in'] },
        work_location: { type: { enum: CONTRACT_WORK_LOCATIONS }, ops: ['eq', 'in'] },
        name: { type: 'string', ops: ['like'] },
        created_at: { type: 'datetime', ops: ['from', 'to'] },
      },
      sorts: ['code', 'name', 'created_at'],
      defaultSort: ['code'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of contractors', schema: ContractorOut },
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
    summary: 'The contractor figures',
    description:
      'The cards and charts of Contractor Management, within your scope: total, active, inactive, contracts ' +
      'expiring (within expiring_days, default 30), new this month, total contract value (contracts in force), by ' +
      'contractor type, work type, trade category and status, top contractors by value, expiry alerts, licences expiring.',
    auth: { permission: 'contractor.view' },
    query: ContractorSummaryQuery,
    success: { status: 200, description: 'The figures', schema: ContractorSummaryOut },
    errors: [],
    handler: async (_req, res) => {
      const { query } = getValidated(res, { query: ContractorSummaryQuery });
      sendOne(res, await svc.summary(query.estate_id, query.expiring_days));
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Register a contractor',
    description:
      'The Add New Contractor form in one request: the contractor (code numbered CON-… when omitted), its contact ' +
      'person (the primary contact) and, optionally, first_contract (a DRAFT contract: submit it with POST ' +
      '/contractor-contracts/{id}/submit). Documents follow with POST /contractors/{id}/documents.',
    auth: { permission: 'contractor.create' },
    body: CreateContractorBody,
    success: { status: 201, description: 'Registered', schema: ContractorOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateContractorBody });
      const c = await svc.create(body, currentActorId());
      sendCreated(res, c, `/api/v1/contractors/${c.id}`, c.version);
    },
  });

  masterItemRoutes(m, {
    module: 'contractor',
    label: 'contractor',
    out: ContractorOut,
    replace: ReplaceContractorBody,
    patch: PatchContractorBody,
    svc,
    updateErrors: ['DUPLICATE_KEY'],
    deleteHelp:
      'Only a contractor registered in error, with no contract. Otherwise deactivate or blacklist it.',
  });

  m.route({
    method: 'post',
    path: '/:id/blacklist',
    summary: 'Blacklist a contractor',
    description:
      'The design’s "Blacklist Contractor": with a reason. A blacklisted contractor takes no new contract; reactivate lifts it.',
    auth: { permission: 'contractor.approve' },
    ...byId,
    body: BlacklistBody,
    ifMatch: true,
    success: { status: 200, description: 'Blacklisted', schema: ContractorOut },
    errors: ['SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: BlacklistBody });
      const c = await svc.setStatus(
        params.id,
        requireIfMatch(req),
        'blacklisted',
        currentActorId(),
        body.reason,
      );
      sendOne(res, c, { version: c.version });
    },
  });

  m.route({
    method: 'get',
    path: '/:id/contracts',
    summary: 'A contractor’s contracts',
    auth: { permission: 'contractor.view' },
    ...byId,
    success: { status: 200, description: 'The contracts', schema: ContractOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      await svc.get(params.id);
      const q: ListQuery = {
        filters: [{ field: 'contractor_id', op: 'eq', value: params.id.toString() }],
        sort: [{ field: 'start_date', direction: 'desc' }],
        include: [],
        fields: {},
        page: { page: 1, perPage: 500 },
      };
      const { items, total } = await svc.contracts.list(q);
      sendPage(req, res, items, { pagination: { page: 1, perPage: Math.max(items.length, 1) }, total });
    },
  });

  contactRoutes(m, contactsService(db, svc.contactOwner), 'contractor', '/contractors');

  const c = defineModule({
    name: 'contractor-contracts',
    path: '/contractor-contracts',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });

  c.route({
    method: 'get',
    path: '/',
    summary: 'List contractor contracts',
    description:
      'Filters: contractor, estate, division, state, status (pending, upcoming, active, completed, terminated, ' +
      'rejected), work type, rate basis, work location, start / end date ranges, expiring_within_days=30.',
    auth: { permission: 'contractor.view' },
    list: {
      pagination: 'page',
      filters: {
        contractor_id: { type: 'id', ops: ['eq', 'in'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        division_id: { type: 'id', ops: ['eq', 'in'] },
        state: { type: { enum: CONTRACT_STATES }, ops: ['eq', 'in'] },
        status: { type: { enum: CONTRACT_STATUSES }, ops: ['eq', 'in'] },
        work_type: { type: { enum: WORK_TYPES }, ops: ['eq', 'in'] },
        rate_basis: { type: { enum: RATE_BASES }, ops: ['eq', 'in'] },
        work_location: { type: { enum: CONTRACT_WORK_LOCATIONS }, ops: ['eq', 'in'] },
        start_date: { type: 'date', ops: ['from', 'to'] },
        end_date: { type: 'date', ops: ['from', 'to'] },
        expiring_within_days: { type: 'int', ops: ['eq'] },
      },
      sorts: ['contract_number', 'start_date', 'end_date', 'created_at'],
      defaultSort: ['-start_date'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of contracts', schema: ContractOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.contracts.list(q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });

  c.route({
    method: 'post',
    path: '/',
    summary: 'Draft a contractor contract',
    description:
      'At an estate you may change, for an active contractor: numbered CC-… per estate and year. contract_value is ' +
      'required for lump_sum. Submit it to route it through the contractor_contract workflow (P7 §9.5).',
    auth: { permission: 'contractor.create' },
    body: CreateContractBody,
    success: { status: 201, description: 'Drafted', schema: ContractOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateContractBody });
      const k = await svc.contracts.create(body, currentActorId());
      sendCreated(res, k, `/api/v1/contractor-contracts/${k.id}`, k.version);
    },
  });

  c.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a contractor contract',
    auth: { permission: 'contractor.view' },
    ...byId,
    success: { status: 200, description: 'The contract', schema: ContractOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const k = await svc.contracts.get(params.id);
      sendOne(res, k, { version: k.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceContractBody, 'Replace a draft contract'],
    ['patch', PatchContractBody, 'Change some of a draft contract'],
  ] as const) {
    c.route({
      method,
      path: '/:id',
      summary,
      description: 'Drafts only (a returned one is a draft again): 409 INVALID_TRANSITION otherwise.',
      auth: { permission: 'contractor.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Changed', schema: ContractOut },
      errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: PatchContractBody });
        const k = await svc.contracts.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, k, { version: k.version });
      },
    });
  }

  c.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft contract',
    auth: { permission: 'contractor.delete' },
    ...byId,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.contracts.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  c.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit a contract for approval',
    description:
      'Routed through the contractor_contract workflow (P7 §9.5: estate manager always; finance manager when ' +
      'contract_value ≥ T2; managing director ≥ T3 or a long term). The result is `submitted` with approval_id, ' +
      'decided with POST /approvals/{approval_id}/approve|reject|return; with no workflow it is approved at once.',
    auth: { permission: 'contractor.create' },
    ...byId,
    ifMatch: true,
    success: { status: 200, description: 'Submitted', schema: ContractOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED', 'RULE_AMBIGUOUS'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const k = await svc.contracts.submit(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, k, { version: k.version });
    },
  });

  c.route({
    method: 'post',
    path: '/:id/terminate',
    summary: 'Terminate an approved contract',
    description:
      'Ends it early: the last day of work (within the contract) and the reason. Its labour is ended that day.',
    auth: { permission: 'contractor.approve' },
    ...byId,
    body: TerminateBody,
    ifMatch: true,
    success: { status: 200, description: 'Terminated', schema: ContractOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: TerminateBody });
      const k = await svc.contracts.terminate(
        params.id,
        requireIfMatch(req),
        body.terminated_on,
        body.reason,
        currentActorId(),
      );
      sendOne(res, k, { version: k.version });
    },
  });

  c.route({
    method: 'get',
    path: '/:id/labour',
    summary: 'The labour of a contract',
    description:
      'Named people supplied under the contract. They have no employment profile and no payroll (P1 §5.5.1).',
    auth: { permission: 'contractor.view' },
    ...byId,
    success: { status: 200, description: 'The labour', schema: LabourOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await svc.labour.list(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  c.route({
    method: 'post',
    path: '/:id/labour',
    summary: 'Add labour to a contract',
    description:
      'labour_code is numbered L-0001 … within the contract when omitted; engagement within the contract dates.',
    auth: { permission: 'contractor.edit' },
    ...byId,
    body: CreateLabourBody,
    success: { status: 201, description: 'Added', schema: LabourOut },
    errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CreateLabourBody });
      const l = await svc.labour.add(params.id, body, currentActorId());
      sendCreated(res, l, `/api/v1/contractor-contracts/${params.id.toString()}/labour/${l.id}`, l.version);
    },
  });

  c.route({
    method: 'patch',
    path: '/:id/labour/:labourId',
    summary: 'Change a labourer’s details',
    description: 'Name, ID, phone, engagement dates; status inactive when they stop working.',
    auth: { permission: 'contractor.edit' },
    ...byLabour,
    body: PatchLabourBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: LabourOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byLabour, body: PatchLabourBody });
      const l = await svc.labour.update(
        params.id,
        params.labourId,
        requireIfMatch(req),
        body,
        currentActorId(),
      );
      sendOne(res, l, { version: l.version });
    },
  });

  c.route({
    method: 'delete',
    path: '/:id/labour/:labourId',
    summary: 'Delete labour entered in error',
    auth: { permission: 'contractor.edit' },
    ...byLabour,
    success: { status: 204, description: 'Deleted' },
    errors: ['REFERENCED_RECORD', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byLabour);
      await svc.labour.remove(params.id, params.labourId, currentActorId());
      sendNoContent(res);
    },
  });

  return [m.build(), c.build()];
}

function leaveModules({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule[] {
  const svc = leaveService({ db, accessLog, timezone: config.timezone });
  registerApprovalAdapter(svc.adapter);
  const byId = { params: LeaveParams };
  const e = defineModule({
    name: 'leave-entitlements',
    path: '/leave-entitlements',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });

  e.route({
    method: 'get',
    path: '/',
    summary: 'Leave balances',
    description:
      'The Leave Balance register (HR-008): per profile, leave type and fiscal year, with entitled, carried ' +
      'forward, adjustment, total available, consumed, pending, balance and available_to_request. Filters: ' +
      'employment_profile_id, leave_type_id, fiscal_year_id, estate_id. Everyone sees their own (self scope).',
    auth: { permission: 'leave.view' },
    list: {
      pagination: 'page',
      filters: {
        employment_profile_id: { type: 'id', ops: ['eq', 'in'] },
        leave_type_id: { type: 'id', ops: ['eq', 'in'] },
        fiscal_year_id: { type: 'id', ops: ['eq'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
      },
      sorts: [],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of entitlements', schema: EntitlementOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.entitlements.list(q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });

  e.route({
    method: 'post',
    path: '/generate',
    summary: 'Generate a fiscal year’s entitlements',
    description:
      'For every current profile employed in the year (of the estate, or one profile), every active leave type ' +
      'with annual_days that applies to it: entitled = annual_days × months employed ÷ 12 (3 places, P9 LV.1), ' +
      'plus the previous year’s balance carried forward up to the type’s limit (LV.2). Existing entitlements ' +
      'are kept. Run again for a new joiner.',
    auth: { permission: 'leave.create' },
    body: GenerateBody,
    success: { status: 200, description: 'Generated', schema: GenerateOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: GenerateBody });
      sendOne(res, await svc.entitlements.generate(body, currentActorId()));
    },
  });

  e.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a leave entitlement',
    auth: { permission: 'leave.view' },
    ...byId,
    success: { status: 200, description: 'The entitlement', schema: EntitlementOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.entitlements.get(params.id);
      sendOne(res, x, { version: x.version });
    },
  });

  e.route({
    method: 'post',
    path: '/:id/adjust',
    summary: 'Adjust an entitlement',
    description:
      'An approved manual adjustment with its reason (P3 §22.1): replaces the adjustment; may be negative.',
    auth: { permission: 'leave.approve' },
    ...byId,
    body: AdjustBody,
    ifMatch: true,
    success: { status: 200, description: 'Adjusted', schema: EntitlementOut },
    errors: ['INSUFFICIENT_BALANCE', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: AdjustBody });
      const x = await svc.entitlements.adjust(
        params.id,
        requireIfMatch(req),
        body.adjustment_days,
        body.reason,
        currentActorId(),
      );
      sendOne(res, x, { version: x.version });
    },
  });

  const r = defineModule({
    name: 'leave-requests',
    path: '/leave-requests',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });

  r.route({
    method: 'get',
    path: '/',
    summary: 'List leave requests',
    description:
      'The Leave Register (HR-007): filters profile, estate, leave type, state, date ranges. Your own are always visible.',
    auth: { permission: 'leave.view' },
    list: {
      pagination: 'page',
      filters: {
        employment_profile_id: { type: 'id', ops: ['eq', 'in'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        leave_type_id: { type: 'id', ops: ['eq', 'in'] },
        state: { type: { enum: LEAVE_STATES }, ops: ['eq', 'in'] },
        from_date: { type: 'date', ops: ['from', 'to'] },
        to_date: { type: 'date', ops: ['from', 'to'] },
      },
      sorts: ['from_date', 'request_number', 'created_at'],
      defaultSort: ['-from_date'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of requests', schema: LeaveOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.requests.list(q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });

  r.route({
    method: 'post',
    path: '/',
    summary: 'Draft a leave request',
    description:
      'Your own leave (employment_profile_id omitted: the profile linked to your account), or, with the estate, ' +
      'someone else’s. day_count is computed: working days from from_date to to_date (weekly offs excluded), a ' +
      'half day 0.5. Within one fiscal year; no overlap with other leave; a type with annual days needs the ' +
      'year’s entitlement. Submit it to check the balance and route it for approval.',
    auth: { permission: 'leave.create' },
    body: CreateLeaveBody,
    success: { status: 201, description: 'Drafted', schema: LeaveOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateLeaveBody });
      const x = await svc.requests.create(body, currentActorId());
      sendCreated(res, x, `/api/v1/leave-requests/${x.id}`, x.version);
    },
  });

  r.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a leave request',
    auth: { permission: 'leave.view' },
    ...byId,
    success: { status: 200, description: 'The request', schema: LeaveOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.requests.get(params.id);
      sendOne(res, x, { version: x.version });
    },
  });

  r.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a draft leave request',
    auth: { permission: 'leave.create' },
    ...byId,
    body: PatchLeaveBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: LeaveOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchLeaveBody });
      const x = await svc.requests.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });

  r.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft leave request',
    auth: { permission: 'leave.create' },
    ...byId,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.requests.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  r.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit a leave request',
    description:
      'Refused with 422 INSUFFICIENT_BALANCE when it exceeds the balance less the leave already pending (the ' +
      'balance is in the error’s context), unless the type allows a negative balance. Routed through the leave ' +
      'workflow (P7 §7.9: the submitter’s supervisor, HR, the estate manager for long leave); approval consumes ' +
      'the entitlement.',
    auth: { permission: 'leave.create' },
    ...byId,
    ifMatch: true,
    success: { status: 200, description: 'Submitted', schema: LeaveOut },
    errors: ['INSUFFICIENT_BALANCE', 'INVALID_TRANSITION', 'SCOPE_DENIED', 'RULE_AMBIGUOUS'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.requests.submit(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });

  r.route({
    method: 'post',
    path: '/:id/cancel',
    summary: 'Cancel approved leave',
    description: 'Restores the balance. A submitted request is returned or rejected by its approver instead.',
    auth: { permission: 'leave.create' },
    ...byId,
    body: CancelBody,
    ifMatch: true,
    success: { status: 200, description: 'Cancelled', schema: LeaveOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CancelBody });
      const x = await svc.requests.cancel(params.id, requireIfMatch(req), body.reason, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });

  return [e.build(), r.build()];
}

function benefitModules({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule[] {
  const svc = benefitService({ db, accessLog, timezone: config.timezone });
  for (const a of svc.adapters) registerApprovalAdapter(a);
  const byId = { params: BenefitParams };
  const page = (q: ListQuery) => q.page ?? { page: 1, perPage: 25 };
  const listOf = (filters: Record<string, object>, sorts: string[], defaultSort: string[]) => ({
    pagination: 'page' as const,
    filters: filters as never,
    sorts,
    defaultSort,
    maxPageSize: 500,
  });

  // ---- entitlements ------------------------------------------------------------------------------------
  const e = defineModule({
    name: 'benefit-entitlements',
    path: '/benefit-entitlements',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });
  e.route({
    method: 'get',
    path: '/',
    summary: 'List benefit entitlements',
    description:
      'Ration cards, housing, medical … per profile. Filters: profile, estate, benefit type, state, effective_from. Everyone sees their own.',
    auth: { permission: 'benefit.view' },
    list: listOf(
      {
        employment_profile_id: { type: 'id', ops: ['eq', 'in'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        benefit_type_id: { type: 'id', ops: ['eq', 'in'] },
        state: { type: { enum: BENEFIT_ENTITLEMENT_STATES }, ops: ['eq', 'in'] },
        effective_from: { type: 'date', ops: ['from', 'to'] },
      },
      ['effective_from'],
      ['-effective_from'],
    ),
    success: { status: 200, description: 'A page of entitlements', schema: BenefitEntitlementOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.entitlements.list(q);
      sendPage(req, res, items, { pagination: page(q), total, appliedScope: await appliedScope() });
    },
  });
  e.route({
    method: 'post',
    path: '/',
    summary: 'Draft a benefit entitlement',
    description:
      'The design’s Ration Card tab: benefit_type_id (RATION), allocation_reference (Ration Card No.), effective_from (Issue Date), ' +
      'effective_to (Valid Till), issuing_office (Ration Dealer / Office); quantity and employer cost per period. The card itself is ' +
      'uploaded to /persons/{id}/documents as RATION_CARD. No overlap with the same benefit. Submit it for approval.',
    auth: { permission: 'benefit.create' },
    body: CreateBenefitEntitlementBody,
    success: { status: 201, description: 'Drafted', schema: BenefitEntitlementOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateBenefitEntitlementBody });
      const x = await svc.entitlements.create(body, currentActorId());
      sendCreated(res, x, `/api/v1/benefit-entitlements/${x.id}`, x.version);
    },
  });
  e.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a benefit entitlement',
    auth: { permission: 'benefit.view' },
    ...byId,
    success: { status: 200, description: 'The entitlement', schema: BenefitEntitlementOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.entitlements.get(params.id);
      sendOne(res, x, { version: x.version });
    },
  });
  e.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a draft entitlement',
    auth: { permission: 'benefit.edit' },
    ...byId,
    body: PatchBenefitEntitlementBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: BenefitEntitlementOut },
    errors: ['INVALID_TRANSITION', 'DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchBenefitEntitlementBody });
      const x = await svc.entitlements.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  e.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft entitlement',
    auth: { permission: 'benefit.delete' },
    ...byId,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.entitlements.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  e.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit an entitlement for approval',
    description:
      'Routed through the benefit_entitlement workflow; decided with POST /approvals/{approval_id}/approve|reject|return.',
    auth: { permission: 'benefit.submit' },
    ...byId,
    ifMatch: true,
    success: { status: 200, description: 'Submitted', schema: BenefitEntitlementOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED', 'RULE_AMBIGUOUS'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.entitlements.submit(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  e.route({
    method: 'post',
    path: '/:id/withdraw',
    summary: 'Withdraw an approved entitlement',
    description: 'From a date (its last day), with a reason. Refused while issues fall after that date.',
    auth: { permission: 'benefit.approve' },
    ...byId,
    body: WithdrawBody,
    ifMatch: true,
    success: { status: 200, description: 'Withdrawn', schema: BenefitEntitlementOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: WithdrawBody });
      const x = await svc.entitlements.withdraw(
        params.id,
        requireIfMatch(req),
        body.effective_to,
        body.reason,
        currentActorId(),
      );
      sendOne(res, x, { version: x.version });
    },
  });

  // ---- issues ------------------------------------------------------------------------------------------
  const i = defineModule({
    name: 'benefit-issues',
    path: '/benefit-issues',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });
  i.route({
    method: 'get',
    path: '/',
    summary: 'List benefit issues',
    description: 'Filters: entitlement, profile, benefit type, estate, state, issue date, period.',
    auth: { permission: 'benefit.view' },
    list: listOf(
      {
        benefit_entitlement_id: { type: 'id', ops: ['eq'] },
        employment_profile_id: { type: 'id', ops: ['eq'] },
        benefit_type_id: { type: 'id', ops: ['eq'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        state: { type: { enum: ISSUE_STATES }, ops: ['eq', 'in'] },
        issue_date: { type: 'date', ops: ['from', 'to'] },
        period_reference: { type: 'string', ops: ['eq'] },
      },
      ['issue_date'],
      ['-issue_date'],
    ),
    success: { status: 200, description: 'A page of issues', schema: BenefitIssueOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.issues.list(q);
      sendPage(req, res, items, { pagination: page(q), total, appliedScope: await appliedScope() });
    },
  });
  i.route({
    method: 'post',
    path: '/',
    summary: 'Draft a benefit issue',
    description:
      'Under an approved entitlement in force on issue_date; quantity and cost default from the entitlement (cost from the type).',
    auth: { permission: 'benefit.create' },
    body: CreateIssueBody,
    success: { status: 201, description: 'Drafted', schema: BenefitIssueOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateIssueBody });
      const x = await svc.issues.create(body, currentActorId());
      sendCreated(res, x, `/api/v1/benefit-issues/${x.id}`, x.version);
    },
  });
  i.route({
    method: 'post',
    path: '/generate',
    summary: 'Draft this period’s issues',
    description:
      'One draft issue for every entitlement of the benefit type at the estate in force on issue_date (e.g. this week’s ration). Existing ones are kept.',
    auth: { permission: 'benefit.create' },
    body: GenerateIssuesBody,
    success: { status: 200, description: 'Generated', schema: GenerateIssuesOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: GenerateIssuesBody });
      sendOne(res, await svc.issues.generate(body, currentActorId()));
    },
  });
  i.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a benefit issue',
    auth: { permission: 'benefit.view' },
    ...byId,
    success: { status: 200, description: 'The issue', schema: BenefitIssueOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.issues.get(params.id);
      sendOne(res, x, { version: x.version });
    },
  });
  i.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft issue',
    auth: { permission: 'benefit.delete' },
    ...byId,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.issues.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  i.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit an issue for approval',
    description: 'Routed through the benefit_issue workflow (financial: never self-approved).',
    auth: { permission: 'benefit.submit' },
    ...byId,
    ifMatch: true,
    success: { status: 200, description: 'Submitted', schema: BenefitIssueOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED', 'RULE_AMBIGUOUS'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.issues.submit(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });

  // ---- welfare cases -----------------------------------------------------------------------------------
  const w = defineModule({
    name: 'welfare-cases',
    path: '/welfare-cases',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });
  w.route({
    method: 'get',
    path: '/',
    summary: 'List welfare cases',
    auth: { permission: 'welfare.view' },
    list: listOf(
      {
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        beneficiary_type: { type: { enum: BENEFICIARY_TYPES }, ops: ['eq', 'in'] },
        beneficiary_id: { type: 'id', ops: ['eq'] },
        welfare_category: { type: { enum: WELFARE_CATEGORIES }, ops: ['eq', 'in'] },
        state: { type: { enum: CASE_STATES }, ops: ['eq', 'in'] },
        case_date: { type: 'date', ops: ['from', 'to'] },
      },
      ['case_date', 'case_number'],
      ['-case_date'],
    ),
    success: { status: 200, description: 'A page of cases', schema: WelfareCaseOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.cases.list(q);
      sendPage(req, res, items, { pagination: page(q), total, appliedScope: await appliedScope() });
    },
  });
  w.route({
    method: 'post',
    path: '/',
    summary: 'Open a welfare case',
    description:
      'For a profile or a person of the estate, or the community; numbered WC-… per estate and year. A draft: submit it with its requested amount.',
    auth: { permission: 'welfare.create' },
    body: CreateCaseBody,
    success: { status: 201, description: 'Opened', schema: WelfareCaseOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateCaseBody });
      const x = await svc.cases.create(body, currentActorId());
      sendCreated(res, x, `/api/v1/welfare-cases/${x.id}`, x.version);
    },
  });
  w.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a welfare case',
    auth: { permission: 'welfare.view' },
    ...byId,
    success: { status: 200, description: 'The case', schema: WelfareCaseOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.cases.get(params.id);
      sendOne(res, x, { version: x.version });
    },
  });
  w.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a draft case',
    auth: { permission: 'welfare.edit' },
    ...byId,
    body: PatchCaseBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: WelfareCaseOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchCaseBody });
      const x = await svc.cases.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  w.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft case',
    auth: { permission: 'welfare.delete' },
    ...byId,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.cases.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  w.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit a case for approval',
    description: 'Needs the requested amount. Approval grants it (approved_amount).',
    auth: { permission: 'welfare.submit' },
    ...byId,
    ifMatch: true,
    success: { status: 200, description: 'Submitted', schema: WelfareCaseOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED', 'RULE_AMBIGUOUS'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.cases.submit(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  w.route({
    method: 'post',
    path: '/:id/disburse',
    summary: 'Record a disbursement',
    description:
      'Part of the approved amount paid out; the total never exceeds it. Payments post to the ledger from Phase 3.',
    auth: { permission: 'welfare.edit' },
    ...byId,
    body: DisburseBody,
    ifMatch: true,
    success: { status: 200, description: 'Recorded', schema: WelfareCaseOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: DisburseBody });
      const x = await svc.cases.disburse(params.id, requireIfMatch(req), body.amount, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  w.route({
    method: 'post',
    path: '/:id/close',
    summary: 'Close a case',
    description: 'With its outcome.',
    auth: { permission: 'welfare.edit' },
    ...byId,
    body: CloseBody,
    ifMatch: true,
    success: { status: 200, description: 'Closed', schema: WelfareCaseOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CloseBody });
      const x = await svc.cases.close(params.id, requireIfMatch(req), body.outcome, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });

  return [e.build(), i.build(), w.build()];
}

function trainingModule({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule {
  const svc = trainingService({ db, accessLog, timezone: config.timezone });
  registerApprovalAdapter(svc.adapter);
  const byId = { params: TrainingParams };
  const byParticipant = { params: ParticipantParams };
  const m = defineModule({
    name: 'training-programs',
    path: '/training-programs',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });
  const all = (
    req: Parameters<typeof sendPage>[0],
    res: Parameters<typeof sendPage>[1],
    items: readonly unknown[],
  ) => {
    sendPage(req, res, items, {
      pagination: { page: 1, perPage: Math.max(items.length, 1) },
      total: items.length,
    });
  };

  m.route({
    method: 'get',
    path: '/',
    summary: 'List training programmes',
    description: 'Filters: estate, training type, trainer type, state, start date range; filter[title] like.',
    auth: { permission: 'training.view' },
    list: {
      pagination: 'page',
      filters: {
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        training_type: { type: { enum: TRAINING_TYPES }, ops: ['eq', 'in'] },
        trainer_type: { type: { enum: TRAINER_TYPES } },
        state: { type: { enum: PROGRAM_STATES }, ops: ['eq', 'in'] },
        start_date: { type: 'date', ops: ['from', 'to'] },
        title: { type: 'string', ops: ['like'] },
      },
      sorts: ['start_date', 'program_code', 'title'],
      defaultSort: ['-start_date'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of programmes', schema: ProgramOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.programs.list(q);
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
    summary: 'Plan a training programme',
    description:
      'A draft at an estate: numbered TP-… when program_code is omitted. Submit it for approval (its cost).',
    auth: { permission: 'training.create' },
    body: CreateProgramBody,
    success: { status: 201, description: 'Planned', schema: ProgramOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateProgramBody });
      const x = await svc.programs.create(body, currentActorId());
      sendCreated(res, x, `/api/v1/training-programs/${x.id}`, x.version);
    },
  });
  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a training programme',
    auth: { permission: 'training.view' },
    ...byId,
    success: { status: 200, description: 'The programme', schema: ProgramOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.programs.get(params.id);
      sendOne(res, x, { version: x.version });
    },
  });
  m.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a draft programme',
    auth: { permission: 'training.edit' },
    ...byId,
    body: PatchProgramBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: ProgramOut },
    errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchProgramBody });
      const x = await svc.programs.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  m.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft programme',
    auth: { permission: 'training.delete' },
    ...byId,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.programs.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  for (const [action, summary, description, permission] of [
    [
      'submit',
      'Submit a programme for approval',
      'Routed through the training_program workflow (cost and cost centre are its condition fields).',
      'training.submit',
    ],
    [
      'complete',
      'Complete a programme',
      'From its end date, once every participant’s attendance is recorded.',
      'training.edit',
    ],
  ] as const) {
    m.route({
      method: 'post',
      path: `/:id/${action}`,
      summary,
      description,
      auth: { permission },
      ...byId,
      ifMatch: true,
      success: { status: 200, description: 'Done', schema: ProgramOut },
      errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const v = requireIfMatch(req);
        const x =
          action === 'submit'
            ? await svc.programs.submit(params.id, v, currentActorId())
            : await svc.programs.complete(params.id, v, currentActorId());
        sendOne(res, x, { version: x.version });
      },
    });
  }
  m.route({
    method: 'post',
    path: '/:id/cancel',
    summary: 'Cancel a programme',
    description: 'A draft or approved programme, with the reason.',
    auth: { permission: 'training.edit' },
    ...byId,
    body: CancelProgramBody,
    ifMatch: true,
    success: { status: 200, description: 'Cancelled', schema: ProgramOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CancelProgramBody });
      const x = await svc.programs.cancel(params.id, requireIfMatch(req), body.reason, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  m.route({
    method: 'get',
    path: '/:id/participants',
    summary: 'A programme’s participants',
    auth: { permission: 'training.view' },
    ...byId,
    success: { status: 200, description: 'The participants', schema: ParticipantOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      all(req, res, await svc.participants.list(params.id));
    },
  });
  m.route({
    method: 'post',
    path: '/:id/participants',
    summary: 'Register participants',
    description:
      'Current profiles of the programme’s estate, within its capacity; a profile once per programme (422 DUPLICATE_KEY). All or nothing.',
    auth: { permission: 'training.edit' },
    ...byId,
    body: AddParticipantsBody,
    success: { status: 200, description: 'The participants added', schema: ParticipantOut },
    errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: AddParticipantsBody });
      all(req, res, await svc.participants.add(params.id, body, currentActorId()));
    },
  });
  m.route({
    method: 'patch',
    path: '/:id/participants/:participantId',
    summary: 'Record attendance and results',
    description:
      'Attendance (from the start date), score 0–100, result, certificate, feedback 1–5. Only someone who attended is assessed or certified.',
    auth: { permission: 'training.edit' },
    ...byParticipant,
    body: RecordParticipantBody,
    ifMatch: true,
    success: { status: 200, description: 'Recorded', schema: ParticipantOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byParticipant, body: RecordParticipantBody });
      const x = await svc.participants.record(
        params.id,
        params.participantId,
        requireIfMatch(req),
        body,
        currentActorId(),
      );
      sendOne(res, x, { version: x.version });
    },
  });
  m.route({
    method: 'delete',
    path: '/:id/participants/:participantId',
    summary: 'Remove a participant registered in error',
    description: 'One who dropped out is marked withdrawn instead.',
    auth: { permission: 'training.edit' },
    ...byParticipant,
    success: { status: 204, description: 'Removed' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byParticipant);
      await svc.participants.remove(params.id, params.participantId, currentActorId());
      sendNoContent(res);
    },
  });
  return m.build();
}

function performanceModules({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule[] {
  const svc = performanceService({ db, accessLog, timezone: config.timezone });
  for (const a of svc.adapters) registerApprovalAdapter(a);
  const byId = { params: PerformanceParams };
  const all = (
    req: Parameters<typeof sendPage>[0],
    res: Parameters<typeof sendPage>[1],
    items: readonly unknown[],
  ) => {
    sendPage(req, res, items, {
      pagination: { page: 1, perPage: Math.max(items.length, 1) },
      total: items.length,
    });
  };

  const g = defineModule({ name: 'goals', path: '/goals', tag: 'Workforce', platform, authz, accessLog });
  g.route({
    method: 'get',
    path: '/',
    summary: 'List goals',
    description:
      'Filters: owner_type and owner_id, estate, parent goal, state, start / due dates. Everyone sees their own.',
    auth: { permission: 'goal.view' },
    list: {
      pagination: 'page',
      filters: {
        owner_type: { type: { enum: GOAL_OWNER_TYPES } },
        owner_id: { type: 'id', ops: ['eq'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        parent_goal_id: { type: 'id', ops: ['eq'] },
        state: { type: { enum: GOAL_STATES }, ops: ['eq', 'in'] },
        start_date: { type: 'date', ops: ['from', 'to'] },
        due_date: { type: 'date', ops: ['from', 'to'] },
      },
      sorts: ['due_date', 'start_date', 'goal_code'],
      defaultSort: ['due_date'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of goals', schema: GoalOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.goals.list(q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });
  g.route({
    method: 'get',
    path: '/overview',
    summary: 'Goals overview',
    description: 'Total, completed, in progress, delayed, overdue (P4 §12.4), plus drafts and cancelled.',
    auth: { permission: 'goal.view' },
    query: OverviewQuery,
    success: { status: 200, description: 'The figures', schema: OverviewOut },
    errors: [],
    handler: async (_req, res) => {
      const { query } = getValidated(res, { query: OverviewQuery });
      sendOne(res, await svc.goals.overview(query));
    },
  });
  g.route({
    method: 'get',
    path: '/calendar',
    summary: 'Goals calendar',
    description: 'Start, review and due dates of the goals between from and to.',
    auth: { permission: 'goal.view' },
    query: CalendarQuery,
    success: { status: 200, description: 'The events', schema: CalendarOut },
    errors: [],
    handler: async (req, res) => {
      const { query } = getValidated(res, { query: CalendarQuery });
      all(req, res, await svc.goals.calendar(query));
    },
  });
  g.route({
    method: 'post',
    path: '/',
    summary: 'Set a goal',
    description:
      'For a profile (owner_type employment_profile), a department (with estate_id) or an estate; numbered GL-…; parent_goal_id links ' +
      'it to a departmental or estate objective. A draft: submit it for approval.',
    auth: { permission: 'goal.create' },
    body: CreateGoalBody,
    success: { status: 201, description: 'Set', schema: GoalOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateGoalBody });
      const x = await svc.goals.create(body, currentActorId());
      sendCreated(res, x, `/api/v1/goals/${x.id}`, x.version);
    },
  });
  g.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a goal',
    auth: { permission: 'goal.view' },
    ...byId,
    success: { status: 200, description: 'The goal', schema: GoalOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.goals.get(params.id);
      sendOne(res, x, { version: x.version });
    },
  });
  g.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a draft goal',
    auth: { permission: 'goal.edit' },
    ...byId,
    body: PatchGoalBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: GoalOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchGoalBody });
      const x = await svc.goals.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  g.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft goal',
    auth: { permission: 'goal.delete' },
    ...byId,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await svc.goals.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  for (const [action, summary, description, permission] of [
    [
      'submit',
      'Submit a goal for approval',
      'Routed through the goal workflow; approved, it becomes active.',
      'goal.submit',
    ],
    ['complete', 'Complete a goal', 'An active goal (in progress, delayed or overdue too).', 'goal.edit'],
  ] as const) {
    g.route({
      method: 'post',
      path: `/:id/${action}`,
      summary,
      description,
      auth: { permission },
      ...byId,
      ifMatch: true,
      success: { status: 200, description: 'Done', schema: GoalOut },
      errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const v = requireIfMatch(req);
        const x =
          action === 'submit'
            ? await svc.goals.submit(params.id, v, currentActorId())
            : await svc.goals.complete(params.id, v, currentActorId());
        sendOne(res, x, { version: x.version });
      },
    });
  }
  g.route({
    method: 'post',
    path: '/:id/cancel',
    summary: 'Cancel a goal',
    auth: { permission: 'goal.edit' },
    ...byId,
    body: CancelGoalBody,
    ifMatch: true,
    success: { status: 200, description: 'Cancelled', schema: GoalOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CancelGoalBody });
      const x = await svc.goals.cancel(params.id, requireIfMatch(req), body.reason, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  g.route({
    method: 'get',
    path: '/:id/progress',
    summary: 'A goal’s progress history',
    auth: { permission: 'goal.view' },
    ...byId,
    success: { status: 200, description: 'The progress updates', schema: ProgressOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      all(req, res, await svc.goals.progressOf(params.id));
    },
  });
  g.route({
    method: 'post',
    path: '/:id/progress',
    summary: 'Record progress',
    description:
      'The value on a date (the percentage is value ÷ target for a goal with a target) or the percentage. The goal becomes in_progress, ' +
      'or delayed / overdue when it trails its dates (computed, never keyed).',
    auth: { permission: 'goal.edit' },
    ...byId,
    body: ProgressBody,
    success: { status: 200, description: 'Recorded: the goal as it now stands', schema: GoalOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: ProgressBody });
      const { goal } = await svc.goals.progress(params.id, body, currentActorId());
      sendOne(res, goal, { version: goal.version });
    },
  });

  const e = defineModule({
    name: 'evaluations',
    path: '/evaluations',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });
  e.route({
    method: 'get',
    path: '/',
    summary: 'List evaluations',
    description:
      'Filters: profile, reviewer, estate, type, state, period end. Everyone sees their own; historical evaluations stay in full.',
    auth: { permission: 'evaluation.view' },
    list: {
      pagination: 'page',
      filters: {
        employment_profile_id: { type: 'id', ops: ['eq', 'in'] },
        reviewer_profile_id: { type: 'id', ops: ['eq'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        evaluation_type: { type: { enum: EVALUATION_TYPES } },
        state: { type: { enum: EVALUATION_STATES }, ops: ['eq', 'in'] },
        period_end: { type: 'date', ops: ['from', 'to'] },
      },
      sorts: ['period_end', 'evaluation_number'],
      defaultSort: ['-period_end'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of evaluations', schema: EvaluationOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.evaluations.list(q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });
  e.route({
    method: 'post',
    path: '/',
    summary: 'Start an evaluation',
    description:
      'A draft for a profile and period (numbered EV-…), optionally with its lines: score each criterion, then submit.',
    auth: { permission: 'evaluation.create' },
    body: CreateEvaluationBody,
    success: { status: 201, description: 'Started', schema: EvaluationOut },
    errors: ['SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateEvaluationBody });
      const x = await svc.evaluations.create(body, currentActorId());
      sendCreated(res, x, `/api/v1/evaluations/${x.id}`, x.version);
    },
  });
  e.route({
    method: 'get',
    path: '/:id',
    summary: 'Get an evaluation',
    auth: { permission: 'evaluation.view' },
    ...byId,
    success: { status: 200, description: 'The evaluation', schema: EvaluationOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.evaluations.get(params.id);
      sendOne(res, x, { version: x.version });
    },
  });
  e.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a draft evaluation',
    description: 'Drafts only; an acknowledged evaluation is locked for good (409).',
    auth: { permission: 'evaluation.edit' },
    ...byId,
    body: PatchEvaluationBody,
    ifMatch: true,
    success: { status: 200, description: 'Changed', schema: EvaluationOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchEvaluationBody });
      const x = await svc.evaluations.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  e.route({
    method: 'put',
    path: '/:id/lines',
    summary: 'Score the criteria',
    description:
      'Replaces the lines (one per criterion; score 0 … max_score; weight default 1; a goal of the profile for a goal-linked one) and recomputes the overall score and rating.',
    auth: { permission: 'evaluation.edit' },
    ...byId,
    body: LinesBody,
    ifMatch: true,
    success: { status: 200, description: 'Scored', schema: EvaluationOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: LinesBody });
      const x = await svc.evaluations.setLines(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  e.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit an evaluation for approval',
    description: 'Every criterion scored.',
    auth: { permission: 'evaluation.submit' },
    ...byId,
    ifMatch: true,
    success: { status: 200, description: 'Submitted', schema: EvaluationOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED', 'RULE_AMBIGUOUS'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const x = await svc.evaluations.submit(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, x, { version: x.version });
    },
  });
  e.route({
    method: 'post',
    path: '/:id/acknowledge',
    summary: 'Acknowledge an evaluation',
    description:
      'By the evaluated employee (the account linked to the profile), with an optional comment: locks the record for good (P4 §12.4).',
    auth: { permission: 'evaluation.view' },
    ...byId,
    body: AcknowledgeBody,
    ifMatch: true,
    success: { status: 200, description: 'Acknowledged', schema: EvaluationOut },
    errors: ['INVALID_TRANSITION'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: AcknowledgeBody });
      const x = await svc.evaluations.acknowledge(
        params.id,
        requireIfMatch(req),
        body.employee_comment ?? null,
        currentActorId(),
      );
      sendOne(res, x, { version: x.version });
    },
  });
  return [g.build(), e.build()];
}

function assignmentsModule({ db, platform, authz, accessLog, config }: WorkforceDeps): ApiModule {
  const svc = assignmentService({ db, accessLog, timezone: config.timezone });
  registerApprovalAdapter(svc.adapter);
  const byAssignment = { params: AssignmentParams };
  const m = defineModule({
    name: 'employment-assignments',
    path: '/employment-assignments',
    tag: 'Workforce',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List employment assignments',
    description:
      'Across profiles, in your scope: e.g. filter[state]=submitted for the changes awaiting approval, or ' +
      'filter[section_id]=… for who was placed in a section. Each row names its profile.',
    auth: { permission: 'employment.view' },
    list: {
      pagination: 'page',
      filters: {
        employment_profile_id: { type: 'id', ops: ['eq', 'in'] },
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        department_id: { type: 'id', ops: ['eq', 'in'] },
        designation_id: { type: 'id', ops: ['eq', 'in'] },
        division_id: { type: 'id', ops: ['eq', 'in'] },
        section_id: { type: 'id', ops: ['eq', 'in'] },
        activity_type_id: { type: 'id', ops: ['eq', 'in'] },
        state: { type: { enum: ASSIGNMENT_STATES }, ops: ['eq', 'in'] },
        change_reason: { type: { enum: CHANGE_REASONS }, ops: ['eq', 'in'] },
        wage_basis: { type: { enum: WAGE_BASES }, ops: ['eq', 'in'] },
        is_wage_change: { type: 'bool' },
        effective_from: { type: 'date', ops: ['from', 'to'] },
      },
      sorts: ['effective_from', 'created_at'],
      defaultSort: ['-effective_from'],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of assignments', schema: AssignmentOut },
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
    path: '/:id',
    summary: 'Get an employment assignment',
    auth: { permission: 'employment.view' },
    ...byAssignment,
    success: { status: 200, description: 'The assignment', schema: AssignmentOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byAssignment);
      const a = await svc.get(params.id);
      sendOne(res, a, { version: a.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceAssignmentBody, 'Replace a draft assignment'],
    ['patch', PatchAssignmentBody, 'Change some of a draft assignment'],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      description:
        'Drafts only (a returned one is a draft again). A submitted or approved assignment is never edited: ' +
        'the next change is a new assignment (409 INVALID_TRANSITION). pay_lines are replaced as a whole.',
      auth: { permission: 'employment.edit' },
      ...byAssignment,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Changed', schema: AssignmentOut },
      errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byAssignment, body: PatchAssignmentBody });
        const a = await svc.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, a, { version: a.version });
      },
    });
  }

  m.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a draft assignment',
    description: 'Drafts only. A submitted change is returned or rejected by its approver instead.',
    auth: { permission: 'employment.delete' },
    ...byAssignment,
    ifMatch: true,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byAssignment);
      await svc.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  m.route({
    method: 'post',
    path: '/:id/submit',
    summary: 'Submit an assignment',
    description:
      'A wage change (wage basis, base rate or salary lines differ from the assignment it follows; for the ' +
      'first one, any rate or salary line) is routed through the approval workflow of employment_assignment ' +
      '(P7 §9.6): the result is `submitted` with approval_id, decided with POST /approvals/{approval_id}/' +
      'approve|reject|return. Any other change is `approved` at once. On approval the assignment it follows ' +
      'is closed the day before it starts.',
    auth: { permission: 'employment.create' },
    ...byAssignment,
    ifMatch: true,
    success: { status: 200, description: 'Submitted', schema: AssignmentOut },
    errors: ['INVALID_TRANSITION', 'SCOPE_DENIED', 'RULE_AMBIGUOUS'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byAssignment);
      const a = await svc.submit(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, a, { version: a.version });
    },
  });

  return m.build();
}

export function workforceModules(deps: WorkforceDeps): ApiModule[] {
  setWorkforceScopeTimezone(deps.config.timezone);
  return [
    personsModule(deps),
    profilesModule(deps),
    assignmentsModule(deps),
    teamsModule(deps),
    ...contractorsModule(deps),
    ...leaveModules(deps),
    ...benefitModules(deps),
    trainingModule(deps),
    ...performanceModules(deps),
  ];
}
