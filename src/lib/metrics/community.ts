import { undirected, type MetricGraph } from "./model";

/**
 * Louvain modularity maximization: repeatedly move nodes to whichever
 * neighbouring community improves modularity most, then collapse each
 * community into a single node and do it again, until nothing improves.
 *
 * Node order is the index order rather than a shuffle, so the same graph
 * always produces the same communities. That costs a little quality versus
 * randomized restarts and buys reproducible runs, which matters more when the
 * answer becomes a column you filter and style by.
 */

/** A single level of the community hierarchy, self-loops included. */
interface Level {
  n: number;
  /** Neighbours excluding the node itself. */
  neighbors: number[][];
  weights: number[][];
  /** Weight of the node's own self-loop, counted once. */
  selfLoop: Float64Array;
  /** Strength: incident weight, with the self-loop counted twice. */
  k: Float64Array;
  /** Twice the total edge weight. */
  m2: number;
}

export interface LouvainResult {
  /** Community index per node, renumbered so 0 is the largest community. */
  communities: Int32Array;
  communityCount: number;
  /** Modularity of the final partition, in [-0.5, 1]. */
  modularity: number;
}

export const DEFAULT_RESOLUTION = 1;

const MAX_PASSES = 50;
const EPSILON = 1e-12;

export function louvain(graph: MetricGraph, resolution = DEFAULT_RESOLUTION): LouvainResult {
  const base = toLevel(graph);
  if (base.n === 0) return { communities: new Int32Array(0), communityCount: 0, modularity: 0 };
  if (base.m2 === 0) {
    // No edges: every node is its own community and modularity is undefined,
    // reported as 0 rather than NaN.
    return {
      communities: Int32Array.from({ length: base.n }, (_, i) => i),
      communityCount: base.n,
      modularity: 0,
    };
  }

  let level = base;
  // Maps an original node index to its community at the current level.
  let assignment = Int32Array.from({ length: base.n }, (_, i) => i);

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const local = localMoving(level, resolution);
    if (!local.moved) break;

    const renumbered = compact(local.community, level.n);
    for (let v = 0; v < assignment.length; v++) {
      assignment[v] = renumbered.mapping[assignment[v]];
    }
    if (renumbered.count === level.n) break;
    level = aggregate(level, renumbered.mapping, renumbered.count);
  }

  const ordered = orderBySize(assignment, base.n);
  return {
    communities: ordered.communities,
    communityCount: ordered.count,
    modularity: modularity(base, ordered.communities, resolution),
  };
}

function toLevel(graph: MetricGraph): Level {
  const u = undirected(graph);
  const k = new Float64Array(u.n);
  let m2 = 0;
  for (let v = 0; v < u.n; v++) {
    k[v] = u.strength[v];
    m2 += k[v];
  }
  return {
    n: u.n,
    neighbors: u.neighbors,
    weights: u.weights,
    selfLoop: new Float64Array(u.n),
    k,
    m2,
  };
}

/** One local-moving phase; returns the per-node community and whether anything moved. */
function localMoving(level: Level, resolution: number): { community: Int32Array; moved: boolean } {
  const { n, neighbors, weights, k, m2 } = level;
  const community = Int32Array.from({ length: n }, (_, i) => i);
  const sigmaTot = Float64Array.from(k);
  let movedEver = false;

  for (let sweep = 0; sweep < MAX_PASSES; sweep++) {
    let movedThisSweep = false;

    for (let v = 0; v < n; v++) {
      const home = community[v];
      sigmaTot[home] -= k[v];

      // Weight from v into each neighbouring community.
      const toCommunity = new Map<number, number>();
      toCommunity.set(home, 0);
      const nv = neighbors[v];
      const wv = weights[v];
      for (let i = 0; i < nv.length; i++) {
        const c = community[nv[i]];
        toCommunity.set(c, (toCommunity.get(c) ?? 0) + wv[i]);
      }

      let best = home;
      let bestGain = (toCommunity.get(home) ?? 0) - (resolution * sigmaTot[home] * k[v]) / m2;
      for (const [c, weight] of toCommunity) {
        if (c === home) continue;
        const gain = weight - (resolution * sigmaTot[c] * k[v]) / m2;
        if (gain > bestGain + EPSILON) {
          best = c;
          bestGain = gain;
        }
      }

      sigmaTot[best] += k[v];
      community[v] = best;
      if (best !== home) {
        movedThisSweep = true;
        movedEver = true;
      }
    }

    if (!movedThisSweep) break;
  }

  return { community, moved: movedEver };
}

/** Renumber sparse community ids into 0..count-1. */
function compact(community: Int32Array, n: number): { mapping: Int32Array; count: number } {
  const seen = new Map<number, number>();
  const mapping = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    const c = community[v];
    let next = seen.get(c);
    if (next === undefined) {
      next = seen.size;
      seen.set(c, next);
    }
    mapping[v] = next;
  }
  return { mapping, count: seen.size };
}

/** Collapse each community into one node, summing the edge weights between them. */
function aggregate(level: Level, mapping: Int32Array, count: number): Level {
  const merged: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  const selfLoop = new Float64Array(count);

  for (let v = 0; v < level.n; v++) {
    const cv = mapping[v];
    selfLoop[cv] += level.selfLoop[v];
    const nv = level.neighbors[v];
    const wv = level.weights[v];
    for (let i = 0; i < nv.length; i++) {
      const cu = mapping[nv[i]];
      // Each undirected edge is visited from both ends, so halve the internal
      // contribution; cross-community weights are set symmetrically anyway.
      if (cu === cv) selfLoop[cv] += wv[i] / 2;
      else merged[cv].set(cu, (merged[cv].get(cu) ?? 0) + wv[i]);
    }
  }

  const neighbors: number[][] = [];
  const weights: number[][] = [];
  const k = new Float64Array(count);
  let m2 = 0;
  for (let c = 0; c < count; c++) {
    const entries = [...merged[c].entries()];
    neighbors.push(entries.map(([other]) => other));
    weights.push(entries.map(([, w]) => w));
    let strength = 2 * selfLoop[c];
    for (const w of weights[c]) strength += w;
    k[c] = strength;
    m2 += strength;
  }

  return { n: count, neighbors, weights, selfLoop, k, m2 };
}

/** Modularity of a partition, evaluated on the original graph. */
function modularity(level: Level, community: Int32Array, resolution: number): number {
  const { n, neighbors, weights, selfLoop, k, m2 } = level;
  if (m2 === 0) return 0;

  const internal = new Map<number, number>();
  const total = new Map<number, number>();
  for (let v = 0; v < n; v++) {
    const c = community[v];
    total.set(c, (total.get(c) ?? 0) + k[v]);
    let inside = 2 * selfLoop[v];
    const nv = neighbors[v];
    const wv = weights[v];
    for (let i = 0; i < nv.length; i++) {
      if (community[nv[i]] === c) inside += wv[i];
    }
    internal.set(c, (internal.get(c) ?? 0) + inside);
  }

  let q = 0;
  for (const [c, inside] of internal) {
    const tot = total.get(c) ?? 0;
    q += inside / m2 - resolution * (tot / m2) ** 2;
  }
  return q;
}

/** Renumber so community 0 is the largest, which makes the legend read well. */
function orderBySize(community: Int32Array, n: number): { communities: Int32Array; count: number } {
  const sizes = new Map<number, number>();
  for (let v = 0; v < n; v++) sizes.set(community[v], (sizes.get(community[v]) ?? 0) + 1);
  const order = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([c]) => c);
  const rank = new Map(order.map((c, i) => [c, i]));
  const communities = new Int32Array(n);
  for (let v = 0; v < n; v++) communities[v] = rank.get(community[v]) as number;
  return { communities, count: order.length };
}
