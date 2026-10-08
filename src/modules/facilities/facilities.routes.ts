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
import { contactsService, type ContactsService } from './contacts.service.js';
import './facilities.scope.js';
import {
  ContactOut,
  ContactParams,
  CreateContactBody,
  CreateFactoryBody,
  CreatePartyBody,
  CreateWarehouseBody,
  FACTORY_TYPES,
  FactoryOut,
  IdParams,
  PARTY_TYPES,
  PartyOut,
  PatchContactBody,
  PatchFactoryBody,
  PatchPartyBody,
  PatchWarehouseBody,
  ReplaceContactBody,
  ReplaceFactoryBody,
  ReplacePartyBody,
  ReplaceWarehouseBody,
  STATUSES,
  WAREHOUSE_TYPES,
  WarehouseOut,
} from './facilities.schema.js';
import { facilitiesService } from './facilities.service.js';

/** HTTP surface of factories, warehouses, parties and their contacts (Spec P4 §7.1). */

export interface FacilitiesDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
}

type Builder = ReturnType<typeof defineModule>;
const PAGE = { pagination: 'page' } as const;
const byId = { params: IdParams };
const byContact = { params: ContactParams };
const page = (q: ReturnType<typeof getListQuery>) => q.page ?? { page: 1, perPage: 25 };

const masterList = (extra: Record<string, unknown>) =>
  ({
    ...PAGE,
    filters: {
      status: { type: { enum: STATUSES } },
      code: { type: 'string', ops: ['eq', 'like'] },
      name: { type: 'string', ops: ['like'] },
      ...extra,
    },
    sorts: ['code', 'name'],
    defaultSort: ['code'],
  }) as const;

/**
 * The contacts sub-resource of an owner, declared once (P3 §6.2): list, add, read, edit, remove,
 * make-primary. Permission follows the owner: {module}.view to read, {module}.edit to change.
 */
function contactRoutes(m: Builder, contacts: ContactsService, ownerLabel: string, basePath: string): void {
  const { module } = contacts.owner;

  m.route({
    method: 'get',
    path: '/:id/contacts',
    summary: `List a ${ownerLabel}’s contacts`,
    description: 'The primary contact first.',
    auth: { permission: `${module}.view` },
    ...byId,
    success: { status: 200, description: 'The contacts', schema: ContactOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      const items = await contacts.list(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/contacts',
    summary: `Add a contact to a ${ownerLabel}`,
    description: 'The first contact becomes the primary one; is_primary: true makes a later one primary.',
    auth: { permission: `${module}.edit` },
    ...byId,
    body: CreateContactBody,
    success: { status: 201, description: 'Created', schema: ContactOut },
    errors: [],
    handler: async (_req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: CreateContactBody });
      const c = await contacts.create(params.id, body, currentActorId());
      sendCreated(res, c, `/api/v1${basePath}/${params.id.toString()}/contacts/${c.id}`, c.version);
    },
  });

  m.route({
    method: 'get',
    path: '/:id/contacts/:contactId',
    summary: 'Get a contact',
    auth: { permission: `${module}.view` },
    ...byContact,
    success: { status: 200, description: 'The contact', schema: ContactOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byContact);
      const c = await contacts.get(params.id, params.contactId);
      sendOne(res, c, { version: c.version });
    },
  });

  for (const [method, body, summary] of [
    ['put', ReplaceContactBody, 'Replace a contact'],
    ['patch', PatchContactBody, 'Update some of a contact'],
  ] as const) {
    m.route({
      method,
      path: '/:id/contacts/:contactId',
      summary,
      description: 'is_primary is changed with /make-primary.',
      auth: { permission: `${module}.edit` },
      ...byContact,
      body,
      ifMatch: true,
      success: { status: 200, description: 'Updated', schema: ContactOut },
      errors: [],
      handler: async (req, res) => {
        const { params, body: changes } = getValidated(res, { ...byContact, body: PatchContactBody });
        const c = await contacts.update(
          params.id,
          params.contactId,
          requireIfMatch(req),
          changes,
          currentActorId(),
        );
        sendOne(res, c, { version: c.version });
      },
    });
  }

  m.route({
    method: 'post',
    path: '/:id/contacts/:contactId/make-primary',
    summary: 'Make a contact the primary one',
    description: 'The previous primary contact stops being primary in the same transaction.',
    auth: { permission: `${module}.edit` },
    ...byContact,
    ifMatch: true,
    idempotent: true,
    success: { status: 200, description: 'The new primary contact', schema: ContactOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byContact);
      const c = await contacts.makePrimary(
        params.id,
        params.contactId,
        requireIfMatch(req),
        currentActorId(),
      );
      sendOne(res, c, { version: c.version });
    },
  });

  m.route({
    method: 'delete',
    path: '/:id/contacts/:contactId',
    summary: 'Remove a contact',
    description: 'Removing the primary contact leaves none until another is made primary.',
    auth: { permission: `${module}.edit` },
    ...byContact,
    success: { status: 204, description: 'Removed' },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byContact);
      await contacts.remove(params.id, params.contactId, currentActorId());
      sendNoContent(res);
    },
  });
}

export function facilitiesModules({ db, platform, authz, accessLog }: FacilitiesDeps): ApiModule[] {
  const svc = facilitiesService(db);

  // ---- /factories ------------------------------------------------------------------------------
  const factories = defineModule({
    name: 'factories',
    path: '/factories',
    tag: 'Facilities',
    platform,
    authz,
    accessLog,
  });
  factories.route({
    method: 'get',
    path: '/',
    summary: 'List factories',
    description:
      'Factories in your scope: a factory grant, or all estates. Filter licence_expiry[to] for expiring licences.',
    auth: { permission: 'factory.view' },
    list: masterList({
      factory_type: { type: { enum: FACTORY_TYPES } },
      licence_expiry: { type: 'date', ops: ['from', 'to'] },
    }),
    success: { status: 200, description: 'A page of factories', schema: FactoryOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.factories.list(q);
      sendPage(req, res, items, { pagination: page(q), total, appliedScope: await appliedScope() });
    },
  });
  factories.route({
    method: 'post',
    path: '/',
    summary: 'Create a factory',
    description: 'Needs access to all estates. primary_estate_id is informational only.',
    auth: { permission: 'factory.create' },
    body: CreateFactoryBody,
    success: { status: 201, description: 'Created', schema: FactoryOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateFactoryBody });
      const f = await svc.factories.create(body, currentActorId());
      sendCreated(res, f, `/api/v1/factories/${f.id}`, f.version);
    },
  });
  masterItemRoutes(factories, {
    module: 'factory',
    label: 'factory',
    out: FactoryOut,
    replace: ReplaceFactoryBody,
    patch: PatchFactoryBody,
    svc: svc.factories,
    deleteHelp: 'Only a factory nothing refers to and no scope grant names. Otherwise deactivate it.',
  });

  // ---- /warehouses -----------------------------------------------------------------------------
  const warehouses = defineModule({
    name: 'warehouses',
    path: '/warehouses',
    tag: 'Facilities',
    platform,
    authz,
    accessLog,
  });
  warehouses.route({
    method: 'get',
    path: '/',
    summary: 'List warehouses',
    description: 'Warehouses in your scope: a warehouse grant, or all estates.',
    auth: { permission: 'warehouse.view' },
    list: masterList({
      warehouse_type: { type: { enum: WAREHOUSE_TYPES } },
      licence_expiry: { type: 'date', ops: ['from', 'to'] },
    }),
    success: { status: 200, description: 'A page of warehouses', schema: WarehouseOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.warehouses.list(q);
      sendPage(req, res, items, { pagination: page(q), total, appliedScope: await appliedScope() });
    },
  });
  warehouses.route({
    method: 'post',
    path: '/',
    summary: 'Create a warehouse',
    description: 'Needs access to all estates. The phone comes from the primary contact.',
    auth: { permission: 'warehouse.create' },
    body: CreateWarehouseBody,
    success: { status: 201, description: 'Created', schema: WarehouseOut },
    errors: ['DUPLICATE_KEY', 'SCOPE_DENIED'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateWarehouseBody });
      const w = await svc.warehouses.create(body, currentActorId());
      sendCreated(res, w, `/api/v1/warehouses/${w.id}`, w.version);
    },
  });
  masterItemRoutes(warehouses, {
    module: 'warehouse',
    label: 'warehouse',
    out: WarehouseOut,
    replace: ReplaceWarehouseBody,
    patch: PatchWarehouseBody,
    svc: svc.warehouses,
    deleteHelp: 'Only a warehouse nothing refers to and no scope grant names; its contacts go with it.',
  });
  contactRoutes(warehouses, contactsService(db, svc.owners.warehouse), 'warehouse', '/warehouses');

  // ---- /parties --------------------------------------------------------------------------------
  const parties = defineModule({
    name: 'parties',
    path: '/parties',
    tag: 'Parties',
    platform,
    authz,
    accessLog,
  });
  parties.route({
    method: 'get',
    path: '/',
    summary: 'List parties',
    description: 'Lessees and external land-allocation recipients (P3 §6.1). Organisation-wide.',
    auth: { permission: 'land.view' },
    list: masterList({
      party_type: { type: { enum: PARTY_TYPES } },
      district: { type: 'string', ops: ['eq', 'like'] },
    }),
    success: { status: 200, description: 'A page of parties', schema: PartyOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.parties.list(q);
      sendPage(req, res, items, { pagination: page(q), total });
    },
  });
  parties.route({
    method: 'post',
    path: '/',
    summary: 'Create a party',
    auth: { permission: 'land.create' },
    body: CreatePartyBody,
    success: { status: 201, description: 'Created', schema: PartyOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreatePartyBody });
      const p = await svc.parties.create(body, currentActorId());
      sendCreated(res, p, `/api/v1/parties/${p.id}`, p.version);
    },
  });
  masterItemRoutes(parties, {
    module: 'land',
    label: 'party',
    out: PartyOut,
    replace: ReplacePartyBody,
    patch: PatchPartyBody,
    svc: svc.parties,
    deleteHelp: 'Only a party nothing refers to (leases and allocations will); its contacts go with it.',
  });
  contactRoutes(parties, contactsService(db, svc.owners.party), 'party', '/parties');

  return [factories.build(), warehouses.build(), parties.build()];
}
