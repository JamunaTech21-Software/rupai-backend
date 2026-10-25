import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { Errors } from '../../core/errors/app-error.js';
import { getListQuery, type ListQuery } from '../../core/http/list-query.js';
import { masterItemRoutes } from '../../core/http/master.js';
import { sendCreated, sendCursorPage, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import {
  DIRECTIONS,
  LOCATION_TYPES,
  MATERIAL_CLASSES,
  MOVEMENT_TYPE_KEYS,
  OWNERSHIPS,
  STOCK_SOURCES,
  STOCK_STATES,
} from '../../core/stock/taxonomy.js';
import {
  BalanceOut,
  CreateMaterialBody,
  MATERIAL_CATEGORIES,
  MATERIAL_STATUSES,
  MaterialOut,
  MovementOut,
  PatchMaterialBody,
  ReplaceMaterialBody,
} from './inventory.schema.js';
import { inventoryService } from './inventory.service.js';

/**
 * HTTP surface of inventory (Spec P4 §10.3; BACKLOG P4.04): the raw materials master and the read side of the
 * stock ledger. There is no endpoint that writes a stock balance or a movement (P4 §10.3): stock changes only
 * through an approved document (goods receipt P4.05, material issue and stock adjustment P7, sale P8).
 */

export interface InventoryDeps {
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly config: Pick<Config, 'timezone'>;
}

/** Movements are a very-high-growth table: a bounded moved_at range, at most a year unless a source is named. */
const MAX_RANGE_DAYS = 366;
function assertRange(q: ListQuery): void {
  if (q.filters.some((f) => f.field === 'source_id')) return;
  const from = q.filters.find((f) => f.field === 'moved_at' && f.op === 'from')?.value;
  const to = q.filters.find((f) => f.field === 'moved_at' && f.op === 'to')?.value;
  if ((Date.parse(String(to)) - Date.parse(String(from))) / 86_400_000 > MAX_RANGE_DAYS) {
    throw Errors.validation([
      {
        field: 'filter[moved_at]',
        code: 'VALIDATION_FAILED',
        message: `The range may span at most ${String(MAX_RANGE_DAYS)} days (or filter by one source).`,
      },
    ]);
  }
}

export function inventoryModules({ db, platform, authz, accessLog, config }: InventoryDeps): ApiModule[] {
  const svc = inventoryService(db, { timezone: config.timezone });

  // ---- /raw-materials (P4.04, P3 §12.4) -----------------------------------------------------------
  const m = defineModule({
    name: 'raw-materials',
    path: '/raw-materials',
    tag: 'Inventory',
    platform,
    authz,
    accessLog,
  });
  m.route({
    method: 'get',
    path: '/',
    summary: 'List raw materials',
    description:
      'Organisation-wide. filter[q] searches code (prefix) and name. Each row carries the design’s average rate and ' +
      'total cost: owned, available stock in the stores the caller sees (stock_balance), and whether it is at or ' +
      'below its reorder level.',
    auth: { permission: 'raw_material.view' },
    list: {
      pagination: 'page',
      filters: {
        q: { type: 'string', ops: ['eq'] },
        code: { type: 'string', ops: ['eq', 'like'] },
        name: { type: 'string', ops: ['like'] },
        material_category: { type: { enum: MATERIAL_CATEGORIES } },
        status: { type: { enum: MATERIAL_STATUSES } },
        is_stock_tracked: { type: 'bool' },
        uom_id: { type: 'id', ops: ['eq'] },
      },
      sorts: ['code', 'name'],
      defaultSort: ['code'],
    },
    success: { status: 200, description: 'A page of raw materials', schema: MaterialOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });
  m.route({
    method: 'post',
    path: '/',
    summary: 'Create a raw material',
    description:
      'code is numbered by the `raw_material` format when omitted. uom_id is the unit stock is kept in; ' +
      'is_stock_tracked false means receipts expense the cost directly and create no stock. Both are fixed once ' +
      'the material has moved. expense_account_id is a postable expense account.',
    auth: { permission: 'raw_material.create' },
    body: CreateMaterialBody,
    success: { status: 201, description: 'Created', schema: MaterialOut },
    errors: ['DUPLICATE_KEY'],
    handler: async (_req, res) => {
      const { body } = getValidated(res, { body: CreateMaterialBody });
      const r = await svc.create(body, currentActorId());
      sendCreated(res, r, `/api/v1/raw-materials/${r.id}`, r.version);
    },
  });
  masterItemRoutes(m, {
    module: 'raw_material',
    label: 'raw material',
    out: MaterialOut,
    replace: ReplaceMaterialBody,
    patch: PatchMaterialBody,
    svc,
    deleteHelp:
      'Only a raw material that has never moved. Otherwise deactivate it: it then takes no new stock.',
  });

  // ---- /stock (P4.04, P4 §10.3, P3 §13.2) -----------------------------------------------------------
  const s = defineModule({ name: 'stock', path: '/stock', tag: 'Inventory', platform, authz, accessLog });
  s.route({
    method: 'get',
    path: '/',
    summary: 'Stock balances',
    description:
      'Balances by material, location, ownership and state (the Stock List). Read only: stock changes only through ' +
      'approved documents. Facility data: a warehouse or factory grant sees that location; all estates sees every ' +
      'one. filter[in_stock]=true leaves out rows at zero (they are kept, P3 §13.2).',
    auth: { permission: 'inventory.view' },
    list: {
      pagination: 'page',
      filters: {
        material_class: { type: { enum: MATERIAL_CLASSES } },
        raw_material_id: { type: 'id', ops: ['eq', 'in'] },
        tea_type_id: { type: 'id', ops: ['eq'] },
        tea_grade_id: { type: 'id', ops: ['eq', 'in'] },
        location_type: { type: { enum: LOCATION_TYPES } },
        location_id: { type: 'id', ops: ['eq', 'in'] },
        ownership: { type: { enum: OWNERSHIPS } },
        stock_state: { type: { enum: STOCK_STATES } },
        in_stock: { type: 'bool' },
      },
      sorts: [],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of balances', schema: BalanceOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.balances(q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  // ---- /stock-movements (P4.04, P4 §10.3, P3 §13.1) -------------------------------------------------
  const v = defineModule({
    name: 'stock-movements',
    path: '/stock-movements',
    tag: 'Inventory',
    platform,
    authz,
    accessLog,
  });
  v.route({
    method: 'get',
    path: '/',
    summary: 'Stock movements',
    description:
      'The immutable movement ledger, newest first, cursor paginated. A moved_at range is required (at most 366 ' +
      'days unless source_id is given). Seen through the location (warehouse or factory grant) or the origin estate.',
    auth: { permission: 'inventory.view' },
    list: {
      pagination: 'cursor',
      rangeRequired: 'moved_at',
      filters: {
        moved_at: { type: 'datetime', ops: ['from', 'to'] },
        material_class: { type: { enum: MATERIAL_CLASSES } },
        raw_material_id: { type: 'id', ops: ['eq', 'in'] },
        tea_type_id: { type: 'id', ops: ['eq'] },
        tea_grade_id: { type: 'id', ops: ['eq', 'in'] },
        location_type: { type: { enum: LOCATION_TYPES } },
        location_id: { type: 'id', ops: ['eq', 'in'] },
        ownership: { type: { enum: OWNERSHIPS } },
        stock_state: { type: { enum: STOCK_STATES } },
        movement_type: { type: { enum: MOVEMENT_TYPE_KEYS } },
        direction: { type: { enum: DIRECTIONS } },
        source_type: { type: { enum: STOCK_SOURCES } },
        source_id: { type: 'id', ops: ['eq'] },
        estate_id: { type: 'id', ops: ['eq'] },
      },
      sorts: [],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of movements', schema: MovementOut },
    errors: [],
    handler: async (_req, res) => {
      const q = getListQuery(res);
      assertRange(q);
      const { items, nextCursor, limit } = await svc.movements(q);
      sendCursorPage(res, items, { cursor: { cursor: q.cursor?.cursor ?? null, limit }, nextCursor });
    },
  });

  return [m.build(), s.build(), v.build()];
}
