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
 * both. Path-based measures sample their BFS sources on very large graphs.
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

  for (const s of sources) {
    const stack: number[] = [];
    const pred: number[][] = Array.from({ length: n }, () => []);
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

/** Closeness with the Wasserman-Faust correction for disconnected graphs. */
export function closeness(u: Undirected): Float64Array {
  const { n, neighbors } = u;
  const scores = new Float64Array(n);
  const dist = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    bfsDistances(neighbors, v, dist);
    let sum = 0;
    let reachable = 0;
    for (let w = 0; w < n; w++) {
      if (dist[w] > 0) {
        sum += dist[w];
        reachable++;
      }
    }
    scores[v] = sum > 0 && n > 1 ? (reachable / (n - 1)) * (reachable / sum) : 0;
  }
  return scores;
}

/**
 * Harmonic closeness: the sum of reciprocal distances, which needs no
 * correction because unreachable nodes simply contribute nothing.
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
  const max = Math.max(...x);
  if (max > 0) {
    for (let i = 0; i < n; i++) x[i] /= max;
  }
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
  const nextHubs = new Float64Array(n);
  const nextAuthorities = new Float64Array(n);

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
    hubs = Float64Array.from(nextHubs);
    authorities = Float64Array.from(nextAuthorities);
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
