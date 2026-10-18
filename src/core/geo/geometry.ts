/**
 * Field and section shapes (R.3 GIS, RUP-655). GeoJSON geometry in longitude / latitude (WGS 84), as
 * Leaflet draws and the design shows. Validated here, because a CHECK cannot judge a ring; the figures
 * (centroid, perimeter, area) are computed here and stored with the shape, so they never drift from it.
 *
 * Area and length are on the sphere (radius 6 378 137 m, as Leaflet and Turf use): for estate-sized
 * shapes the error against the ellipsoid is well under 0.5 %.
 */

export type Position = readonly [number, number];
export interface PolygonGeometry {
  readonly type: 'Polygon';
  /** Outer ring first, holes after; each ring closed (first position = last). */
  readonly coordinates: readonly (readonly Position[])[];
}
export interface LineGeometry {
  readonly type: 'LineString';
  readonly coordinates: readonly Position[];
}
export type Geometry = PolygonGeometry | LineGeometry;

export interface GeometryFigures {
  readonly centroid: { readonly latitude: number; readonly longitude: number };
  /** Perimeter of a polygon (outer ring), or length of a line, km. */
  readonly perimeterKm: number;
  /** Area of a polygon (outer ring less holes), acres; null for a line. */
  readonly areaAcres: number | null;
}

export class GeometryError extends Error {}

/** Bangladesh with a margin (the stored centroid is checked against the same box). */
export const BANGLADESH = { minLat: 20.3, maxLat: 26.9, minLng: 87.9, maxLng: 92.9 } as const;
export const MAX_POSITIONS = 2000;
const R = 6_378_137;
const SQM_PER_ACRE = 4046.8564224;
const rad = (d: number) => (d * Math.PI) / 180;

function position(p: unknown, where: string): Position {
  if (!Array.isArray(p) || p.length < 2 || p.length > 3) {
    throw new GeometryError(`${where}: a position is [longitude, latitude].`);
  }
  const [lng, lat] = p as unknown[];
  if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) {
    throw new GeometryError(`${where}: longitude and latitude must be numbers.`);
  }
  if (
    lat < BANGLADESH.minLat ||
    lat > BANGLADESH.maxLat ||
    lng < BANGLADESH.minLng ||
    lng > BANGLADESH.maxLng
  ) {
    throw new GeometryError(
      `${where}: ${String(lat)}, ${String(lng)} is outside Bangladesh (check latitude / longitude order).`,
    );
  }
  // Six places (about 10 cm) is the precision kept.
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

/** The i-th position of a validated list (always present: the loops stay within bounds). */
const at = (pts: readonly Position[], i: number): Position => pts[i] ?? [0, 0];
const same = (a: Position, b: Position) => a[0] === b[0] && a[1] === b[1];

/** Whether segments p1-p2 and p3-p4 cross (touching at a shared end does not count). */
function crosses(p1: Position, p2: Position, p3: Position, p4: Position): boolean {
  const d = (a: Position, b: Position, c: Position) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function ring(raw: unknown, where: string): Position[] {
  if (!Array.isArray(raw)) throw new GeometryError(`${where}: a ring is a list of positions.`);
  const pts = raw.map((p, i) => position(p, `${where}[${String(i)}]`));
  const first = pts[0];
  const last = pts[pts.length - 1];
  // Close an open ring rather than refuse it: a drawing tool or a GPS walk often leaves it open.
  if (first && last && !same(first, last)) pts.push(first);
  if (pts.length < 4) throw new GeometryError(`${where}: a boundary needs at least three distinct corners.`);
  for (let i = 0; i < pts.length - 1; i += 1) {
    for (let j = i + 2; j < pts.length - 1; j += 1) {
      if (i === 0 && j === pts.length - 2) continue; // the closing segment meets the first
      const a = pts[i];
      const b = pts[i + 1];
      const c = pts[j];
      const e = pts[j + 1];
      if (a && b && c && e && crosses(a, b, c, e)) {
        throw new GeometryError(
          `${where}: the boundary crosses itself (edges ${String(i + 1)} and ${String(j + 1)}).`,
        );
      }
    }
  }
  return pts;
}

/** Validates a GeoJSON geometry (or a Feature wrapping one) and returns it normalised. */
export function parseGeometry(input: unknown, allowLine: boolean): Geometry {
  const g =
    (input as { type?: unknown; geometry?: unknown } | null)?.type === 'Feature'
      ? (input as { geometry: unknown }).geometry
      : input;
  const type = (g as { type?: unknown } | null)?.type;
  const coords = (g as { coordinates?: unknown } | null)?.coordinates;
  const count = JSON.stringify(coords ?? []).split('],[').length;
  if (count > MAX_POSITIONS)
    throw new GeometryError(`A boundary has at most ${String(MAX_POSITIONS)} positions.`);
  if (type === 'Polygon') {
    if (!Array.isArray(coords) || coords.length === 0)
      throw new GeometryError('A Polygon has at least one ring.');
    return {
      type: 'Polygon',
      coordinates: coords.map((r, i) => ring(r, i === 0 ? 'outer ring' : `hole ${String(i)}`)),
    };
  }
  if (type === 'LineString') {
    if (!allowLine) throw new GeometryError('A line is only for roads and drains; this needs a Polygon.');
    if (!Array.isArray(coords) || coords.length < 2)
      throw new GeometryError('A line has at least two positions.');
    return { type: 'LineString', coordinates: coords.map((p, i) => position(p, `position ${String(i)}`)) };
  }
  throw new GeometryError('The boundary must be a GeoJSON Polygon (or a LineString for a road or drain).');
}

/** Great-circle distance, metres. */
function distance(a: Position, b: Position): number {
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const length = (pts: readonly Position[]) => pts.slice(1).reduce((m, p, i) => m + distance(at(pts, i), p), 0);

/** Area of a ring on the sphere, m² (the spherical-excess sum Leaflet.GeometryUtil and Turf use). */
function ringArea(pts: readonly Position[]): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [lng1, lat1] = at(pts, i);
    const [lng2, lat2] = at(pts, i + 1);
    total += rad(lng2 - lng1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((total * R * R) / 2);
}

/** Area-weighted centroid of a ring (planar in degrees: exact enough for an estate-sized shape). */
function ringCentroid(pts: readonly Position[]): Position {
  // Relative to the first corner: products of whole coordinates (91 × 24) would lose the small digits.
  const [ox, oy] = at(pts, 0);
  let a = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [px1, py1] = at(pts, i);
    const [px2, py2] = at(pts, i + 1);
    const [x1, y1, x2, y2] = [px1 - ox, py1 - oy, px2 - ox, py2 - oy];
    const f = x1 * y2 - x2 * y1;
    a += f;
    x += (x1 + x2) * f;
    y += (y1 + y2) * f;
  }
  if (a === 0) {
    const n = pts.length - 1;
    return [
      pts.slice(0, n).reduce((s, p) => s + p[0], 0) / n,
      pts.slice(0, n).reduce((s, p) => s + p[1], 0) / n,
    ];
  }
  return [ox + x / (3 * a), oy + y / (3 * a)];
}

export function figuresOf(g: Geometry): GeometryFigures {
  if (g.type === 'LineString') {
    const mid = at(g.coordinates, Math.floor(g.coordinates.length / 2));
    return {
      centroid: { latitude: mid[1], longitude: mid[0] },
      perimeterKm: length(g.coordinates) / 1000,
      areaAcres: null,
    };
  }
  const [outer, ...holes] = g.coordinates as [Position[], ...Position[][]];
  const area = ringArea(outer) - holes.reduce((s, h) => s + ringArea(h), 0);
  const [lng, lat] = ringCentroid(outer);
  return {
    centroid: { latitude: Math.round(lat * 1e6) / 1e6, longitude: Math.round(lng * 1e6) / 1e6 },
    perimeterKm: length(outer) / 1000,
    areaAcres: Math.max(0, area) / SQM_PER_ACRE,
  };
}

/**
 * The first Polygon (or LineString) of a KML document: Google Earth's and most GPS apps' export. Only
 * the coordinates are read ("lng,lat[,alt]" separated by spaces); everything else in the file is ignored.
 */
export function geometryFromKml(kml: string, allowLine: boolean): Geometry {
  if (kml.length > 2_000_000) throw new GeometryError('The KML file is too large.');
  const coordsOf = (block: string) => {
    const m = /<coordinates>([\s\S]*?)<\/coordinates>/i.exec(block);
    if (!m?.[1]) throw new GeometryError('The KML has no coordinates.');
    return m[1]
      .trim()
      .split(/\s+/)
      .map((t) => t.split(',').map(Number));
  };
  const polygon = /<Polygon[\s\S]*?<\/Polygon>/i.exec(kml)?.[0];
  if (polygon) {
    const outer = /<outerBoundaryIs>([\s\S]*?)<\/outerBoundaryIs>/i.exec(polygon)?.[1] ?? polygon;
    const holes = [...polygon.matchAll(/<innerBoundaryIs>([\s\S]*?)<\/innerBoundaryIs>/gi)].map((h) =>
      coordsOf(h[1] ?? ''),
    );
    return parseGeometry({ type: 'Polygon', coordinates: [coordsOf(outer), ...holes] }, allowLine);
  }
  const line = /<LineString[\s\S]*?<\/LineString>/i.exec(kml)?.[0];
  if (line) return parseGeometry({ type: 'LineString', coordinates: coordsOf(line) }, allowLine);
  throw new GeometryError('The KML has no Polygon or LineString.');
}

/** A walk of GPS points (latitude, longitude) as a polygon, or a line for a road or drain. */
export function geometryFromPoints(
  points: readonly { readonly latitude: number; readonly longitude: number }[],
  asLine: boolean,
): Geometry {
  const coords = points.map((p) => [p.longitude, p.latitude]);
  return parseGeometry(
    asLine ? { type: 'LineString', coordinates: coords } : { type: 'Polygon', coordinates: [coords] },
    asLine,
  );
}
