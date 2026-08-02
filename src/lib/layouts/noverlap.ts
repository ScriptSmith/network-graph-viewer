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

/*
 * The label-aware version: the same finishing pass, but a node's footprint is
 * the box around its disc plus the label drawn above it, so nodes are nudged
 * until the visible names stop sitting on each other. Label bounds are
 * estimated from character count at the label font size; in-graph text is
 * system fonts, so a rough constant beats measuring the DOM per node per pass.
 */

/** Average glyph advance at the canvas's 11px label size, halo included. */
const GLYPH_WIDTH = 6.4;
/** Line box of a label, and the gap the canvas leaves above the disc. */
const LABEL_HEIGHT = 14;
const LABEL_GAP = 6;

interface Box {
  node: GraphNode;
  /** Box centre, offset above the disc centre when a label rides along. */
  cy: number;
  hw: number;
  hh: number;
  held: boolean;
}

function boxOf(node: GraphNode, label: string | undefined, held: boolean): Box {
  const r = node.radius;
  // The label hangs above the disc: from the top of the disc plus the gap up
  // one line box. Bottom of the footprint is the disc's own bottom.
  const top = label === undefined ? r : r + LABEL_GAP + LABEL_HEIGHT;
  const hw = label === undefined ? r : Math.max(r, (label.length * GLYPH_WIDTH) / 2);
  return { node, cy: (top - r) / 2, hw, hh: (top + r) / 2, held };
}

/** One separation pass over the label boxes. Returns true if anything moved. */
export function labelNoverlapPass(
  boxes: Box[],
  options: NoverlapOptions = NOVERLAP_DEFAULTS,
): boolean {
  if (boxes.length < 2) return false;

  let cell = 1;
  for (const box of boxes) cell = Math.max(cell, (box.hw + options.margin) * 2, box.hh * 2);

  const grid = new Map<string, Box[]>();
  const keyOf = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
  for (const box of boxes) {
    const key = keyOf(box.node.x ?? 0, (box.node.y ?? 0) - box.cy);
    const bucket = grid.get(key);
    if (bucket) bucket.push(box);
    else grid.set(key, [box]);
  }

  let moved = false;
  for (const box of boxes) {
    const bx = box.node.x ?? 0;
    const by = (box.node.y ?? 0) - box.cy;
    const cx = Math.floor(bx / cell);
    const cyCell = Math.floor(by / cell);
    for (let gx = cx - 1; gx <= cx + 1; gx++) {
      for (let gy = cyCell - 1; gy <= cyCell + 1; gy++) {
        for (const other of grid.get(`${gx},${gy}`) ?? []) {
          // Each unordered pair is handled once, by the node that sorts first.
          if (other === box || other.node.id <= box.node.id) continue;
          if (box.held && other.held) continue;
          const ox = other.node.x ?? 0;
          const oy = (other.node.y ?? 0) - other.cy;
          const gapX = box.hw + other.hw + options.margin - Math.abs(ox - bx);
          const gapY = box.hh + other.hh + options.margin - Math.abs(oy - by);
          if (gapX <= 0 || gapY <= 0) continue;

          // Push along the axis of least penetration, half each, or all onto
          // the free node when the other is pinned where it stands.
          const alongX = gapX < gapY;
          const amount = (alongX ? gapX : gapY) * options.speed;
          let sign = alongX ? Math.sign(ox - bx) : Math.sign(oy - by);
          if (sign === 0) sign = 1;
          const boxShare = other.held ? 1 : box.held ? 0 : 0.5;
          const otherShare = 1 - boxShare;
          if (alongX) {
            box.node.x = bx - sign * amount * boxShare;
            other.node.x = ox + sign * amount * otherShare;
          } else {
            box.node.y = (box.node.y ?? 0) - sign * amount * boxShare;
            other.node.y = (other.node.y ?? 0) + sign * amount * otherShare;
          }
          moved = true;
        }
      }
    }
  }
  return moved;
}

/**
 * Nudge nodes until their visible labels stop overlapping. `labels` maps node
 * id to the text actually drawn for it; nodes without one still take part as
 * plain discs, so a label never lands on an unlabelled neighbour instead.
 * Nodes in `held` do not move, the way pinned nodes hold their spot.
 */
export function labelNoverlap(
  nodes: GraphNode[],
  labels: ReadonlyMap<string, string>,
  held: ReadonlySet<string> = new Set(),
  options: NoverlapOptions = NOVERLAP_DEFAULTS,
  maxPasses = 60,
): number {
  const boxes = nodes.map((n) => boxOf(n, labels.get(n.id), held.has(n.id)));
  for (let pass = 0; pass < maxPasses; pass++) {
    if (!labelNoverlapPass(boxes, options)) return pass;
  }
  return maxPasses;
}
