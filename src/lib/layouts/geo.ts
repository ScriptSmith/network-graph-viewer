import type { BaseGraph } from "../../types";
import type { Point } from "./index";
import { asNumber } from "../parse";
import { extentOf } from "../numbers";

/**
 * Nodes at their real coordinates: Web Mercator over two node-table columns.
 * No tiles, no basemap, no fetches; the graph is the map. Rows with no usable
 * coordinates are parked in a strip below the projected extent rather than
 * dropped, and the count is the caller's to report.
 */

/** Web Mercator's usable latitude; beyond it the projection runs off to infinity. */
export const MERCATOR_LAT_LIMIT = 85.05112878;

/** How wide the projected extent is drawn, in layout units. */
const MAP_SPAN = 900;
/** Spacing of the parked strip, matching the grid layout's rhythm. */
const PARK_SPACING = 60;

/**
 * One point through Web Mercator, in projection units: x from longitude, y
 * from latitude with north negative, since latitude grows north and SVG y
 * grows down (the GEXF writer flips its y for the same reason).
 */
export function mercator(lat: number, lon: number): Point {
  const clamped = Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat));
  const phi = (clamped * Math.PI) / 180;
  return {
    x: (lon * Math.PI) / 180,
    y: -Math.log(Math.tan(Math.PI / 4 + phi / 2)),
  };
}

export interface GeoProjection {
  targets: Map<string, Point>;
  /** Nodes with no usable coordinates, parked below the map, in node order. */
  parked: string[];
}

export function projectGeo(graph: BaseGraph, latColumn: string, lonColumn: string): GeoProjection {
  const placed: { id: string; point: Point }[] = [];
  const parked: string[] = [];

  for (const node of graph.nodes) {
    const lat = latColumn === "" ? null : asNumber(node.row[latColumn]);
    const lon = lonColumn === "" ? null : asNumber(node.row[lonColumn]);
    if (lat === null || lon === null || lat < -90 || lat > 90) {
      parked.push(node.id);
      continue;
    }
    placed.push({ id: node.id, point: mercator(lat, lon) });
  }

  const targets = new Map<string, Point>();
  const xs = extentOf(placed.map((p) => p.point.x));
  const ys = extentOf(placed.map((p) => p.point.y));

  let bottom = 0;
  let left = -MAP_SPAN / 2;
  let width = MAP_SPAN;
  if (xs !== null && ys !== null) {
    // One scale for both axes, or the map would shear; centred on the origin
    // so the canvas fit works the way it does for every computed layout.
    const spanX = xs.max - xs.min;
    const spanY = ys.max - ys.min;
    const scale = MAP_SPAN / Math.max(spanX, spanY, 1e-9);
    const cx = (xs.min + xs.max) / 2;
    const cy = (ys.min + ys.max) / 2;
    for (const { id, point } of placed) {
      targets.set(id, { x: (point.x - cx) * scale, y: (point.y - cy) * scale });
    }
    bottom = (ys.max - cy) * scale;
    left = (xs.min - cx) * scale;
    width = Math.max(spanX * scale, PARK_SPACING);
  }

  // The parked strip: rows under the map, wrapping at its width, so a column
  // of coordinates with holes in it still shows every node it names.
  const perRow = Math.max(1, Math.floor(width / PARK_SPACING) + 1);
  parked.forEach((id, i) => {
    targets.set(id, {
      x: left + (i % perRow) * PARK_SPACING,
      y: bottom + PARK_SPACING * 1.5 + Math.floor(i / perRow) * PARK_SPACING,
    });
  });

  return { targets, parked };
}
