import { quadtree, type Quadtree } from "d3-quadtree";
import type { GraphLink, GraphNode } from "../../types";
import { asNumber } from "../parse";

/**
 * ForceAtlas2 as a d3 force, so it shares the one simulation the canvas
 * already runs and layout switches keep animating as morphs.
 *
 * The model, from Jacomy et al. (2014): every node repels every other in
 * proportion to the product of their masses over their distance, edges pull
 * their endpoints together, and gravity keeps disconnected pieces from
 * drifting off. Mass is degree + 1, so hubs push harder and end up ringed by
 * their neighbours instead of buried under them — the reason FA2 reads better
 * than a plain spring layout on real networks.
 *
 * Repulsion is the expensive part, so it goes through a Barnes-Hut quadtree:
 * a distant clump of nodes is treated as one body at its centre of mass.
 *
 * The forces alone are not a layout. Attraction grows with distance and a hub
 * feels one pull per edge, so on a graph with any real hub the step a plain
 * integrator takes overshoots, and the next step overshoots further: nodes
 * leave for infinity within a dozen ticks. FA2's answer is the adaptive speed
 * below, which watches how much of the movement is a node swinging back and
 * forth rather than travelling somewhere, and scales the step down until it
 * isn't. That is what keeps the layout stable, so it is not optional.
 */

export interface ForceAtlas2Params {
  /**
   * Repulsion strength. Attraction grows with distance and repulsion falls off
   * with it, so two nodes settle where the two balance: at roughly
   * `sqrt(scaling x mass1 x mass2)` apart. The default lands a typical pair
   * about 90 units apart, which suits the canvas's scale and node radii.
   */
  scaling: number;
  /** Pull toward the origin, which keeps islands from escaping. */
  gravity: number;
  /** Gravity that grows with distance rather than staying constant. */
  strongGravity: boolean;
  /** Logarithmic attraction: tightens clusters, separates them further. */
  linLog: boolean;
  /** How much edge weight matters, 0 (not at all) to 2. */
  edgeWeightInfluence: number;
}

export const FORCE_ATLAS_2_DEFAULTS: ForceAtlas2Params = {
  scaling: 300,
  gravity: 1,
  strongGravity: false,
  linLog: false,
  edgeWeightInfluence: 1,
};

/** Barnes-Hut opening angle: bigger is faster and coarser. */
const THETA = 1.2;

/** How much swinging the speed controller puts up with before it slows down. */
const JITTER_TOLERANCE = 1;
/** Floor on the efficiency term, so a bad patch can't stall the layout. */
const MIN_SPEED_EFFICIENCY = 0.05;
/** Speed may rise by half per tick at most; faster and it oscillates again. */
const MAX_RISE = 0.5;

interface MassQuad {
  value?: number;
  x?: number;
  y?: number;
  data?: GraphNode;
  next?: MassQuad;
  length?: number;
  0?: MassQuad;
  1?: MassQuad;
  2?: MassQuad;
  3?: MassQuad;
}

export interface ForceAtlas2 {
  (alpha: number): void;
  initialize(nodes: GraphNode[]): void;
}

export function forceAtlas2(
  links: GraphLink[],
  params: ForceAtlas2Params,
  weightColumn: string | null,
): ForceAtlas2 {
  let nodes: GraphNode[] = [];
  let mass = new Float64Array(0);
  const index = new Map<string, number>();

  // This tick's force per node, and the last tick's, which is what tells a
  // node travelling from one swinging in place.
  let fx = new Float64Array(0);
  let fy = new Float64Array(0);
  let lastFx = new Float64Array(0);
  let lastFy = new Float64Array(0);
  let swing = new Float64Array(0);

  let speed = 1;
  let speedEfficiency = 1;

  const theta2 = THETA * THETA;

  const linkWeight = (link: GraphLink): number => {
    if (!weightColumn) return 1;
    let sum = 0;
    let seen = 0;
    for (const row of link.rows) {
      const v = asNumber(row[weightColumn]);
      if (v !== null) {
        sum += v;
        seen++;
      }
    }
    return seen === 0 ? 1 : Math.max(0, sum / seen);
  };

  function accumulate(quad: MassQuad): void {
    let strength = 0;
    if (quad.length) {
      let x = 0;
      let y = 0;
      for (let i = 0; i < 4; i++) {
        const child = quad[i as 0 | 1 | 2 | 3];
        const value = child?.value;
        if (child && value) {
          strength += value;
          x += value * (child.x as number);
          y += value * (child.y as number);
        }
      }
      quad.x = x / strength;
      quad.y = y / strength;
    } else {
      let leaf: MassQuad | undefined = quad;
      quad.x = quad.data?.x ?? 0;
      quad.y = quad.data?.y ?? 0;
      while (leaf) {
        const node = leaf.data;
        if (node) strength += mass[index.get(node.id) ?? 0];
        leaf = leaf.next;
      }
    }
    quad.value = strength;
  }

  function repel(tree: Quadtree<GraphNode>, node: GraphNode, i: number): void {
    const myMass = mass[i];
    tree.visit((raw, x0, _y0, x1) => {
      const quad = raw as unknown as MassQuad;
      if (!quad.value) return true;

      const dx = (quad.x as number) - (node.x ?? 0);
      const dy = (quad.y as number) - (node.y ?? 0);
      const width = x1 - x0;
      const l = dx * dx + dy * dy;

      // Far enough that the whole cell can act as one body.
      if ((width * width) / theta2 < l) {
        if (l > 0) {
          const factor = (params.scaling * myMass * quad.value) / l;
          fx[i] -= dx * factor;
          fy[i] -= dy * factor;
        }
        return true;
      }

      if (quad.length) return false;

      let leaf: MassQuad | undefined = quad;
      while (leaf) {
        const other = leaf.data;
        if (other && other !== node) {
          const ox = (other.x ?? 0) - (node.x ?? 0);
          const oy = (other.y ?? 0) - (node.y ?? 0);
          const ol = ox * ox + oy * oy;
          if (ol > 0) {
            const otherMass = mass[index.get(other.id) ?? 0];
            const factor = (params.scaling * myMass * otherMass) / ol;
            fx[i] -= ox * factor;
            fy[i] -= oy * factor;
          }
        }
        leaf = leaf.next;
      }
      return true;
    });
  }

  /**
   * The speed controller from section 2.3 of the paper. Swinging is movement
   * that reverses, traction is movement that goes somewhere; the layout is
   * allowed to move faster only while the second outweighs the first.
   */
  function adaptSpeed(): void {
    let totalSwing = 0;
    let totalTraction = 0;
    for (let i = 0; i < nodes.length; i++) {
      const m = mass[i];
      swing[i] = m * Math.hypot(fx[i] - lastFx[i], fy[i] - lastFy[i]);
      totalSwing += swing[i];
      totalTraction += m * 0.5 * Math.hypot(fx[i] + lastFx[i], fy[i] + lastFy[i]);
    }
    // Settled: every force is holding still, so leave the speed where it is.
    if (totalSwing <= 0 || totalTraction <= 0) return;

    const estimate = 0.05 * Math.sqrt(nodes.length);
    let tolerance =
      JITTER_TOLERANCE *
      Math.max(
        Math.sqrt(estimate),
        Math.min(10, (estimate * totalTraction) / (nodes.length * nodes.length)),
      );

    if (totalSwing / totalTraction > 2) {
      if (speedEfficiency > MIN_SPEED_EFFICIENCY) speedEfficiency *= 0.5;
      tolerance = Math.max(tolerance, JITTER_TOLERANCE);
    }

    const target = (tolerance * speedEfficiency * totalTraction) / totalSwing;
    if (totalSwing > tolerance * totalTraction) {
      if (speedEfficiency > MIN_SPEED_EFFICIENCY) speedEfficiency *= 0.7;
    } else if (speed < 1000) {
      speedEfficiency *= 1.3;
    }
    speed += Math.min(target - speed, MAX_RISE * speed);
  }

  const force = ((alpha: number) => {
    if (nodes.length === 0) return;

    const tree = quadtree(
      nodes,
      (d) => d.x ?? 0,
      (d) => d.y ?? 0,
    ).visitAfter((quad) => accumulate(quad as unknown as MassQuad));

    fx.fill(0);
    fy.fill(0);

    for (let i = 0; i < nodes.length; i++) repel(tree, nodes[i], i);

    for (const link of links) {
      const source = link.source as GraphNode;
      const target = link.target as GraphNode;
      if (typeof source === "string" || typeof target === "string") continue;
      const si = index.get(source.id);
      const ti = index.get(target.id);
      if (si === undefined || ti === undefined) continue;
      const dx = (target.x ?? 0) - (source.x ?? 0);
      const dy = (target.y ?? 0) - (source.y ?? 0);
      const d = Math.hypot(dx, dy);
      if (d === 0) continue;
      const weight = linkWeight(link) ** params.edgeWeightInfluence;
      const factor = params.linLog ? (weight * Math.log(1 + d)) / d : weight;
      fx[si] += dx * factor;
      fy[si] += dy * factor;
      fx[ti] -= dx * factor;
      fy[ti] -= dy * factor;
    }

    for (let i = 0; i < nodes.length; i++) {
      const x = nodes[i].x ?? 0;
      const y = nodes[i].y ?? 0;
      const d = Math.hypot(x, y);
      if (d === 0) continue;
      const factor = params.strongGravity
        ? params.gravity * mass[i]
        : (params.gravity * mass[i]) / d;
      fx[i] -= x * factor;
      fy[i] -= y * factor;
    }

    adaptSpeed();

    // The step, not the force, is what moves a node: a node that is swinging
    // takes a short one however hard it is being pushed. Velocity is set
    // rather than added because FA2 carries no momentum between ticks — the
    // momentum is what turned the overshoot into an explosion.
    for (let i = 0; i < nodes.length; i++) {
      const step = (alpha * speed) / (1 + Math.sqrt(speed * swing[i]));
      nodes[i].vx = fx[i] * step;
      nodes[i].vy = fy[i] * step;
      lastFx[i] = fx[i];
      lastFy[i] = fy[i];
    }
  }) as ForceAtlas2;

  force.initialize = (next: GraphNode[]) => {
    nodes = next;
    index.clear();
    nodes.forEach((n, i) => index.set(n.id, i));
    mass = new Float64Array(nodes.length);
    // Mass is degree + 1: a hub pushes proportionally harder than a leaf,
    // which is what stops hubs from sitting on top of their neighbours.
    nodes.forEach((n, i) => {
      mass[i] = n.degree + 1;
    });
    fx = new Float64Array(nodes.length);
    fy = new Float64Array(nodes.length);
    lastFx = new Float64Array(nodes.length);
    lastFy = new Float64Array(nodes.length);
    swing = new Float64Array(nodes.length);
    speed = 1;
    speedEfficiency = 1;
  };

  return force;
}
