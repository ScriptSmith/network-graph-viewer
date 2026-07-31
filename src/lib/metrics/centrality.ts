import {
  bfsDistances,
  directed,
  sampleSources,
  undirected,
  type MetricGraph,
  type Undirected,
} from "./model";

/**
 * Per-node importance measures. The four classic ones treat edges as
 * undirected and unweighted, which is how they are normally reported;
 * PageRank and HITS are directed, because direction is the whole point of
 * both.
 *
 * Betweenness and closeness sample their BFS sources above `SAMPLE_LIMIT`,
 * because both are means over pairs and a sample estimates a mean well.
 * Harmonic closeness does not, for the reason given on it.
 */

/** Number of incident edges, ignoring direction. */
export function degree(u: Undirected): Float64Array {
  const scores = new Float64Array(u.n);
  for (let v = 0; v < u.n; v++) scores[v] = u.neighbors[v].length;
  return scores;
}

/** Brandes' algorithm, normalized to [0, 1]; sampled on very large graphs. */
export function betweenness(u: Undirected): Float64Array {
  const { n, neighbors } = u;
  const bc = new Float64Array(n);
  const sources = sampleSources(n);
  const sigma = new Float64Array(n);
  const dist = new Int32Array(n);
  const delta = new Float64Array(n);
  // Allocated once and emptied per source: rebuilding n arrays for each of up
  // to `SAMPLE_LIMIT` sources is the same work again in the garbage collector.
  const pred: number[][] = Array.from({ length: n }, () => []);

  for (const s of sources) {
    const stack: number[] = [];
    for (let i = 0; i < n; i++) pred[i].length = 0;
    sigma.fill(0);
    sigma[s] = 1;
    dist.fill(-1);
    dist[s] = 0;
    const queue = [s];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      stack.push(v);
      for (const w of neighbors[v]) {
        if (dist[w] === -1) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          pred[w].push(v);
        }
      }
    }
    delta.fill(0);
    for (let i = stack.length - 1; i >= 0; i--) {
      const w = stack[i];
      for (const v of pred[w]) {
        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      }
      if (w !== s) bc[w] += delta[w];
    }
  }

  // Each undirected pair is counted twice over all sources; scale samples up,
  // then normalize by the number of possible pairs excluding the node itself.
  const scale = (n / sources.length / 2) * (n > 2 ? 2 / ((n - 1) * (n - 2)) : 0);
  for (let i = 0; i < n; i++) bc[i] *= scale;
  return bc;
}

/**
 * Closeness with the Wasserman-Faust correction for disconnected graphs: the
 * share of the graph a node can reach, over the mean distance it takes to get
 * there, so a node marooned on a small island does not outscore a well-placed
 * one in the giant component. Sampled on very large graphs.
 *
 * Sampling works here because both halves of the formula are means, and a mean
 * is what a sample estimates well. It is also why the loop is inside out from
 * the obvious reading: one BFS per node would be O(n(n+m)) and would leave the
 * unsampled nodes with no answer at all. This runs on the undirected view,
 * where distance is symmetric, so a single BFS from `s` reports `d(s, w)` and
 * `d(w, s)` at once and every node learns something from every source.
 *
 * `denom` is how many sampled sources were candidates for a given node: the
 * sample size, less the node itself where it was one of them. That is what
 * makes the unsampled case the textbook formula exactly rather than an estimate
 * that merely converges on it.
 */
export function closeness(u: Undirected): Float64Array {
  const { n, neighbors } = u;
  const sources = sampleSources(n);
  const sum = new Float64Array(n);
  const reached = new Float64Array(n);
  const denom = new Float64Array(n).fill(sources.length);
  const dist = new Int32Array(n);

  for (const s of sources) {
    bfsDistances(neighbors, s, dist);
    denom[s] -= 1;
    for (let w = 0; w < n; w++) {
      if (dist[w] > 0) {
        sum[w] += dist[w];
        reached[w] += 1;
      }
    }
  }

  const scores = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    if (sum[v] <= 0 || denom[v] <= 0) continue;
    scores[v] = (reached[v] / denom[v]) * (reached[v] / sum[v]);
  }
  return scores;
}

/**
 * Harmonic closeness: the sum of reciprocal distances, which needs no
 * correction because unreachable nodes simply contribute nothing.
 *
 * Exact, and deliberately not sampled the way `closeness` above is. The whole
 * character of this measure is that it weights near neighbours heavily, and a
 * sample of a few hundred sources reaches a vanishing share of any one node's
 * near neighbourhood as the graph grows: measured on a large ring the estimate
 * came out more than twice the true value, whatever the sampler. Approximating
 * away the near neighbours is approximating away the measure. So this one is
 * O(n(n+m)) on purpose, and belongs in the worker rather than on a render path.
 */
export function harmonic(u: Undirected): Float64Array {
  const { n, neighbors } = u;
  const scores = new Float64Array(n);
  const dist = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    bfsDistances(neighbors, v, dist);
    let sum = 0;
    for (let w = 0; w < n; w++) {
      if (dist[w] > 0) sum += 1 / dist[w];
    }
    scores[v] = n > 1 ? sum / (n - 1) : 0;
  }
  return scores;
}

/** Power iteration on the undirected adjacency matrix, scaled to max = 1. */
export function eigenvector(u: Undirected): Float64Array {
  const { n, neighbors } = u;
  let x = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);
  for (let iter = 0; iter < 100; iter++) {
    next.fill(0);
    for (let v = 0; v < n; v++) {
      for (const w of neighbors[v]) next[w] += x[v];
    }
    let norm = 0;
    for (let i = 0; i < n; i++) norm += next[i] * next[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return next;
    let diff = 0;
    for (let i = 0; i < n; i++) {
      next[i] /= norm;
      diff += Math.abs(next[i] - x[i]);
    }
    [x, next] = [next, x];
    if (diff < 1e-7) break;
  }
  scaleToMax(x);
  return x;
}

export const PAGERANK_DAMPING = 0.85;

/**
 * PageRank over the directed, weighted graph. Nodes with no outgoing edges
 * would otherwise leak rank out of the system, so their mass is redistributed
 * uniformly each iteration; the result sums to 1.
 */
export function pagerank(graph: MetricGraph, damping = PAGERANK_DAMPING): Float64Array {
  const d = directed(graph);
  const n = d.n;
  if (n === 0) return new Float64Array(0);

  let rank = new Float64Array(n).fill(1 / n);
  let next = new Float64Array(n);

  for (let iter = 0; iter < 100; iter++) {
    next.fill(0);
    let dangling = 0;
    for (let v = 0; v < n; v++) {
      if (d.outStrength[v] === 0) {
        dangling += rank[v];
        continue;
      }
      const targets = d.out[v];
      const weights = d.outWeight[v];
      for (let i = 0; i < targets.length; i++) {
        next[targets[i]] += (rank[v] * weights[i]) / d.outStrength[v];
      }
    }

    const teleport = (1 - damping) / n + (damping * dangling) / n;
    let diff = 0;
    for (let v = 0; v < n; v++) {
      const value = teleport + damping * next[v];
      diff += Math.abs(value - rank[v]);
      next[v] = value;
    }
    [rank, next] = [next, rank];
    if (diff < 1e-9) break;
  }
  return rank;
}

export interface Hits {
  hubs: Float64Array;
  authorities: Float64Array;
}

/**
 * HITS: a good hub points at good authorities, a good authority is pointed at
 * by good hubs. Both vectors are scaled so the largest score is 1, which makes
 * them readable next to each other. Only meaningful on directed data; on a
 * fully reciprocal graph both collapse to eigenvector centrality.
 */
export function hits(graph: MetricGraph): Hits {
  const d = directed(graph);
  const n = d.n;
  let hubs = new Float64Array(n).fill(1);
  let authorities = new Float64Array(n).fill(1);
  let nextHubs = new Float64Array(n);
  let nextAuthorities = new Float64Array(n);

  for (let iter = 0; iter < 100; iter++) {
    nextAuthorities.fill(0);
    for (let v = 0; v < n; v++) {
      const targets = d.out[v];
      const weights = d.outWeight[v];
      for (let i = 0; i < targets.length; i++) nextAuthorities[targets[i]] += hubs[v] * weights[i];
    }
    nextHubs.fill(0);
    for (let v = 0; v < n; v++) {
      const targets = d.out[v];
      const weights = d.outWeight[v];
      for (let i = 0; i < targets.length; i++)
        nextHubs[v] += nextAuthorities[targets[i]] * weights[i];
    }

    normalizeL2(nextAuthorities);
    normalizeL2(nextHubs);
    let diff = 0;
    for (let v = 0; v < n; v++) {
      diff += Math.abs(nextHubs[v] - hubs[v]) + Math.abs(nextAuthorities[v] - authorities[v]);
    }
    // Swapped rather than copied, the way `pagerank` above does it: the old
    // vectors are about to be overwritten anyway.
    [hubs, nextHubs] = [nextHubs, hubs];
    [authorities, nextAuthorities] = [nextAuthorities, authorities];
    if (diff < 1e-9) break;
  }

  scaleToMax(hubs);
  scaleToMax(authorities);
  return { hubs, authorities };
}

function normalizeL2(v: Float64Array): void {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
}

function scaleToMax(v: Float64Array): void {
  let max = 0;
  for (let i = 0; i < v.length; i++) max = Math.max(max, v[i]);
  if (max === 0) return;
  for (let i = 0; i < v.length; i++) v[i] /= max;
}

export type CentralityKind =
  | "degree"
  | "betweenness"
  | "closeness"
  | "eigenvector"
  | "harmonic"
  | "pagerank";

export const CENTRALITY_NAMES: Record<CentralityKind, string> = {
  degree: "Degree",
  betweenness: "Betweenness",
  closeness: "Closeness",
  eigenvector: "Eigenvector",
  harmonic: "Harmonic closeness",
  pagerank: "PageRank",
};

/** Per-node centrality scores over the metric graph. */
export function centrality(graph: MetricGraph, kind: CentralityKind): Float64Array {
  if (kind === "pagerank") return pagerank(graph);
  const u = undirected(graph);
  switch (kind) {
    case "degree":
      return degree(u);
    case "betweenness":
      return betweenness(u);
    case "closeness":
      return closeness(u);
    case "harmonic":
      return harmonic(u);
    case "eigenvector":
      return eigenvector(u);
  }
}
