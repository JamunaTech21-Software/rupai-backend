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
import { SEVERITIES, TRIGGER_TYPES } from '../../core/notify/triggers.js';
import {
  CreateRuleBody,
  IdParams,
  NotificationOut,
  PatchRuleBody,
  ReadAllBody,
  ReadAllOut,
  RuleOut,
  SummaryOut,
  TriggerOut,
} from './notifications.schema.js';
import { notificationsService, rulesService } from './notifications.service.js';

/** HTTP surface of /notifications (P4 §14: any user, their own) and /notification-rules (notification.*). */

export interface NotificationsDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
}

const byId = { params: IdParams };
const OWN = 'Everyone has their own notifications (P6 §5.4 baseline); nobody sees anyone else’s.';
const page = (q: ReturnType<typeof getListQuery>) => q.page ?? { page: 1, perPage: 25 };

function notificationsModule({ db, platform, authz, accessLog }: NotificationsDeps): ApiModule {
  const svc = notificationsService(db);
  const m = defineModule({
    name: 'notifications',
    path: '/notifications',
    tag: 'Notifications',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List my notifications',
    description:
      'Newest first. Dismissed ones are left out unless filter[is_dismissed]=true (the "dismissed" tab). ' +
      'filter[is_read]=false for the unread ones. Each links to what it is about (link.route).',
    auth: { signedIn: true, reason: OWN },
    list: {
      pagination: 'page',
      filters: {
        is_read: { type: 'bool' },
        is_dismissed: { type: 'bool' },
        severity: { type: { enum: SEVERITIES }, ops: ['eq', 'in'] },
        trigger_type: { type: { enum: TRIGGER_TYPES }, ops: ['eq', 'in'] },
      },
      sorts: [],
      maxPageSize: 100,
    },
    success: { status: 200, description: 'A page of notifications', schema: NotificationOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(currentActorId(), q);
      sendPage(req, res, items, { pagination: page(q), total });
    },
  });

  m.route({
    method: 'get',
    path: '/summary',
    summary: 'My unread count',
    description:
      'The number on the bell: unread and not dismissed, and how many of them are critical. Cheap: poll it ' +
      '(every 60 s is plenty) and refetch the list when latest_at changes.',
    auth: { signedIn: true, reason: OWN },
    success: { status: 200, description: 'The counts', schema: SummaryOut },
    errors: [],
    handler: async (_req, res) => {
      sendOne(res, await svc.summary(currentActorId()));
    },
  });

  m.route({
    method: 'post',
    path: '/read-all',
    summary: 'Mark all my notifications read',
    description: 'Give up_to_id (the newest one shown) so one that arrived meanwhile stays unread.',
    auth: { signedIn: true, reason: OWN },
    body: ReadAllBody,
    success: { status: 200, description: 'How many were marked', schema: ReadAllOut },
    errors: [],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: ReadAllBody });
      sendOne(res, await svc.readAll(currentActorId(), body.up_to_id));
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get one of my notifications',
    description: '404 for anyone else’s.',
    auth: { signedIn: true, reason: OWN },
    ...byId,
    success: { status: 200, description: 'The notification', schema: NotificationOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      sendOne(res, await svc.get(params.id, currentActorId()));
    },
  });

  for (const [action, summary, description] of [
    ['read', 'Mark read', 'Opening a notification marks it read. Again changes nothing.'],
    ['unread', 'Mark unread', 'Keeps it on the bell.'],
    [
      'dismiss',
      'Dismiss',
      'Moves it off the list (and marks it read). It stays under filter[is_dismissed]=true.',
    ],
    ['restore', 'Restore', 'Brings a dismissed notification back to the list.'],
  ] as const) {
    m.route({
      method: 'post',
      path: `/:id/${action}`,
      summary,
      description,
      auth: { signedIn: true, reason: OWN },
      ...byId,
      success: { status: 200, description: 'The notification', schema: NotificationOut },
      errors: [],
      handler: async (_req, res) => {
        const { params } = getValidated(res, byId);
        sendOne(res, await svc.mark(params.id, currentActorId(), action));
      },
    });
  }

  return m.build();
}

function rulesModule({ db, platform, authz, accessLog }: NotificationsDeps): ApiModule {
  const svc = rulesService(db);
  const m = defineModule({
    name: 'notification-rules',
    path: '/notification-rules',
    tag: 'Notifications',
    platform,
    authz,
    accessLog,
  });

  m.route({
    method: 'get',
    path: '/triggers',
    summary: 'What a rule can listen for',
    description:
      'The trigger types, with the recipient rules each allows and whether it uses lead_days. ' +
      'evaluated=false: its module does not exist yet, so its rules notify nobody until it does.',
    auth: { permission: 'notification.view' },
    success: { status: 200, description: 'The triggers', schema: TriggerOut },
    errors: [],
    handler: (req, res) => {
      const items = svc.triggers();
      sendPage(req, res, items, { pagination: { page: 1, perPage: items.length }, total: items.length });
    },
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List notification rules',
    auth: { permission: 'notification.view' },
    list: {
      pagination: 'page',
      filters: {
        trigger_type: { type: { enum: TRIGGER_TYPES }, ops: ['eq', 'in'] },
        is_active: { type: 'bool' },
      },
      sorts: [],
      maxPageSize: 100,
    },
    success: { status: 200, description: 'A page of rules', schema: RuleOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q);
      sendPage(req, res, items, { pagination: page(q), total });
    },
  });

  m.route({
    method: 'post',
    path: '/',
    summary: 'Add a notification rule',
    description:
      'Another rule for a trigger, e.g. document expiry 7 days ahead to a named user by email. ' +
      'recipient_rule must be one the trigger allows; by_role needs role_id, by_named_user needs user_id.',
    auth: { permission: 'notification.create' },
    body: CreateRuleBody,
    success: { status: 201, description: 'The rule', schema: RuleOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateRuleBody });
      const r = await svc.create(body, currentActorId());
      sendCreated(res, r, `/api/v1/notification-rules/${r.id}`, r.version);
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Get a notification rule',
    auth: { permission: 'notification.view' },
    ...byId,
    success: { status: 200, description: 'The rule', schema: RuleOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byId);
      const r = await svc.get(params.id);
      sendOne(res, r, { version: r.version });
    },
  });

  m.route({
    method: 'patch',
    path: '/:id',
    summary: 'Change a notification rule',
    description:
      'code and trigger_type are fixed. Deactivate (is_active=false) rather than delete: rules are never ' +
      'deleted. Applies from the next evaluation; notifications already sent are not changed.',
    auth: { permission: 'notification.edit' },
    ...byId,
    body: PatchRuleBody,
    ifMatch: true,
    success: { status: 200, description: 'The rule', schema: RuleOut },
    errors: [],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchRuleBody });
      const r = await svc.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, r, { version: r.version });
    },
  });

  return m.build();
}

export function notificationsModules(deps: NotificationsDeps): ApiModule[] {
  return [notificationsModule(deps), rulesModule(deps)];
}
