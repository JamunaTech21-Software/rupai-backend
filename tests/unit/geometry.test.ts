import { describe, expect, it } from 'vitest';

import {
  figuresOf,
  GeometryError,
  geometryFromKml,
  geometryFromPoints,
  parseGeometry,
} from '../../src/core/geo/geometry.js';

/** R.3 GIS (RUP-655): field shapes are validated and measured on the server. */

// A 0.001° square at Sreemangal (24.31 N): about 111.2 m × 101.3 m.
const SQUARE = [
  [91.73, 24.31],
  [91.731, 24.31],
  [91.731, 24.311],
  [91.73, 24.311],
  [91.73, 24.31],
];

describe('field shapes', () => {
  it('measures a polygon: area in acres, perimeter in km, centroid', () => {
    const f = figuresOf(parseGeometry({ type: 'Polygon', coordinates: [SQUARE] }, false));
    // 111.32 m × 101.43 m ≈ 11 291 m² ≈ 2.790 acres (sphere, within 0.5 %).
    expect(f.areaAcres).toBeGreaterThan(2.77);
    expect(f.areaAcres).toBeLessThan(2.81);
    expect(f.perimeterKm).toBeCloseTo(0.4255, 2);
    expect(f.centroid).toEqual({ latitude: 24.3105, longitude: 91.7305 });
  });

  it('closes an open ring, accepts a Feature, and subtracts holes', () => {
    const open = parseGeometry(
      { type: 'Feature', geometry: { type: 'Polygon', coordinates: [SQUARE.slice(0, 4)] } },
      false,
    );
    expect(open.coordinates[0]).toHaveLength(5);
    const hole = [
      [91.7302, 24.3102],
      [91.7304, 24.3102],
      [91.7304, 24.3104],
      [91.7302, 24.3104],
    ];
    const withHole = figuresOf(parseGeometry({ type: 'Polygon', coordinates: [SQUARE, hole] }, false));
    expect(withHole.areaAcres).toBeLessThan(2.7);
  });

  it('refuses what is not a usable boundary', () => {
    const bad = (g: unknown, line = false) => {
      expect(() => parseGeometry(g, line)).toThrow(GeometryError);
    };
    bad({ type: 'Point', coordinates: [91.73, 24.31] });
    bad({
      type: 'Polygon',
      coordinates: [
        [
          [91.73, 24.31],
          [91.731, 24.31],
        ],
      ],
    }); // two corners
    bad({
      type: 'Polygon',
      coordinates: [
        [
          [24.31, 91.73],
          [24.31, 91.731],
          [24.311, 91.731],
        ],
      ],
    }); // lat/lng swapped
    bad({
      type: 'Polygon',
      coordinates: [
        [
          [91.73, 24.31],
          [91.731, 24.311],
          [91.731, 24.31],
          [91.73, 24.311],
        ],
      ],
    }); // a bow tie
    bad({
      type: 'LineString',
      coordinates: [
        [91.73, 24.31],
        [91.731, 24.31],
      ],
    }); // a line where a polygon is needed
    bad({
      type: 'Polygon',
      coordinates: [
        [
          ['x', 24.31],
          [91.731, 24.31],
          [91.731, 24.311],
        ],
      ],
    });
  });

  it('measures a road or drain as a line: length, no area', () => {
    const f = figuresOf(
      parseGeometry(
        {
          type: 'LineString',
          coordinates: [
            [91.73, 24.31],
            [91.731, 24.31],
          ],
        },
        true,
      ),
    );
    expect(f.areaAcres).toBeNull();
    expect(f.perimeterKm).toBeCloseTo(0.1014, 2);
  });

  it('reads a KML polygon and a walk of GPS points', () => {
    const kml = `<?xml version="1.0"?><kml><Placemark><name>Block 01</name><Polygon><outerBoundaryIs><LinearRing>
      <coordinates>91.73,24.31,0 91.731,24.31,0 91.731,24.311,0 91.73,24.311,0 91.73,24.31,0</coordinates>
      </LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    expect(figuresOf(geometryFromKml(kml, false)).areaAcres).toBeCloseTo(2.79, 1);
    const walk = SQUARE.slice(0, 4).map(([longitude, latitude]) => ({
      latitude: latitude ?? 0,
      longitude: longitude ?? 0,
    }));
    expect(figuresOf(geometryFromPoints(walk, false)).areaAcres).toBeCloseTo(2.79, 1);
    expect(() => geometryFromKml('<kml></kml>', false)).toThrow(GeometryError);
  });
});
