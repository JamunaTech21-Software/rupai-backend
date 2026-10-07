import type { z } from 'zod';

import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import type { ErrorCode } from '../../core/errors/codes.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendCreated, sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { appliedScope } from '../../core/scope/scope.js';
import { fieldsService } from './fields.service.js';
import { hierarchyService } from './hierarchy.service.js';
import './organisation.scope.js';
import {
  CreateDivisionBody,
  CreateEstateBody,
  CreateFieldBody,
  CreateSectionBody,
  DivisionOut,
  EstateOut,
  FIELD_STATUSES,
  FieldOut,
  IdParams,
  OrganisationOut,
  PatchDivisionBody,
  PatchEstateBody,
  PatchFieldBody,
  PatchOrganisationBody,
  PatchSectionBody,
  ReassignSectionBody,
  ReplaceDivisionBody,
  ReplaceEstateBody,
  ReplaceFieldBody,
  ReplaceOrganisationBody,
  ReplaceSectionBody,
  SectionOut,
  STATUSES,
  type Status,
} from './organisation.schema.js';
import { organisationService } from './organisation.service.js';

/** HTTP surface of the organisation hierarchy (Spec P4 §7.1). */

export interface OrganisationDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly config: { readonly timezone: string };
}

const PAGE = { pagination: 'page' } as const;
const byId = { params: IdParams };

type Builder = ReturnType<typeof defineModule>;

interface ItemService<Out> {
  get(id: bigint): Promise<Out>;
  update(id: bigint, version: number, changes: never, actorId: bigint): Promise<Out>;
  setStatus(id: bigint, version: number, status: Status, actorId: bigint): Promise<Out>;
  remove(id: bigint, actorId: bigint): Promise<void>;
}

/** GET, PUT, PATCH, DELETE and deactivate/reactivate on /{resource}/:id: the P4 §6 master pattern. */
function itemRoutes<Out extends { version: number }>(
  m: Builder,
  o: {
    module: string;
    label: string;
    out: z.ZodType;
    replace: z.ZodType;
    patch: z.ZodType;
    svc: ItemService<Out>;
    updateErrors?: readonly ErrorCode[];
    deleteHelp: string;
  },
): void {
  m.route({
    method: 'get',
    path: '/:id',
    summary: `Get a ${o.label}`,
    auth: { permission: `${o.module}.view` },
    ...byId,
    success: { status: 200, description: `The ${o.label}`, schema: o.out },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const item = await o.svc.get(params.id);
      sendOne(res, item, { version: item.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', o.replace, `Replace a ${o.label}’s details`],
    ['patch', o.patch, `Update some of a ${o.label}’s details`],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      auth: { permission: `${o.module}.edit` },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: o.out },
      errors: ['DUPLICATE_KEY', 'SCOPE_DENIED', ...(o.updateErrors ?? [])],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: o.patch });
        const item = await o.svc.update(params.id, requireIfMatch(req), changes as never, currentActorId());
        sendOne(res, item, { version: item.version });
      },
    });
  }

  m.route({
    method: 'delete',
    path: '/:id',
    summary: `Delete a ${o.label} created in error`,
    description: o.deleteHelp,
    auth: { permission: `${o.module}.delete` },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['REFERENCED_RECORD', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await o.svc.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  for (const [path, status, summary] of [
    ['/:id/deactivate', 'inactive', `Deactivate a ${o.label}`],
    ['/:id/reactivate', 'active', `Reactivate a ${o.label}`],
  ] as const) {
    m.route({
      method: 'post',
      path,
      summary,
      description:
        status === 'inactive'
          ? 'It stays on every record that refers to it, and no new record can be created under it.'
          : 'Only under an active parent.',
      auth: { permission: `${o.module}.edit` },
      ...byId,
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: `The ${o.label} in its new status`, schema: o.out },
      errors: ['SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const item = await o.svc.setStatus(params.id, requireIfMatch(req), status, currentActorId());
        sendOne(res, item, { version: item.version });
      },
    });
  }
}

const nodeList = {
  ...PAGE,
  filters: {
    status: { type: { enum: STATUSES } },
    code: { type: 'string', ops: ['eq', 'like'] },
    name: { type: 'string', ops: ['like'] },
  },
  sorts: ['code', 'name'],
  defaultSort: ['code'],
} as const;

function organisationModule({ db, platform, authz, accessLog }: OrganisationDeps): ApiModule {
  const org = organisationService(db);
  const m = defineModule({
    name: 'organisation',
    path: '/organisation',
    tag: 'Organisation',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'Get the organisation',
    description: 'The single organisation of this deployment (no id in the path).',
    auth: { permission: 'organisation.view' },
    success: { status: 200, description: 'The organisation', schema: OrganisationOut },
    errors: [],
    handler: async (_req, res) => {
      const o = await org.get();
      sendOne(res, o, { version: o.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceOrganisationBody, 'Replace the organisation’s details'],
    ['patch', PatchOrganisationBody, 'Update some of the organisation’s details'],
  ] as const) {
    m.route({
      method,
      path: '/',
      summary,
      description:
        'Country and base currency are set once P1.10 provides them; the logo arrives with storage (P1.12).',
      auth: { permission: 'organisation.edit' },
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: OrganisationOut },
      errors: [],
      handler: async (req, res) => {
        const { body: changes } = getValidated(res, { body: PatchOrganisationBody });
        const o = await org.update(requireIfMatch(req), changes, currentActorId());
        sendOne(res, o, { version: o.version });
      },
    });
  }
  return m.build();
}

function estatesModule(deps: OrganisationDeps, h: ReturnType<typeof hierarchyService>): ApiModule {
  const { platform, authz, accessLog } = deps;
  const m = defineModule({ name: 'estates', path: '/estates', tag: 'Estates', platform, authz, accessLog });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List estates',
    description: 'Only estates in your data scope.',
    auth: { permission: 'estate.view' },
    list: {
      ...nodeList,
      filters: { ...nodeList.filters, district: { type: 'string', ops: ['eq', 'like'] } },
    },
    success: { status: 200, description: 'A page of estates', schema: EstateOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await h.estates.list(q);
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
    summary: 'Create an estate',
    description: 'Needs access to all estates. The code is unique within the organisation.',
    auth: { permission: 'estate.create' },
    body: CreateEstateBody,
    success: { status: 201, description: 'Created', schema: EstateOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateEstateBody });
      const e = await h.estates.create(body, currentActorId());
      sendCreated(res, e, `/api/v1/estates/${e.id}`, e.version);
    },
  });

  itemRoutes(m, {
    module: 'estate',
    label: 'estate',
    out: EstateOut,
    replace: ReplaceEstateBody,
    patch: PatchEstateBody,
    svc: h.estates,
    deleteHelp: 'Only an estate with no divisions, fields or scope grants. Otherwise deactivate it.',
  });

  m.route({
    method: 'get',
    path: '/:id/divisions',
    summary: 'List an estate’s divisions',
    auth: { permission: 'division.view' },
    ...byId,
    list: nodeList,
    success: { status: 200, description: 'A page of divisions', schema: DivisionOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const q = getListQuery(res);
      const { items, total } = await h.divisions.listFor(params.id, q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/divisions',
    summary: 'Create a division in an estate',
    description: 'The estate must be active. The code is unique within the estate.',
    auth: { permission: 'division.create' },
    ...byId,
    body: CreateDivisionBody,
    success: { status: 201, description: 'Created', schema: DivisionOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CreateDivisionBody });
      const d = await h.divisions.create(params.id, body, currentActorId());
      sendCreated(res, d, `/api/v1/divisions/${d.id}`, d.version);
    },
  });
  return m.build();
}

function divisionsModule(deps: OrganisationDeps, h: ReturnType<typeof hierarchyService>): ApiModule {
  const { platform, authz, accessLog } = deps;
  const m = defineModule({
    name: 'divisions',
    path: '/divisions',
    tag: 'Estates',
    platform,
    authz,
    accessLog,
  });

  itemRoutes(m, {
    module: 'division',
    label: 'division',
    out: DivisionOut,
    replace: ReplaceDivisionBody,
    patch: PatchDivisionBody,
    svc: h.divisions,
    deleteHelp: 'Only a division with no sections or scope grants. Otherwise deactivate it.',
  });

  m.route({
    method: 'get',
    path: '/:id/sections',
    summary: 'List a division’s sections',
    auth: { permission: 'section.view' },
    ...byId,
    list: nodeList,
    success: { status: 200, description: 'A page of sections', schema: SectionOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const q = getListQuery(res);
      const { items, total } = await h.sections.listFor(params.id, q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/sections',
    summary: 'Create a section in a division',
    description: 'The division must be active. The code is unique within the division.',
    auth: { permission: 'section.create' },
    ...byId,
    body: CreateSectionBody,
    success: { status: 201, description: 'Created', schema: SectionOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CreateSectionBody });
      const s = await h.sections.create(params.id, body, currentActorId());
      sendCreated(res, s, `/api/v1/sections/${s.id}`, s.version);
    },
  });
  return m.build();
}

function sectionsModule(deps: OrganisationDeps, h: ReturnType<typeof hierarchyService>): ApiModule {
  const { platform, authz, accessLog } = deps;
  const m = defineModule({ name: 'sections', path: '/sections', tag: 'Estates', platform, authz, accessLog });
  itemRoutes(m, {
    module: 'section',
    label: 'section',
    out: SectionOut,
    replace: ReplaceSectionBody,
    patch: PatchSectionBody,
    svc: h.sections,
    deleteHelp: 'Only a section with no fields or scope grants. Otherwise deactivate it.',
  });
  return m.build();
}

function fieldsModule(deps: OrganisationDeps): ApiModule {
  const { db, platform, authz, accessLog, config } = deps;
  const fields = fieldsService(db, accessLog, config.timezone);
  const m = defineModule({ name: 'fields', path: '/fields', tag: 'Fields', platform, authz, accessLog });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List fields',
    description: 'Only fields in your data scope. Filter by estate, division, section and field status.',
    auth: { permission: 'field.view' },
    list: {
      ...PAGE,
      filters: {
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        division_id: { type: 'id', ops: ['eq', 'in'] },
        section_id: { type: 'id', ops: ['eq', 'in'] },
        field_status: { type: { enum: FIELD_STATUSES } },
        status: { type: { enum: STATUSES } },
        field_number: { type: 'string', ops: ['eq', 'like'] },
      },
      sorts: ['field_number', 'gross_area'],
      defaultSort: ['field_number'],
    },
    success: { status: 200, description: 'A page of fields', schema: FieldOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await fields.list(q);
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
    summary: 'Create a field',
    description:
      'The section decides the estate (estate_id is never sent). planted_area may not exceed gross_area. ' +
      'The field number is unique within the estate.',
    auth: { permission: 'field.create' },
    body: CreateFieldBody,
    success: { status: 201, description: 'Created', schema: FieldOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateFieldBody });
      const f = await fields.create(body, currentActorId());
      sendCreated(res, f, `/api/v1/fields/${f.id}`, f.version);
    },
  });

  itemRoutes(m, {
    module: 'field',
    label: 'field',
    out: FieldOut,
    replace: ReplaceFieldBody,
    patch: PatchFieldBody,
    svc: fields,
    deleteHelp: 'Only a field nothing refers to yet. Otherwise deactivate it.',
  });

  m.route({
    method: 'post',
    path: '/:id/reassign-section',
    summary: 'Move a field to another section',
    description:
      'Effective-dated (P1 §5.1): production already recorded keeps the section it was recorded with. The ' +
      'new section must be in the same estate; the date may not be in the future or before the field ' +
      'joined its current section.',
    auth: { permission: 'field.edit' },
    ...byId,
    body: ReassignSectionBody,
    ifMatch: true,
    success: { status: 200, description: 'The field in its new section', schema: FieldOut },
    errors: ['SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: ReassignSectionBody });
      const f = await fields.reassignSection(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, f, { version: f.version });
    },
  });
  return m.build();
}

export function organisationModules(deps: OrganisationDeps): ApiModule[] {
  const h = hierarchyService(deps.db, deps.accessLog);
  return [
    organisationModule(deps),
    estatesModule(deps, h),
    divisionsModule(deps, h),
    sectionsModule(deps, h),
    fieldsModule(deps),
  ];
}
