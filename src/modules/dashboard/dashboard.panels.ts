import type { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import { dec } from '../../core/money/decimal.js';
import { currentScope } from '../../core/scope/scope.js';
import { businessDateToDb, todayIn } from '../../core/time/dates.js';
import { expenseOfPeriods } from '../accounting/ledger.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { approvalsService } from '../approvals/approvals.service.js';
import type { notificationsService } from '../notifications/notifications.service.js';
import type { Activity, Metric, PanelDataT, PanelKind } from './dashboard.schema.js';

/**
 * The home dashboard's panels (R.5), in the order and grid of the manager's design (rupai-backend-dashboard
 * pages/Dashboard.jsx). A panel either reads real records or says it has no data yet and when it will:
 * no invented figures (BACKLOG D-R.5-2).
 *
 * Visibility (P10 §16.2, D-R.5-3): a panel with data needs the permission that sees that data; a panel
 * waiting for its phase is shown to holders of dashboard.view or of its future module's view permission,
 * so the layout can be checked against the design before the data exists.
 */

type MetricT = z.infer<typeof Metric>;
type ActivityT = z.infer<typeof Activity>;

export interface PanelContext {
  readonly db: Database;
  readonly userId: bigint;
  readonly permissions: ReadonlySet<string>;
  /** One estate, already checked against the caller's scope; null = all they can see. */
  readonly estateId: bigint | null;
  readonly approvals: ReturnType<typeof approvalsService>;
  readonly notifications: ReturnType<typeof notificationsService>;
  readonly timezone: string;
}

export interface PanelDefinition {
  readonly key: string;
  readonly title: string;
  readonly kind: PanelKind;
  readonly row: number;
  readonly span: number;
  /** When the data does not exist yet: the phase that brings it. */
  readonly pending?: { readonly from: string; readonly reason: string; readonly permission?: string };
  /** For a live panel: whether this caller may see it. */
  readonly visible?: (permissions: ReadonlySet<string>) => boolean;
  readonly load?: (ctx: PanelContext) => Promise<PanelDataT>;
}

const PHASE_HR = 'Phase 2 — Workforce & HR';
const PHASE_ACCOUNTING = 'Phase 3 — Accounting & Budget';
const PHASE_FIELD = 'Phase 5 — Field Operations';
const PHASE_PAYROLL = 'Phase 9 — Payroll';

const metric = (
  key: string,
  label: string,
  value: string | null,
  unit: string | null,
  drill: MetricT['drill_down'] = null,
): MetricT => ({
  key,
  label,
  value,
  unit,
  available: true,
  available_from: null,
  comparison: null,
  drill_down: drill,
});
const later = (key: string, label: string, unit: string | null, from: string): MetricT => ({
  key,
  label,
  value: null,
  unit,
  available: false,
  available_from: from,
  comparison: null,
  drill_down: null,
});
const estateFilter = (ctx: PanelContext) =>
  ctx.estateId === null ? {} : { estate_id: ctx.estateId.toString() };
const can = (p: ReadonlySet<string>, ...keys: string[]) => keys.some((k) => p.has(k));

// ---- welcome banner ------------------------------------------------------------------------------------

async function welcome(ctx: PanelContext): Promise<PanelDataT> {
  const metrics: MetricT[] = [];
  const estates: Prisma.EstateWhereInput = {
    status: 'active',
    ...(ctx.estateId === null ? {} : { id: ctx.estateId }),
  };
  if (ctx.permissions.has('estate.view')) {
    const [count, sum] = await Promise.all([
      ctx.db.estate.count({ where: estates }),
      ctx.db.estate.aggregate({ where: estates, _sum: { totalArea: true } }),
    ]);
    const filter = { status: 'active', ...(ctx.estateId === null ? {} : { id: ctx.estateId.toString() }) };
    metrics.push(
      metric('estates', 'Estate', String(count), 'count', { resource: 'estates', filter }),
      metric('total_area', 'Total Area', dec(sum._sum.totalArea?.toString() ?? '0').toFixed(3), 'acre', {
        resource: 'estates',
        filter,
      }),
    );
  }
  if (ctx.permissions.has('field.view')) {
    const fields = await ctx.db.field.count({
      where: { status: 'active', ...(ctx.estateId === null ? {} : { estateId: ctx.estateId }) },
    });
    metrics.push(
      metric('fields', 'Total Fields', String(fields), 'count', {
        resource: 'fields',
        filter: { status: 'active', ...estateFilter(ctx) },
      }),
    );
  }
  // Live since P2.02: the current workers (not separated) of the estates in view.
  if (ctx.permissions.has('employment.view')) {
    const workers = await ctx.db.employmentProfile.count({
      where: {
        employmentType: 'worker',
        status: { not: 'separated' },
        ...(ctx.estateId === null ? {} : { estateId: ctx.estateId }),
      },
    });
    metrics.push(
      metric('workers', 'Total Workers', String(workers), 'count', {
        resource: 'employment-profiles',
        filter: {
          employment_type: 'worker',
          status: ['active', 'on_leave', 'suspended'],
          ...estateFilter(ctx),
        },
      }),
    );
  }
  return { kind: 'metrics', metrics };
}

// ---- monthly expense: live from P3.04 ------------------------------------------------------------------

/**
 * The posted expense of the period covering today against the previous period, from ledger_balance
 * (D-3.04-11). Zero until something posts: a real zero, never an invented figure.
 */
async function monthlyExpense(ctx: PanelContext): Promise<MetricT> {
  const today = businessDateToDb(todayIn(ctx.timezone));
  const current = await ctx.db.accountingPeriod.findFirst({
    where: { periodNumber: { lt: 13 }, startDate: { lte: today }, endDate: { gte: today } },
    select: { id: true, name: true, startDate: true, endDate: true },
  });
  if (!current)
    return later('monthly_expense', 'Monthly Expense', 'BDT', 'No accounting period covers today');
  const previous = await ctx.db.accountingPeriod.findFirst({
    where: { periodNumber: { lt: 13 }, endDate: { lt: current.startDate } },
    select: { id: true, name: true },
    orderBy: { endDate: 'desc' },
  });
  const filter = { estateId: ctx.estateId };
  const value = await expenseOfPeriods(ctx.db, [current.id], filter);
  const before = previous ? await expenseOfPeriods(ctx.db, [previous.id], filter) : null;
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    ...metric('monthly_expense', 'Monthly Expense', value.toFixed(2), 'BDT', {
      resource: 'accounting/expenses',
      filter: { from: iso(current.startDate), to: iso(current.endDate), ...estateFilter(ctx) },
    }),
    comparison:
      before && previous
        ? {
            label: `vs ${previous.name}`,
            previous_value: before.toFixed(2),
            change_percentage: before.isZero()
              ? '0.00'
              : value.minus(before).div(before.abs()).times(100).toFixed(2),
          }
        : null,
  };
}

// ---- recent activities: the audit trail ----------------------------------------------------------------

const RECORD_LABELS: Readonly<Record<string, string>> = {
  estate: 'Estate',
  division: 'Division',
  section: 'Section',
  field: 'Field',
  factory: 'Factory',
  warehouse: 'Warehouse',
  party: 'Party',
  user: 'User',
  role: 'Role',
  user_scope: 'Access scope',
  workflow: 'Workflow',
  notification_rule: 'Notification rule',
  season: 'Season',
  fiscal_year: 'Fiscal year',
  document_file: 'Document',
};
const VERBS: Readonly<Record<string, string>> = {
  create: 'added',
  update: 'changed',
  delete: 'removed',
  approve: 'approved',
  reject: 'rejected',
  post: 'posted',
  reverse: 'reversed',
  cancel: 'cancelled',
};
/** The resources a drill-down can name (the API path of the record). */
const RESOURCES: Readonly<Record<string, string>> = {
  estate: 'estates',
  division: 'divisions',
  section: 'sections',
  field: 'fields',
  factory: 'factories',
  warehouse: 'warehouses',
  party: 'parties',
  user: 'users',
  role: 'roles',
  workflow: 'workflows',
  notification_rule: 'notification-rules',
  season: 'seasons',
  fiscal_year: 'fiscal-years',
  document_file: 'documents',
};
const humanise = (s: string) => s.replace(/_/g, ' ');

/** The record's own name from a create or delete snapshot: its code, number, username or name. */
function nameIn(snapshot: string | null): string | null {
  if (!snapshot) return null;
  try {
    const v = JSON.parse(snapshot) as Record<string, unknown>;
    for (const k of ['field_number', 'code', 'username', 'name', 'title']) {
      if (typeof v[k] === 'string' && v[k]) return v[k];
    }
  } catch {
    // Not a snapshot.
  }
  return null;
}

const ACTIVITY_LIMIT = 8;

/**
 * The latest changes as the design's list. One update is one row per changed field in audit_change,
 * so rows of the same record, action, person and second are one activity.
 *
 * Who sees what (D-R.5-4): everyone's changes need audit.view AND access to all estates, because an
 * audit row carries no estate and could otherwise reveal another estate's records; anyone else sees
 * their own changes.
 */
async function recentActivities(ctx: PanelContext): Promise<PanelDataT> {
  const scope = await currentScope();
  const all = ctx.permissions.has('audit.view') && scope.allEstates;
  const rows = await ctx.db.auditChange.findMany({
    where: all ? {} : { changedBy: ctx.userId },
    orderBy: [{ changedAt: 'desc' }, { id: 'desc' }],
    take: ACTIVITY_LIMIT * 12,
    include: { changer: { select: { id: true, username: true } } },
  });
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = [r.recordType, r.recordId, r.action, r.changedBy, r.changedAt.toISOString()].join('|');
    const g = groups.get(k);
    if (g) g.push(r);
    else if (groups.size < ACTIVITY_LIMIT) groups.set(k, [r]);
  }
  const deleted = new Set(
    rows.filter((r) => r.action === 'delete').map((r) => `${r.recordType}|${r.recordId}`),
  );
  const items: ActivityT[] = [];
  for (const [key, g] of groups) {
    const [first] = g;
    if (!first) continue;
    const label = RECORD_LABELS[first.recordType] ?? humanise(first.recordType);
    const name = nameIn(first.newValue) ?? nameIn(first.oldValue);
    const changed = g.map((r) => r.field).filter((f): f is string => f !== null);
    const resource = RESOURCES[first.recordType];
    items.push({
      key,
      at: first.changedAt.toISOString(),
      title: `${label}${name ? ` ${name}` : ''} ${VERBS[first.action] ?? first.action}`,
      detail:
        changed.length > 0 ? `Changed: ${changed.map(humanise).join(', ')}` : `By: ${first.changer.username}`,
      record_type: first.recordType,
      record_id: first.recordId,
      action: first.action,
      actor: { id: first.changer.id.toString(), username: first.changer.username },
      drill_down:
        resource && !deleted.has(`${first.recordType}|${first.recordId}`)
          ? { resource, id: first.recordId, filter: {} }
          : null,
    });
  }
  return { kind: 'activity', showing: all ? 'all' : 'own', items };
}

// ---- estate map -----------------------------------------------------------------------------------------

async function estateMap(ctx: PanelContext): Promise<PanelDataT> {
  const one = ctx.estateId === null ? {} : { id: ctx.estateId };
  const inEstate = ctx.estateId === null ? {} : { estateId: ctx.estateId };
  const p = ctx.permissions;
  const fieldsBy = async (types: string[] | null) =>
    ctx.db.field.count({
      where: {
        status: 'active',
        ...inEstate,
        ...(types === null ? {} : { fieldType: { in: types } }),
      },
    });
  const [estates, teaFields, nurseries, otherFields, factories, stores] = await Promise.all([
    ctx.db.estate.findMany({
      where: { status: 'active', latitude: { not: null }, longitude: { not: null }, ...one },
      select: { id: true, code: true, name: true, latitude: true, longitude: true },
      orderBy: { code: 'asc' },
    }),
    p.has('field.view') ? fieldsBy(['tea_field', 'extension']) : null,
    p.has('field.view') ? fieldsBy(['nursery']) : null,
    p.has('field.view')
      ? fieldsBy(['infrastructure', 'drain', 'road_reserve', 'shade_area', 'road_side', 'water_body'])
      : null,
    // Factories and warehouses follow their own grants (P1.08), so these count what the caller can see.
    p.has('factory.view')
      ? ctx.db.factory.count({
          where: { status: 'active', ...(ctx.estateId === null ? {} : { primaryEstateId: ctx.estateId }) },
        })
      : null,
    p.has('warehouse.view') && ctx.estateId === null
      ? ctx.db.warehouse.count({ where: { status: 'active' } })
      : null,
  ]);
  const legendItem = (
    key: string,
    label: string,
    count: number | null,
    drill: { resource: string; filter: Record<string, string | string[]> } | null,
    from: string | null = null,
  ) => ({
    key,
    label,
    count,
    available: from === null,
    available_from: from,
    drill_down: count === null ? null : drill,
  });
  const ef = estateFilter(ctx);
  const legend = [
    legendItem('field', 'Field', teaFields, {
      resource: 'fields',
      filter: { status: 'active', field_type: ['tea_field', 'extension'], ...ef },
    }),
    legendItem('nursery', 'Nursery', nurseries, {
      resource: 'fields',
      filter: { status: 'active', field_type: 'nursery', ...ef },
    }),
    legendItem('factory', 'Factory', factories, {
      resource: 'factories',
      filter: {
        status: 'active',
        ...(ctx.estateId === null ? {} : { primary_estate_id: ctx.estateId.toString() }),
      },
    }),
    // Warehouses belong to no estate (P1.08): counted only on the all-estates view.
    legendItem('store', 'Store', stores, { resource: 'warehouses', filter: { status: 'active' } }),
    legendItem('office', 'Office', null, null, 'Map & GIS (R.6)'),
    legendItem('other', 'Other Locations', otherFields, {
      resource: 'fields',
      filter: {
        status: 'active',
        field_type: ['infrastructure', 'drain', 'road_reserve', 'shade_area', 'road_side', 'water_body'],
        ...ef,
      },
    }),
  ].filter((l) => l.count !== null || !l.available);
  return {
    kind: 'map',
    pins: estates.map((e) => ({
      id: e.id.toString(),
      type: 'estate' as const,
      code: e.code,
      name: e.name,
      latitude: e.latitude?.toFixed(6) ?? '',
      longitude: e.longitude?.toFixed(6) ?? '',
      drill_down: { resource: 'estates', id: e.id.toString(), filter: {} },
    })),
    legend,
  };
}

// ---- quick actions -----------------------------------------------------------------------------------

/** The design's shortcuts, each behind the permission it needs. */
const QUICK_ACTIONS = [
  { key: 'add_user', label: 'Add New User', resource: 'users', action: 'create', permission: 'user.create' },
  {
    key: 'create_role',
    label: 'Create Role',
    resource: 'roles',
    action: 'create',
    permission: 'role.create',
  },
  {
    key: 'assign_permission',
    label: 'Assign Permission',
    resource: 'roles',
    action: 'list',
    permission: 'role.edit',
  },
  {
    key: 'activity_log',
    label: 'User Activity Log',
    resource: 'audit-changes',
    action: 'list',
    permission: 'audit.view',
  },
  {
    key: 'export_users',
    label: 'Export Users',
    resource: 'users',
    action: 'export',
    permission: 'user.export',
    from: 'Exports (Phase 11 — Reports)',
  },
] as const;

function quickActions(ctx: PanelContext): Promise<PanelDataT> {
  return Promise.resolve({
    kind: 'actions',
    actions: QUICK_ACTIONS.filter((a) => ctx.permissions.has(a.permission)).map((a) => ({
      key: a.key,
      label: a.label,
      resource: a.resource,
      action: a.action,
      available: !('from' in a),
      available_from: 'from' in a ? a.from : null,
    })),
  });
}

// ---- approvals and notifications (P1.18's first panels) ----------------------------------------------

async function pendingApprovals(ctx: PanelContext): Promise<PanelDataT> {
  const { total } = await ctx.approvals.queue(ctx.userId, {
    filters: [],
    sort: [],
    include: [],
    fields: {},
    page: { page: 1, perPage: 1 },
  });
  return {
    kind: 'metrics',
    metrics: [
      metric('pending', 'Waiting for you', String(total), 'count', {
        resource: 'approvals-pending',
        filter: {},
      }),
    ],
  };
}

async function notificationsPanel(ctx: PanelContext): Promise<PanelDataT> {
  const s = await ctx.notifications.summary(ctx.userId);
  return {
    kind: 'metrics',
    metrics: [
      metric('unread', 'Unread', String(s.unread), 'count', {
        resource: 'notifications',
        filter: { is_read: 'false' },
      }),
      metric('unread_critical', 'Critical', String(s.unread_critical), 'count', {
        resource: 'notifications',
        filter: { is_read: 'false', severity: 'critical' },
      }),
    ],
  };
}

// ---- the registry --------------------------------------------------------------------------------------

export const HOME_PANELS: readonly PanelDefinition[] = [
  {
    key: 'welcome',
    title: 'Welcome',
    kind: 'metrics',
    row: 1,
    span: 8,
    visible: (p) => can(p, 'estate.view', 'field.view', 'employment.view'),
    load: welcome,
  },
  {
    key: 'weather',
    title: 'Estate Weather',
    kind: 'weather',
    row: 1,
    span: 4,
    pending: { from: 'Open decision: no weather source yet', reason: 'No weather service is connected.' },
  },
  {
    key: 'stats',
    title: 'Today at a glance',
    kind: 'metrics',
    row: 2,
    span: 12,
    pending: {
      from: PHASE_HR,
      reason: 'Plucking, attendance, wages and expenses arrive with their phases.',
      permission: 'plucking.view',
    },
    // Each card names its own phase, so the layout can be checked now.
    load: async (ctx) => ({
      kind: 'metrics',
      metrics: [
        later('today_plucking', "Today's Plucking", 'kg', PHASE_FIELD),
        later('plucking_mtd', 'Month to Date', 'kg', PHASE_FIELD),
        later('plucking_ytd', 'Year to Date', 'kg', PHASE_FIELD),
        later('workers_today', "Today's Workers", 'count', PHASE_HR),
        later('daily_wage_cost', 'Daily Wage Cost', 'BDT', PHASE_PAYROLL),
        // Live since P3.04 for whoever reads the ledger.
        ctx.permissions.has('accounting.view')
          ? await monthlyExpense(ctx)
          : later('monthly_expense', 'Monthly Expense', 'BDT', PHASE_ACCOUNTING),
      ],
    }),
  },
  {
    key: 'plucking_trend',
    title: 'Plucking Trend',
    kind: 'series',
    row: 3,
    span: 5,
    pending: { from: PHASE_FIELD, reason: 'Plucking is recorded from Phase 5.', permission: 'plucking.view' },
  },
  {
    key: 'field_plucking',
    title: 'Field-wise Plucking (Today)',
    kind: 'breakdown',
    row: 3,
    span: 4,
    pending: { from: PHASE_FIELD, reason: 'Plucking is recorded from Phase 5.', permission: 'plucking.view' },
  },
  {
    key: 'top_fields',
    title: 'Top Fields (Month)',
    kind: 'ranking',
    row: 3,
    span: 3,
    pending: { from: PHASE_FIELD, reason: 'Plucking is recorded from Phase 5.', permission: 'plucking.view' },
  },
  {
    key: 'attendance',
    title: 'Worker Attendance (Today)',
    kind: 'breakdown',
    row: 4,
    span: 3,
    pending: {
      from: PHASE_HR,
      reason: 'Attendance is recorded from Phase 2.',
      permission: 'attendance.view',
    },
  },
  {
    key: 'recent_activities',
    title: 'Recent Activities',
    kind: 'activity',
    row: 4,
    span: 4,
    load: recentActivities,
  },
  {
    key: 'estate_map',
    title: 'Estate Map',
    kind: 'map',
    row: 4,
    span: 5,
    visible: (p) => p.has('estate.view'),
    load: estateMap,
  },
  {
    key: 'quick_actions',
    title: 'Quick Actions',
    kind: 'actions',
    row: 5,
    span: 12,
    visible: (p) => QUICK_ACTIONS.some((a) => p.has(a.permission)),
    load: quickActions,
  },
  {
    key: 'pending_approvals',
    title: 'Pending Approvals',
    kind: 'metrics',
    row: 6,
    span: 6,
    load: pendingApprovals,
  },
  {
    key: 'notifications',
    title: 'Notifications',
    kind: 'metrics',
    row: 6,
    span: 6,
    load: notificationsPanel,
  },
];

/** Whether a caller sees a panel at all. */
export function panelVisible(def: PanelDefinition, permissions: ReadonlySet<string>): boolean {
  if (def.pending) {
    return (
      permissions.has('dashboard.view') ||
      (def.pending.permission !== undefined && permissions.has(def.pending.permission))
    );
  }
  return def.visible ? def.visible(permissions) : true;
}
