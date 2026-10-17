import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';

/**
 * The dashboard API (R.5 for the home page of the manager's design; the panel framework of P1.18).
 * Spec P4 §14.2 (Figure 14.1: a metric carries its own drill-down), P10 §16.2 (panels load
 * independently, show their as-of time, are permission-filtered, and the client hard-codes no routes).
 */

export const PANEL_KINDS = [
  'metrics',
  'series',
  'breakdown',
  'ranking',
  'activity',
  'map',
  'actions',
  'weather',
] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

/**
 * Where a figure leads: a resource and the filter that gives the records behind it. The client turns
 * it into a route; `id` names one record.
 */
export const DrillDown = z.object({
  resource: z.string(),
  id: z.string().optional(),
  filter: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
});

/** Why a figure or panel has no data yet, and when it will. */
const availability = {
  available: z.boolean(),
  /** e.g. "Phase 2 — Workforce & HR". Null when available. */
  available_from: z.string().nullable(),
};

export const Metric = z.object({
  key: z.string(),
  label: z.string(),
  /** A decimal string (or an integer as a string). Null when not available: never an invented number. */
  value: z.string().nullable(),
  /** acre, kg, BDT, count, … */
  unit: z.string().nullable(),
  ...availability,
  comparison: z
    .object({ label: z.string(), previous_value: z.string(), change_percentage: z.string() })
    .nullable(),
  drill_down: DrillDown.nullable(),
});

const MetricsData = z.object({ kind: z.literal('metrics'), metrics: z.array(Metric) });
const SeriesData = z.object({
  kind: z.literal('series'),
  unit: z.string(),
  points: z.array(z.object({ label: z.string(), value: z.string() })),
});
const BreakdownData = z.object({
  kind: z.literal('breakdown'),
  unit: z.string(),
  total: z.string(),
  slices: z.array(
    z.object({ key: z.string(), label: z.string(), value: z.string(), drill_down: DrillDown.nullable() }),
  ),
});
const RankingData = z.object({
  kind: z.literal('ranking'),
  unit: z.string(),
  items: z.array(z.object({ rank: z.number().int(), label: z.string(), value: z.string(), max: z.string() })),
});
export const Activity = z.object({
  /** Stable within a response: record type, id and time. */
  key: z.string(),
  at: z.string(),
  /** e.g. "Field A-N1-1 added". */
  title: z.string(),
  /** e.g. "By: manager" or "Changed: name, planted area". */
  detail: z.string(),
  record_type: z.string(),
  record_id: z.string(),
  action: z.string(),
  actor: z.object({ id: z.string(), username: z.string() }),
  /** Null once the record is deleted. */
  drill_down: DrillDown.nullable(),
});
const ActivityData = z.object({
  kind: z.literal('activity'),
  /** all = everyone's changes (audit.view with access to all estates); own = the caller's only. */
  showing: z.enum(['all', 'own']),
  items: z.array(Activity),
});
const MapData = z.object({
  kind: z.literal('map'),
  /** Positioned places. Today the estates (their latitude/longitude); fields have no shape until Map & GIS. */
  pins: z.array(
    z.object({
      id: z.string(),
      type: z.enum(['estate']),
      code: z.string(),
      name: z.string(),
      latitude: z.string(),
      longitude: z.string(),
      drill_down: DrillDown,
    }),
  ),
  /** The design's legend, with counts; a type with no register yet says so. */
  legend: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      count: z.number().int().nullable(),
      ...availability,
      drill_down: DrillDown.nullable(),
    }),
  ),
});
const ActionsData = z.object({
  kind: z.literal('actions'),
  /** Only the actions the caller may take. */
  actions: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      /** What to open: a resource and what to do there (create opens the form). */
      resource: z.string(),
      action: z.enum(['create', 'list', 'export']),
      ...availability,
    }),
  ),
});
const WeatherData = z.object({
  kind: z.literal('weather'),
  location: z.string().nullable(),
  temperature_c: z.string(),
  condition: z.string(),
  humidity_pct: z.string(),
  wind_kmh: z.string(),
  rainfall_mm: z.string(),
});

export const PanelData = z.discriminatedUnion('kind', [
  MetricsData,
  SeriesData,
  BreakdownData,
  RankingData,
  ActivityData,
  MapData,
  ActionsData,
  WeatherData,
]);
export type PanelDataT = z.infer<typeof PanelData>;

const panelHead = {
  key: z.string(),
  title: z.string(),
  kind: z.enum(PANEL_KINDS),
  /** The design's grid: the row (1 = top) and the columns of 12 the panel spans on a wide screen. */
  row: z.number().int(),
  span: z.number().int().min(1).max(12),
  ...availability,
  /** Why there is no data yet. Null when available. */
  unavailable_reason: z.string().nullable(),
};

export const DashboardOut = z.object({
  key: z.string(),
  title: z.string(),
  /** The panels the caller may see, in the design's order. Load each with its own request. */
  panels: z.array(z.object(panelHead)),
});

export const PanelOut = z.object({
  ...panelHead,
  /** When the figures were read. Live panels read now; summary-table panels will say when they were built. */
  as_of: z.string(),
  /** The estate the panel was asked for; null = every estate the caller can see. */
  estate_id: z.string().nullable(),
  /** Null when not available. */
  data: PanelData.nullable(),
});

export const DashboardParams = z.object({ dashboard: z.enum(['home']) });
export const PanelParams = z.object({ dashboard: z.enum(['home']), panel: z.string().min(1).max(50) });
export const PanelQuery = z.strictObject({
  /** One estate. Outside the caller's scope it is refused (SCOPE_DENIED), never silently widened. */
  estate_id: zId.optional(),
});
