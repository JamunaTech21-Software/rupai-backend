import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendCreated, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { appliedScope } from '../../core/scope/scope.js';
import { fieldsService } from './fields.service.js';
import { hierarchyService } from './hierarchy.service.js';
import './organisation.scope.js';
import {
  BoundaryBody,
  EstateMapOut,
  FieldBoundaryOut,
  SectionBoundaryOut,
  CreateDivisionBody,
  CreateEstateBody,
  CreateFieldBody,
  CreateSectionBody,
  DivisionOut,
  EstateOut,
  EstateSummaryOut,
  FIELD_STATUSES,
  FIELD_TYPES,
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
} from './organisation.schema.js';
import { organisationService } from './organisation.service.js';
import { masterItemRoutes as itemRoutes } from '../../core/http/master.js';

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

  m.route({
    method: 'get',
    path: '/:id/summary',
    summary: 'The estate overview',
    description:
      'The Estate Overview and the figures under the Division & Section and Field / Block lists. Each overview ' +
      'figure (tea and non-tea area, division, section, field, worker and family counts) is the value entered ' +
      'on the estate when there is one, otherwise computed from the records; `source` says which and ' +
      '`computed` always has the records’ figure. Tea area = planted area of active tea_field and extension ' +
      'fields still carrying tea; non-tea = total − tea, never below 0. `hierarchy` is always computed. ' +
      'Areas in acres. Workers and families come from HR (Phase 2).',
    auth: { permission: 'estate.view' },
    ...byId,
    success: { status: 200, description: 'The overview', schema: EstateSummaryOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await h.estateSummary(params.id));
    },
  });

  m.route({
    method: 'get',
    path: '/:id/map',
    summary: 'The estate map',
    description:
      'Every mapped field, road, drain and section outline of the estate you can see, as one GeoJSON ' +
      "FeatureCollection ([longitude, latitude], WGS 84) with the design legend's layer on each feature, " +
      'the bbox to fit, the estate position, and the fields not mapped yet.',
    auth: { permission: 'field.view' },
    ...byId,
    success: { status: 200, description: 'The map', schema: EstateMapOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await h.estateMap(params.id));
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

  m.route({
    method: 'get',
    path: '/:id/boundary',
    summary: 'A section’s outline',
    auth: { permission: 'section.view' },
    ...byId,
    success: { status: 200, description: 'The outline', schema: SectionBoundaryOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const b = await h.sectionBoundaries.get(params.id);
      sendOne(res, b, { version: b.version });
    },
  });

  m.route({
    method: 'put',
    path: '/:id/boundary',
    summary: 'Set a section’s outline',
    description:
      'Exactly one of boundary (GeoJSON Polygon, or null to clear), kml (a KML file’s text) or points (a GPS walk).',
    auth: { permission: 'section.edit' },
    ...byId,
    body: BoundaryBody,
    ifMatch: true,
    success: { status: 200, description: 'The outline', schema: SectionBoundaryOut },
    errors: ['SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: BoundaryBody });
      const b = await h.sectionBoundaries.set(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, b, { version: b.version });
    },
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List sections',
    description:
      'Only sections in your data scope. filter[estate_id] gives every section of an estate in one request ' +
      '(R.3); also by division and parent section.',
    auth: { permission: 'section.view' },
    list: {
      ...nodeList,
      filters: {
        ...nodeList.filters,
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        division_id: { type: 'id', ops: ['eq', 'in'] },
        parent_section_id: { type: 'id', ops: ['eq', 'in'] },
      },
      maxPageSize: 1000,
    },
    success: { status: 200, description: 'A page of sections', schema: SectionOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await h.sections.list(q);
      sendPage(req, res, items, {
        pagination: q.page ?? { page: 1, perPage: 25 },
        total,
        appliedScope: await appliedScope(),
      });
    },
  });

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
    description:
      'Only fields in your data scope. Filter by estate, division, section, field type, parent field and ' +
      'status; per_page up to 1000, so an estate’s fields come in one request.',
    auth: { permission: 'field.view' },
    list: {
      ...PAGE,
      filters: {
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        division_id: { type: 'id', ops: ['eq', 'in'] },
        section_id: { type: 'id', ops: ['eq', 'in'] },
        field_status: { type: { enum: FIELD_STATUSES } },
        field_type: { type: { enum: FIELD_TYPES }, ops: ['eq', 'in'] },
        parent_field_id: { type: 'id', ops: ['eq', 'in'] },
        status: { type: { enum: STATUSES } },
        field_number: { type: 'string', ops: ['eq', 'like'] },
        name: { type: 'string', ops: ['like'] },
      },
      sorts: ['field_number', 'gross_area', 'name'],
      defaultSort: ['field_number'],
      maxPageSize: 1000,
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
    method: 'get',
    path: '/:id/boundary',
    summary: 'A field’s boundary',
    description:
      'The shape (GeoJSON, [longitude, latitude]) and its figures: centroid, perimeter, mapped area.',
    auth: { permission: 'field.view' },
    ...byId,
    success: { status: 200, description: 'The boundary', schema: FieldBoundaryOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const b = await fields.getBoundary(params.id);
      sendOne(res, b, { version: b.version });
    },
  });

  m.route({
    method: 'put',
    path: '/:id/boundary',
    summary: 'Set a field’s boundary',
    description:
      'Exactly one of: boundary — a GeoJSON Polygon (a LineString for a road_reserve, road_side or drain ' +
      'field), or a Feature holding one, null to clear; kml — a KML file’s text (its first Polygon / ' +
      'LineString); points — a GPS walk [{latitude, longitude}, …]. Validated (closed, not crossing itself, ' +
      'inside Bangladesh) and measured by the server; boundary_warning when the mapped area differs from the ' +
      'gross area by more than 10 %.',
    auth: { permission: 'field.edit' },
    ...byId,
    body: BoundaryBody,
    ifMatch: true,
    success: { status: 200, description: 'The boundary', schema: FieldBoundaryOut },
    errors: ['SCOPE_DENIED'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: BoundaryBody });
      const b = await fields.setBoundary(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, b, { version: b.version });
    },
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
