import type { Graph } from "../types";

/**
 * Classic network measures. Everything here treats edges as undirected and
 * unweighted, which matches how these statistics are usually reported.
 * Path-based measures sample BFS sources on very large graphs and are
 * flagged as approximate.
 */

const SAMPLE_LIMIT = 600;
/** Local clustering is skipped for hubs above this degree to stay O(n·k²)-safe. */
const CLUSTERING_DEGREE_CAP = 300;

interface Adjacency {
  ids: string[];
  index: Map<string, number>;
  /** Unique undirected neighbors per node. */
  neighbors: number[][];
  sets: Set<number>[];
}

function undirectedAdjacency(graph: Graph): Adjacency {
  const ids = graph.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const sets: Set<number>[] = ids.map(() => new Set<number>());
  for (const l of graph.links) {
    const s = index.get(typeof l.source === "string" ? l.source : l.source.id);
    const t = index.get(typeof l.target === "string" ? l.target : l.target.id);
    if (s === undefined || t === undefined || s === t) continue;
    sets[s].add(t);
    sets[t].add(s);
  }
  return { ids, index, neighbors: sets.map((s) => [...s]), sets };
}

function bfsDistances(neighbors: number[][], source: number, dist: Int32Array): void {
  dist.fill(-1);
  dist[source] = 0;
  const queue = [source];
  let head = 0;
  while (head < queue.length) {
    const v = queue[head++];
    for (const w of neighbors[v]) {
      if (dist[w] === -1) {
        dist[w] = dist[v] + 1;
        queue.push(w);
      }
    }
  }
}

function sampleSources(n: number): number[] {
  if (n <= SAMPLE_LIMIT) return Array.from({ length: n }, (_, i) => i);
  const stride = Math.ceil(n / SAMPLE_LIMIT);
  const sources: number[] = [];
  for (let i = 0; i < n; i += stride) sources.push(i);
  return sources;
}

export interface NetworkMetrics {
  /** Directed density: edges / possible ordered pairs. */
  density: number | null;
  /** Longest shortest path between any two connected nodes. */
  diameter: number | null;
  /** Mean shortest-path length over reachable pairs. */
  avgPathLength: number | null;
  /** Mean local clustering coefficient over nodes with 2+ neighbors. */
  clustering: number | null;
  /** True when path measures were estimated from sampled BFS sources. */
  approximate: boolean;
}

export function networkMetrics(graph: Graph): NetworkMetrics {
  const n = graph.nodes.length;
  if (n === 0) {
    return {
      density: null,
      diameter: null,
      avgPathLength: null,
      clustering: null,
      approximate: false,
    };
  }
  const density = n > 1 ? graph.links.length / (n * (n - 1)) : null;
  const { neighbors, sets } = undirectedAdjacency(graph);

  let clusterSum = 0;
  let clusterCount = 0;
  for (let v = 0; v < n; v++) {
    const nv = neighbors[v];
    const k = nv.length;
    if (k < 2 || k > CLUSTERING_DEGREE_CAP) continue;
    let closed = 0;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        if (sets[nv[i]].has(nv[j])) closed++;
      }
    }
    clusterSum += (2 * closed) / (k * (k - 1));
    clusterCount++;
  }

  const sources = sampleSources(n);
  const dist = new Int32Array(n);
  let diameter = 0;
  let pathSum = 0;
  let pathCount = 0;
  for (const s of sources) {
    bfsDistances(neighbors, s, dist);
    for (let v = 0; v < n; v++) {
      const d = dist[v];
      if (d > 0) {
        if (d > diameter) diameter = d;
        pathSum += d;
        pathCount++;
      }
    }
  }

  return {
    density,
    diameter: pathCount > 0 ? diameter : null,
    avgPathLength: pathCount > 0 ? pathSum / pathCount : null,
    clustering: clusterCount > 0 ? clusterSum / clusterCount : null,
    approximate: n > SAMPLE_LIMIT,
  };
}

export type CentralityKind = "degree" | "betweenness" | "closeness" | "eigenvector";

export const CENTRALITY_NAMES: Record<CentralityKind, string> = {
  degree: "Degree",
  betweenness: "Betweenness",
  closeness: "Closeness",
  eigenvector: "Eigenvector",
};

/** Per-node centrality scores, keyed by node id. */
export function centralityValues(graph: Graph, kind: CentralityKind): Map<string, number> {
  if (kind === "degree") return new Map(graph.nodes.map((n) => [n.id, n.degree]));
  const adjacency = undirectedAdjacency(graph);
  const n = adjacency.ids.length;
  if (n === 0) return new Map();
  let scores: Float64Array;
  if (kind === "betweenness") {
    scores = betweenness(adjacency.neighbors, n);
  } else if (kind === "closeness") {
    scores = closeness(adjacency.neighbors, n);
  } else {
    scores = eigenvector(adjacency.neighbors, n);
  }
  return new Map(adjacency.ids.map((id, i) => [id, scores[i]]));
}

/** Brandes' algorithm, normalized to [0, 1]; sampled on very large graphs. */
function betweenness(neighbors: number[][], n: number): Float64Array {
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
function closeness(neighbors: number[][], n: number): Float64Array {
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

/** Power iteration on the undirected adjacency matrix, scaled to max = 1. */
function eigenvector(neighbors: number[][], n: number): Float64Array {
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
