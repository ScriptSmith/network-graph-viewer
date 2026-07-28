import type { GraphNode } from "../../types";

/**
 * Gephi's Noverlap, run as a finishing pass rather than a layout: nodes keep
 * whatever arrangement the real layout produced and are only nudged apart
 * until none of their circles overlap. Neighbours come from a uniform grid,
 * so a pass costs about the number of nodes rather than its square.
 */

export interface NoverlapOptions {
  /** Gap to leave between circle edges, in graph units. */
  margin: number;
  /** Fraction of the overlap corrected per pass; below 1 it settles gently. */
  speed: number;
}

export const NOVERLAP_DEFAULTS: NoverlapOptions = { margin: 6, speed: 0.6 };

/** One separation pass. Returns true if anything still overlapped. */
export function noverlapPass(nodes: GraphNode[], options: NoverlapOptions): boolean {
  if (nodes.length < 2) return false;

  let maxRadius = 0;
  for (const node of nodes) maxRadius = Math.max(maxRadius, node.radius);
  const cell = Math.max(1, (maxRadius + options.margin) * 2);

  const grid = new Map<string, GraphNode[]>();
  const keyOf = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const node of nodes) {
    const key = keyOf(node.x ?? 0, node.y ?? 0);
    const bucket = grid.get(key);
    if (bucket) bucket.push(node);
    else grid.set(key, [node]);
  }

  let moved = false;
  for (const node of nodes) {
    const cx = Math.floor((node.x ?? 0) / cell);
    const cy = Math.floor((node.y ?? 0) / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cy - 1; gy <= cy + 1; gy++) {
        for (const other of grid.get(`${gx},${gy}`) ?? []) {
          // Each unordered pair is handled once, by the node that sorts first.
          if (other === node || other.id <= node.id) continue;
          let dx = (other.x ?? 0) - (node.x ?? 0);
          let dy = (other.y ?? 0) - (node.y ?? 0);
          let distance = Math.hypot(dx, dy);
          const wanted = node.radius + other.radius + options.margin;
          if (distance >= wanted) continue;

          if (distance === 0) {
            // Perfectly coincident nodes need an arbitrary but stable nudge.
            dx = 1;
            dy = 0;
            distance = 1;
          }
          const shift = ((wanted - distance) / distance) * options.speed * 0.5;
          node.x = (node.x ?? 0) - dx * shift;
          node.y = (node.y ?? 0) - dy * shift;
          other.x = (other.x ?? 0) + dx * shift;
          other.y = (other.y ?? 0) + dy * shift;
          moved = true;
        }
      }
    }
  }
  return moved;
}

/** Run passes until nothing overlaps or the budget runs out. */
export function noverlap(
  nodes: GraphNode[],
  options: NoverlapOptions = NOVERLAP_DEFAULTS,
  maxPasses = 120,
): number {
  for (let pass = 0; pass < maxPasses; pass++) {
    if (!noverlapPass(nodes, options)) return pass;
  }
  return maxPasses;
}
