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

/**
 * `order` is a permutation of node indices for the first local-moving phase.
 * The canonical run leaves it unset, which is index order, the reproducibility
 * guarantee; the stability estimate below passes seeded shuffles to sample
 * the other local optima the greedy pass could have landed in.
 */
export function louvain(
  graph: MetricGraph,
  resolution = DEFAULT_RESOLUTION,
  order?: ArrayLike<number>,
): LouvainResult {
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
    // The permutation only means anything at the base level, where indices
    // are still nodes; the aggregated levels visit their communities in order.
    const local = localMoving(level, resolution, pass === 0 ? order : undefined);
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

/** How many permuted runs back the stability estimate. */
export const STABILITY_RUNS = 8;

/**
 * How firmly each node belongs where the canonical run put it. Any single
 * Louvain result is one local optimum; this runs the algorithm again under
 * seeded permutations, matches each run's communities onto the canonical
 * partition by best overlap, and reports the share of runs in which the node
 * stayed with its community's match. 1 is settled, low values sit on borders.
 * Deterministic across sessions: the permutations come from a fixed-seed LCG.
 */
export function louvainStability(
  graph: MetricGraph,
  resolution: number,
  canonical: Int32Array,
  runs = STABILITY_RUNS,
): Float64Array {
  const n = graph.ids.length;
  const stable = new Float64Array(n);
  if (n === 0) return stable;
  const random = lcg(0x9e3779b9);

  for (let run = 0; run < runs; run++) {
    const alt = louvain(graph, resolution, permutation(n, random)).communities;
    const match = matchCommunities(alt, canonical);
    for (let v = 0; v < n; v++) {
      if (match.get(alt[v]) === canonical[v]) stable[v] += 1;
    }
  }
  for (let v = 0; v < n; v++) stable[v] /= runs;
  return stable;
}

/**
 * Greedy one-to-one matching of one partition's communities onto another's,
 * largest overlap first. A community with no partner left simply has no
 * match, and every node in it counts as moved.
 */
function matchCommunities(alt: Int32Array, canonical: Int32Array): Map<number, number> {
  const overlaps = new Map<number, Map<number, number>>();
  for (let v = 0; v < alt.length; v++) {
    let row = overlaps.get(alt[v]);
    if (!row) {
      row = new Map();
      overlaps.set(alt[v], row);
    }
    row.set(canonical[v], (row.get(canonical[v]) ?? 0) + 1);
  }

  const pairs: { from: number; to: number; overlap: number }[] = [];
  for (const [from, row] of overlaps) {
    for (const [to, overlap] of row) pairs.push({ from, to, overlap });
  }
  pairs.sort((a, b) => b.overlap - a.overlap || a.from - b.from || a.to - b.to);

  const match = new Map<number, number>();
  const taken = new Set<number>();
  for (const { from, to } of pairs) {
    if (match.has(from) || taken.has(to)) continue;
    match.set(from, to);
    taken.add(to);
  }
  return match;
}

/** Deterministic uniform generator; the seed is part of the contract. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Fisher-Yates with the supplied generator, so shuffles replay exactly. */
function permutation(n: number, random: () => number): Int32Array {
  const order = Int32Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = order[i];
    order[i] = order[j];
    order[j] = swap;
  }
  return order;
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
function localMoving(
  level: Level,
  resolution: number,
  order?: ArrayLike<number>,
): { community: Int32Array; moved: boolean } {
  const { n, neighbors, weights, k, m2 } = level;
  const community = Int32Array.from({ length: n }, (_, i) => i);
  const sigmaTot = Float64Array.from(k);
  let movedEver = false;

  // A permuted run also breaks ties by the permutation, not just the visit
  // order: a bridge tied equally to two communities is exactly the ambiguity
  // the stability estimate exists to expose, and the visit order alone never
  // reaches it, because candidate communities are met in adjacency order.
  // The canonical run has no order and keeps its first-wins tie-break.
  let rank: Int32Array | null = null;
  if (order !== undefined) {
    rank = new Int32Array(n);
    for (let i = 0; i < order.length; i++) rank[order[i]] = i;
  }

  for (let sweep = 0; sweep < MAX_PASSES; sweep++) {
    let movedThisSweep = false;

    for (let at = 0; at < n; at++) {
      const v = order === undefined ? at : order[at];
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
        const tied = rank !== null && Math.abs(gain - bestGain) <= EPSILON && rank[c] < rank[best];
        if (gain > bestGain + EPSILON || tied) {
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
