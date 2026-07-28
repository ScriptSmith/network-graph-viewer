import type { BaseGraph, GraphNode } from "../../types";
import type { Point } from "./index";
import { cellToId } from "../cells";

/**
 * Circle packing: nodes cluster into one disc per attribute value, and the
 * discs are then packed against each other. Good for seeing how big each
 * group is when the connections between them are not the question.
 *
 * Placement walks an Archimedean spiral and takes the first spot that clears
 * everything already down, checked against a uniform grid rather than every
 * previous circle. Deterministic, and close enough to optimal to read well.
 */

interface Circle {
  x: number;
  y: number;
  r: number;
}

const SPIRAL_STEP = 0.35;

/** Pack circles of the given radii around the origin, largest first. */
function packCircles(radii: number[]): Circle[] {
  const order = radii.map((r, i) => ({ r, i })).sort((a, b) => b.r - a.r || a.i - b.i);
  const placed: Circle[] = [];
  const out: Circle[] = new Array(radii.length);
  if (order.length === 0) return out;

  const maxRadius = order[0].r;
  const cell = Math.max(1, maxRadius * 2);
  const grid = new Map<string, Circle[]>();
  const keyOf = (cx: number, cy: number) => `${cx},${cy}`;
  const insert = (c: Circle) => {
    const key = keyOf(Math.floor(c.x / cell), Math.floor(c.y / cell));
    const bucket = grid.get(key);
    if (bucket) bucket.push(c);
    else grid.set(key, [c]);
  };
  const clashes = (c: Circle): boolean => {
    const cx = Math.floor(c.x / cell);
    const cy = Math.floor(c.y / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const other of grid.get(keyOf(gx, gy)) ?? []) {
          const dx = other.x - c.x;
          const dy = other.y - c.y;
          const min = other.r + c.r;
          if (dx * dx + dy * dy < min * min - 1e-9) return true;
        }
      }
    }
    return false;
  };

  for (const { r, i } of order) {
    let circle: Circle = { x: 0, y: 0, r };
    if (placed.length > 0) {
      // Step out along the spiral until the circle fits.
      for (let t = 0; ; t += SPIRAL_STEP) {
        const radius = maxRadius * 0.6 * t ** 0.62;
        circle = { x: radius * Math.cos(t), y: radius * Math.sin(t), r };
        if (!clashes(circle)) break;
        if (t > 4000) break;
      }
    }
    placed.push(circle);
    insert(circle);
    out[i] = circle;
  }
  return out;
}

/** Smallest circle centred on the origin containing every packed circle. */
function enclosingRadius(circles: Circle[]): number {
  let max = 0;
  for (const c of circles) max = Math.max(max, Math.hypot(c.x, c.y) + c.r);
  return max;
}

export interface CirclePackParams {
  /**
   * Node-table column whose values define the groups. Empty means group by
   * whatever the style is already colouring nodes with, which is usually what
   * you want and is the only option that understands projected edge columns.
   */
  groupBy: string;
  padding: number;
}

export function circlePackLayout(graph: BaseGraph, params: CirclePackParams): Map<string, Point> {
  const targets = new Map<string, Point>();
  if (graph.nodes.length === 0) return targets;

  const groups = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    const key = params.groupBy
      ? (cellToId(node.row[params.groupBy]) ?? "(blank)")
      : (node.group ?? "(blank)");
    const bucket = groups.get(key);
    if (bucket) bucket.push(node);
    else groups.set(key, [node]);
  }

  // Largest groups first so the layout is stable when a group changes size.
  const ordered = [...groups.entries()].sort(
    (a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
  );

  const inner: { key: string; circles: Circle[]; nodes: GraphNode[]; radius: number }[] = [];
  for (const [key, nodes] of ordered) {
    const sorted = [...nodes].sort((a, b) => b.radius - a.radius || a.id.localeCompare(b.id));
    const circles = packCircles(sorted.map((n) => n.radius + params.padding));
    inner.push({ key, circles, nodes: sorted, radius: enclosingRadius(circles) + params.padding });
  }

  const groupCircles = packCircles(inner.map((g) => g.radius));
  inner.forEach((group, gi) => {
    const centre = groupCircles[gi];
    group.nodes.forEach((node, i) => {
      targets.set(node.id, {
        x: centre.x + group.circles[i].x,
        y: centre.y + group.circles[i].y,
      });
    });
  });

  return targets;
}
