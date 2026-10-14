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
import { settingsCipher } from '../../core/settings/settings.js';
import {
  CreateSettingBody,
  IdParams,
  NumberFormatOut,
  NumberPreviewOut,
  NumberSequenceOut,
  PatchNumberFormatBody,
  PatchSettingBody,
  PreviewQuery,
  ReplaceNumberFormatBody,
  ReplaceSettingBody,
  SettingOut,
} from './system.schema.js';
import { numberFormatsService, settingsService } from './system.service.js';

/** HTTP surface of /number-formats and /settings (Spec P4 §14: system.*). */

export interface SystemDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly config: {
    readonly timezone: string;
    readonly settings: { readonly encryptionKey: string | null };
  };
}

const byId = { params: IdParams };
const page = (q: ReturnType<typeof getListQuery>) => q.page ?? { page: 1, perPage: 25 };

function numberFormatsModule({ db, platform, authz, accessLog, config }: SystemDeps): ApiModule {
  const formats = numberFormatsService(db, config.timezone);
  const m = defineModule({
    name: 'number-formats',
    path: '/number-formats',
    tag: 'System',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List number formats',
    description:
      'One per document type. The set is the system’s; the format of each is yours to edit. Financial ' +
      'documents are gapless: their numbers are allocated at posting.',
    auth: { permission: 'system.view' },
    list: {
      pagination: 'page',
      filters: {
        document_type: { type: 'string', ops: ['eq', 'in'] },
        is_gapless: { type: 'bool' },
      },
      sorts: ['document_type'],
      defaultSort: ['document_type'],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of number formats', schema: NumberFormatOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await formats.list(q);
      sendPage(req, res, items, { pagination: page(q), total });
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a number format',
    auth: { permission: 'system.view' },
    ...byId,
    success: { status: 200, description: 'The number format', schema: NumberFormatOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const f = await formats.get(params.id);
      sendOne(res, f, { version: f.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceNumberFormatBody, 'Replace a number format'],
    ['patch', PatchNumberFormatBody, 'Update some of a number format'],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      description:
        'Applies to numbers allocated from now on. A component the document does not have cannot be switched ' +
        'on; document_type and is_gapless are not editable.',
      auth: { permission: 'system.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: NumberFormatOut },
      errors: [],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: PatchNumberFormatBody });
        const f = await formats.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, f, { version: f.version });
      },
    });
  }

  m.route({
    method: 'get',
    path: '/:id/preview',
    summary: 'Preview the next number',
    description:
      'The number the next document in a scope would get. Nothing is allocated. Give the estate, fiscal year ' +
      'and season codes the format includes; sample codes are used for any you omit.',
    auth: { permission: 'system.view' },
    ...byId,
    query: PreviewQuery,
    success: { status: 200, description: 'The next number', schema: NumberPreviewOut },
    errors: [],
    handler: async (_req, res) => {
      const { params, query } = getValidated(res, { ...byId, query: PreviewQuery });
      sendOne(res, await formats.preview(params.id, query));
    },
  });

  m.route({
    method: 'get',
    path: '/:id/sequences',
    summary: 'The counters of a number format',
    description:
      'The last number allocated in each scope. Read-only: a counter only moves by allocating a number.',
    auth: { permission: 'system.view' },
    ...byId,
    success: { status: 200, description: 'The counters', schema: NumberSequenceOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await formats.sequences(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });
  return m.build();
}

function settingsModule({ db, platform, authz, accessLog, config }: SystemDeps): ApiModule {
  const settings = settingsService(db, settingsCipher(config.settings.encryptionKey));
  const m = defineModule({ name: 'settings', path: '/settings', tag: 'System', platform, authz, accessLog });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List system settings',
    description: 'Grouped by `group`. An encrypted setting shows value null and has_value: it is write-only.',
    auth: { permission: 'system.view' },
    list: {
      pagination: 'page',
      filters: {
        key: { type: 'string', ops: ['eq', 'in', 'like'] },
        group: { type: 'string', ops: ['eq', 'in'] },
        is_encrypted: { type: 'bool' },
      },
      sorts: ['key', 'group'],
      defaultSort: ['group', 'key'],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of settings', schema: SettingOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await settings.list(q);
      sendPage(req, res, items, { pagination: page(q), total });
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Create a setting',
    description:
      'key (dotted, lower case), value_type and is_encrypted are fixed at creation. The value must fit the ' +
      'type: a decimal is a string ("12.50"), an integer a number.',
    auth: { permission: 'system.create' },
    body: CreateSettingBody,
    success: { status: 201, description: 'Created', schema: SettingOut },
    errors: ['DUPLICATE_KEY', 'INVARIANT_VIOLATED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateSettingBody });
      const s = await settings.create(body, currentActorId());
      sendCreated(res, s, `/api/v1/settings/${s.id}`, s.version);
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a setting',
    auth: { permission: 'system.view' },
    ...byId,
    success: { status: 200, description: 'The setting', schema: SettingOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const s = await settings.get(params.id);
      sendOne(res, s, { version: s.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceSettingBody, 'Replace a setting’s value, group and description'],
    ['patch', PatchSettingBody, 'Update a setting’s value, group or description'],
  ] as const) {
    m.route({
      method,
      path: '/:id',
      summary,
      description:
        'value: null clears it. For an encrypted setting the new value is stored and never shown again.',
      auth: { permission: 'system.edit' },
      ...byId,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: SettingOut },
      errors: ['INVARIANT_VIOLATED'],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byId, body: PatchSettingBody });
        const s = await settings.update(params.id, requireIfMatch(req), changes, currentActorId());
        sendOne(res, s, { version: s.version });
      },
    });
  }

  m.route({
    method: 'delete',
    path: '/:id',
    summary: 'Delete a setting',
    auth: { permission: 'system.delete' },
    ...byId,
    success: { status: 204, description: 'Deleted' },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      await settings.remove(params.id, currentActorId());
      sendNoContent(res);
    },
  });
  return m.build();
}

export function systemModules(deps: SystemDeps): ApiModule[] {
  return [numberFormatsModule(deps), settingsModule(deps)];
}
