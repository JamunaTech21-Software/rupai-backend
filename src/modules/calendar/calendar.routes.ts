import type { ApiModule } from '../../app.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendCreated, sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { appliedScope } from '../../core/scope/scope.js';
import './calendar.scope.js';
import {
  AccountingPeriodOut,
  CreateFiscalYearBody,
  CreateSeasonBody,
  FISCAL_YEAR_STATES,
  FiscalYearOut,
  IdParams,
  PatchFiscalYearBody,
  PatchSeasonBody,
  PERIOD_STATES,
  ReplaceFiscalYearBody,
  ReplaceSeasonBody,
  SEASON_STATES,
  SeasonOut,
} from './calendar.schema.js';
import { fiscalService } from './fiscal.service.js';
import { seasonsService } from './seasons.service.js';

/** HTTP surface of the calendars (Spec P4 §7.2). */

export interface CalendarDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
}

const PAGE = { pagination: 'page' } as const;
const byId = { params: IdParams };
const page = (q: ReturnType<typeof getListQuery>) => q.page ?? { page: 1, perPage: 25 };

function seasonsModule({ db, platform, authz, accessLog }: CalendarDeps): ApiModule {
  const seasons = seasonsService(db, accessLog);
  const m = defineModule({ name: 'seasons', path: '/seasons', tag: 'Calendars', platform, authz, accessLog });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List seasons',
    description:
      'Seasons of the estates in your scope, latest first. To find the season of a date: ' +
      'filter[start_date][to]=D and filter[end_date][from]=D.',
    auth: { permission: 'season.view' },
    list: {
      ...PAGE,
      filters: {
        estate_id: { type: 'id', ops: ['eq', 'in'] },
        state: { type: { enum: SEASON_STATES } },
        code: { type: 'string', ops: ['eq', 'like'] },
        start_date: { type: 'date', ops: ['from', 'to'] },
        end_date: { type: 'date', ops: ['from', 'to'] },
      },
      sorts: ['start_date', 'code'],
      defaultSort: ['-start_date'],
    },
    success: { status: 200, description: 'A page of seasons', schema: SeasonOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await seasons.list(q);
      sendPage(req, res, items, { pagination: page(q), total, appliedScope: await appliedScope() });
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Create a season',
    description: 'Planned. It may not overlap another season of the same estate, in any state.',
    auth: { permission: 'season.create' },
    body: CreateSeasonBody,
    success: { status: 201, description: 'Created', schema: SeasonOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateSeasonBody });
      const s = await seasons.create(body, currentActorId());
      sendCreated(res, s, `/api/v1/seasons/${s.id}`, s.version);
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a season',
    auth: { permission: 'season.view' },
    ...byId,
    success: { status: 200, description: 'The season', schema: SeasonOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const s = await seasons.get(params.id);
      sendOne(res, s, { version: s.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceSeasonBody, 'Replace a season’s details'],
    ['patch', PatchSeasonBody, 'Update some of a season’s details'],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      description: 'Planned: everything. Active: name and end_date only. Closed: nothing.',
      auth: { permission: 'season.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: SeasonOut },
      errors: ['DUPLICATE_KEY', 'INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: PatchSeasonBody });
        const s = await seasons.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, s, { version: s.version });
      },
    });
  }

  m.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a planned season',
    auth: { permission: 'season.delete' },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVALID_TRANSITION', 'REFERENCED_RECORD', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await seasons.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  for (const [path, summary, description, run] of [
    [
      '/:id/activate',
      'Activate a season',
      'planned → active.',
      (id: bigint, v: number, actor: bigint) => seasons.activate(id, v, actor),
    ],
    [
      '/:id/close',
      'Close a season',
      'active → closed. No further operational transactions dated within it; accounting is unaffected (P1 §14.3).',
      (id: bigint, v: number, actor: bigint) => seasons.close(id, v, actor),
    ],
  ] as const) {
    m.route({
      method: 'post',
      path,
      summary,
      description,
      auth: { permission: 'season.edit' },
      ...byId,
      ifMatch: true,
      idempotent: true,
      success: { status: 200, description: 'The season in its new state', schema: SeasonOut },
      errors: ['INVALID_TRANSITION', 'SCOPE_DENIED'],
      handler: async (req, res) => {
        const { params } = getValidated(res, byId);
        const s = await run(params.id, requireIfMatch(req), currentActorId());
        sendOne(res, s, { version: s.version });
      },
    });
  }
  return m.build();
}

function fiscalModules({ db, platform, authz, accessLog }: CalendarDeps): ApiModule[] {
  const fiscal = fiscalService(db);
  const years = defineModule({
    name: 'fiscal-years',
    path: '/fiscal-years',
    tag: 'Calendars',
    platform,
    authz,
    accessLog,
  });

  years.route({
    method: 'get',
    path: '/',
    summary: 'List fiscal years',
    description: 'One calendar for the whole organisation (decision O-17): no estate parameter is accepted.',
    auth: { permission: 'fiscal_year.view' },
    list: {
      ...PAGE,
      filters: {
        state: { type: { enum: FISCAL_YEAR_STATES } },
        code: { type: 'string', ops: ['eq', 'like'] },
      },
      sorts: ['start_date', 'code'],
      defaultSort: ['-start_date'],
    },
    success: { status: 200, description: 'A page of fiscal years', schema: FiscalYearOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await fiscal.fiscalYears.list(q);
      sendPage(req, res, items, { pagination: page(q), total });
    },
  });

  years.route({
    method: 'post',
    path: '/',
    summary: 'Create a fiscal year',
    description:
      'Name the calendar year it starts in; the dates follow from the organisation’s fiscal_year_start_month. ' +
      'Fiscal years may not overlap. Then generate its periods.',
    auth: { permission: 'fiscal_year.create' },
    body: CreateFiscalYearBody,
    success: { status: 201, description: 'Created', schema: FiscalYearOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateFiscalYearBody });
      const y = await fiscal.fiscalYears.create(body, currentActorId());
      sendCreated(res, y, `/api/v1/fiscal-years/${y.id}`, y.version);
    },
  });

  years.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a fiscal year',
    auth: { permission: 'fiscal_year.view' },
    ...byId,
    success: { status: 200, description: 'The fiscal year', schema: FiscalYearOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const y = await fiscal.fiscalYears.get(params.id);
      sendOne(res, y, { version: y.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceFiscalYearBody, 'Replace a fiscal year’s code and name'],
    ['patch', PatchFiscalYearBody, 'Update a fiscal year’s code or name'],
  ] as const) {
    years.route({
      method,
      path: '/:id',
      summary,
      description: 'The dates are derived and never edited.',
      auth: { permission: 'fiscal_year.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: FiscalYearOut },
      errors: ['DUPLICATE_KEY'],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: PatchFiscalYearBody });
        const y = await fiscal.fiscalYears.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, y, { version: y.version });
      },
    });
  }

  years.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a fiscal year nothing has happened in',
    description: 'Only while it and all its periods are still future. Its periods are deleted with it.',
    auth: { permission: 'fiscal_year.delete' },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: ['INVARIANT_VIOLATED', 'REFERENCED_RECORD'],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await fiscal.fiscalYears.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  years.route({
    method: 'post',
    path: '/:id/generate-periods',
    summary: 'Generate the periods of a fiscal year',
    description:
      'Creates 12 contiguous monthly periods and period 13 (year-end adjustments: the last day of the year), ' +
      'all future. Once per fiscal year.',
    auth: { permission: 'fiscal_year.create' },
    ...byId,
    idempotent: true,
    success: { status: 200, description: 'The 13 periods', schema: AccountingPeriodOut },
    errors: ['INVARIANT_VIOLATED'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await fiscal.fiscalYears.generatePeriods(params.id, currentActorId());
      sendPage(req, res, items, { pagination: { page: 1, perPage: items.length }, total: items.length });
    },
  });

  const periods = defineModule({
    name: 'accounting-periods',
    path: '/accounting-periods',
    tag: 'Calendars',
    platform,
    authz,
    accessLog,
  });

  periods.route({
    method: 'get',
    path: '/',
    summary: 'List accounting periods',
    description:
      'In date order. To find the period of a date: filter[start_date][to]=D, filter[end_date][from]=D and ' +
      'filter[period_number][to]=12 (period 13 shares the last day of the year).',
    auth: { permission: 'accounting_period.view' },
    list: {
      ...PAGE,
      filters: {
        fiscal_year_id: { type: 'id', ops: ['eq', 'in'] },
        state: { type: { enum: PERIOD_STATES } },
        period_number: { type: 'int', ops: ['eq', 'from', 'to'] },
        start_date: { type: 'date', ops: ['from', 'to'] },
        end_date: { type: 'date', ops: ['from', 'to'] },
      },
      sorts: ['start_date', 'period_number'],
      defaultSort: ['start_date'],
    },
    success: { status: 200, description: 'A page of periods', schema: AccountingPeriodOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await fiscal.periods.list(q);
      sendPage(req, res, items, { pagination: page(q), total });
    },
  });

  periods.route({
    method: 'get',
    path: '/:id',
    summary: 'Get an accounting period',
    auth: { permission: 'accounting_period.view' },
    ...byId,
    success: { status: 200, description: 'The period', schema: AccountingPeriodOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const p = await fiscal.periods.get(params.id);
      sendOne(res, p, { version: p.version });
    },
  });

  periods.route({
    method: 'post',
    path: '/:id/open',
    summary: 'Open an accounting period',
    description:
      'future → open, in order: earlier periods of the year must be opened first. Opening the first period ' +
      'opens the fiscal year. Close and reopen arrive with period close (P10.02).',
    auth: { permission: 'accounting_period.edit' },
    ...byId,
    ifMatch: true,
    idempotent: true,
    success: { status: 200, description: 'The open period', schema: AccountingPeriodOut },
    errors: ['INVALID_TRANSITION', 'INVARIANT_VIOLATED'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const p = await fiscal.periods.open(params.id, requireIfMatch(req), currentActorId());
      sendOne(res, p, { version: p.version });
    },
  });

  return [years.build(), periods.build()];
}

export function calendarModules(deps: CalendarDeps): ApiModule[] {
  return [seasonsModule(deps), ...fiscalModules(deps)];
}
