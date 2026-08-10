import type { BaseGraph, GraphNode, Row } from "../../types";
import { nodeIndex } from "../graphIndex";
import { asNumber } from "../parse";

/**
 * The compact graph every algorithm in this folder works on: node ids plus
 * parallel endpoint and weight arrays. Typed arrays keep it cheap to hand to
 * a worker, and nothing here holds a reference to a spreadsheet row.
 */
export interface MetricGraph {
  ids: string[];
  source: Int32Array;
  target: Int32Array;
  weight: Float64Array;
}

const endpoint = (e: string | GraphNode): string => (typeof e === "string" ? e : e.id);

/**
 * Project a built graph into the metric form. Weights come from the mean of a
 * numeric column over the rows behind each link, defaulting to 1.
 */
export function toMetricGraph(graph: BaseGraph, weightColumn: string | null = null): MetricGraph {
  // The ids and their lookup come from the graph's own index rather than being
  // derived again here; this is the same interning the ego walk and the
  // component count use, and only the weights depend on the column asked for.
  const { ids, index } = nodeIndex(graph);

  const source = new Int32Array(graph.links.length);
  const target = new Int32Array(graph.links.length);
  const weight = new Float64Array(graph.links.length);

  let kept = 0;
  for (const link of graph.links) {
    const s = index.get(endpoint(link.source));
    const t = index.get(endpoint(link.target));
    if (s === undefined || t === undefined) continue;
    source[kept] = s;
    target[kept] = t;
    weight[kept] = linkWeight(link.rows, weightColumn);
    kept++;
  }

  return {
    ids,
    source: source.slice(0, kept),
    target: target.slice(0, kept),
    weight: weight.slice(0, kept),
  };
}

function linkWeight(rows: Row[], column: string | null): number {
  if (column === null) return 1;
  let sum = 0;
  let seen = 0;
  for (const row of rows) {
    const v = asNumber(row[column]);
    if (v !== null) {
      sum += v;
      seen++;
    }
  }
  // A link whose rows carry no usable number still exists, so it weighs 1.
  return seen === 0 ? 1 : Math.max(0, sum / seen);
}

/**
 * Undirected view with parallel and reciprocal edges merged into one weighted
 * neighbour entry, which is what the classic measures assume.
 */
export interface Undirected {
  n: number;
  neighbors: number[][];
  weights: number[][];
  sets: Set<number>[];
  /** Sum of incident edge weights per node. */
  strength: Float64Array;
  /** Total undirected edge weight, the `m` in the modularity formula. */
  totalWeight: number;
}

/**
 * The views and the id lookup, held against the metric graph that produced
 * them.
 *
 * These sit below the incidence index rather than on it: they are built from
 * `source`/`target`, which is what a `MetricGraph` is, and it can arrive in a
 * worker with no `BaseGraph` anywhere near it. A compute run asks several
 * measures of one graph and most of them want the same undirected view, so
 * memoizing here is what stops each one rebuilding it. Every consumer treats
 * these as read-only, which is what makes sharing them safe.
 */
const undirectedViews = new WeakMap<MetricGraph, Undirected>();
const directedViews = new WeakMap<MetricGraph, Directed>();
const idIndexes = new WeakMap<MetricGraph, Map<string, number>>();

/** Where an id sits in `graph.ids`, or -1. Was a linear scan at every call. */
export function indexOfId(graph: MetricGraph, id: string): number {
  let index = idIndexes.get(graph);
  if (index === undefined) {
    index = new Map();
    for (let i = 0; i < graph.ids.length; i++) index.set(graph.ids[i], i);
    idIndexes.set(graph, index);
  }
  return index.get(id) ?? -1;
}

export function undirected(graph: MetricGraph): Undirected {
  const cached = undirectedViews.get(graph);
  if (cached !== undefined) return cached;
  const built = buildUndirected(graph);
  undirectedViews.set(graph, built);
  return built;
}

function buildUndirected(graph: MetricGraph): Undirected {
  const n = graph.ids.length;
  const merged: Map<number, number>[] = Array.from({ length: n }, () => new Map());

  for (let e = 0; e < graph.source.length; e++) {
    const s = graph.source[e];
    const t = graph.target[e];
    if (s === t) continue;
    const w = graph.weight[e];
    merged[s].set(t, (merged[s].get(t) ?? 0) + w);
    merged[t].set(s, (merged[t].get(s) ?? 0) + w);
  }

  const neighbors: number[][] = [];
  const weights: number[][] = [];
  const sets: Set<number>[] = [];
  const strength = new Float64Array(n);
  let totalWeight = 0;

  for (let v = 0; v < n; v++) {
    const entries = [...merged[v].entries()];
    neighbors.push(entries.map(([w]) => w));
    weights.push(entries.map(([, w]) => w));
    sets.push(new Set(neighbors[v]));
    for (const w of weights[v]) {
      strength[v] += w;
      totalWeight += w;
    }
  }

  return { n, neighbors, weights, sets, strength, totalWeight: totalWeight / 2 };
}

/** Directed view, used by the measures where edge direction is the point. */
export interface Directed {
  n: number;
  out: number[][];
  in: number[][];
  outWeight: number[][];
  inWeight: number[][];
  /** Sum of outgoing weights per node. */
  outStrength: Float64Array;
}

export function directed(graph: MetricGraph): Directed {
  const cached = directedViews.get(graph);
  if (cached !== undefined) return cached;
  const built = buildDirected(graph);
  directedViews.set(graph, built);
  return built;
}

function buildDirected(graph: MetricGraph): Directed {
  const n = graph.ids.length;
  const out: number[][] = Array.from({ length: n }, () => []);
  const inn: number[][] = Array.from({ length: n }, () => []);
  const outWeight: number[][] = Array.from({ length: n }, () => []);
  const inWeight: number[][] = Array.from({ length: n }, () => []);
  const outStrength = new Float64Array(n);

  for (let e = 0; e < graph.source.length; e++) {
    const s = graph.source[e];
    const t = graph.target[e];
    if (s === t) continue;
    const w = graph.weight[e];
    out[s].push(t);
    outWeight[s].push(w);
    inn[t].push(s);
    inWeight[t].push(w);
    outStrength[s] += w;
  }

  return { n, out, in: inn, outWeight, inWeight, outStrength };
}

/** Breadth-first distances from one source over an undirected neighbour list. */
export function bfsDistances(neighbors: number[][], source: number, dist: Int32Array): void {
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

export interface RouteInfo {
  /** Equally short routes, endpoints included, up to the asked-for limit. */
  routes: string[][];
  /** How many such routes exist in all, which can exceed what was listed. */
  count: number;
}

/**
 * The shortest routes by hops between two named nodes, or null when the two
 * cannot reach each other. Undirected by default, matching the rest of the
 * path measures; `directed` walks only along the arrows. Counting every
 * route is the sigma accumulation betweenness uses; listing them is a walk
 * back through the shortest-path DAG, cut off at `limit` because the count
 * can be astronomical while a person only ever wants a handful. Parallel
 * edges collapse into one neighbour and change nothing; a node's route to
 * itself is itself alone.
 */
export function shortestRoutes(
  graph: MetricGraph,
  from: string,
  to: string,
  options: { directed?: boolean; limit?: number } = {},
): RouteInfo | null {
  const limit = Math.max(1, options.limit ?? 1);
  const source = indexOfId(graph, from);
  const target = indexOfId(graph, to);
  if (source === -1 || target === -1) return null;
  if (source === target) return { routes: [[from]], count: 1 };

  let neighbors: number[][];
  if (options.directed === true) {
    const n = graph.ids.length;
    const out: number[][] = Array.from({ length: n }, () => []);
    for (let e = 0; e < graph.source.length; e++) {
      if (graph.source[e] !== graph.target[e]) out[graph.source[e]].push(graph.target[e]);
    }
    neighbors = out;
  } else {
    neighbors = undirected(graph).neighbors;
  }

  const n = graph.ids.length;
  const dist = new Int32Array(n).fill(-1);
  const sigma = new Float64Array(n);
  const preds: number[][] = Array.from({ length: n }, () => []);
  dist[source] = 0;
  sigma[source] = 1;
  const queue = [source];
  let head = 0;
  let targetDist = -1;
  while (head < queue.length) {
    const v = queue[head++];
    // Nothing past the target's depth can sit on a shortest route to it.
    if (targetDist !== -1 && dist[v] >= targetDist) continue;
    for (const w of neighbors[v]) {
      if (dist[w] === -1) {
        dist[w] = dist[v] + 1;
        queue.push(w);
        if (w === target) targetDist = dist[w];
      }
      if (dist[w] === dist[v] + 1) {
        sigma[w] += sigma[v];
        preds[w].push(v);
      }
    }
  }
  if (dist[target] === -1) return null;

  // Depth-first back through the predecessors, in the deterministic order
  // the adjacency gave them, until enough routes are in hand.
  const routes: string[][] = [];
  const trail: number[] = [target];
  const walk = (v: number): boolean => {
    if (v === source) {
      routes.push([...trail].reverse().map((i) => graph.ids[i]));
      return routes.length >= limit;
    }
    for (const p of preds[v]) {
      trail.push(p);
      const done = walk(p);
      trail.pop();
      if (done) return true;
    }
    return false;
  };
  walk(target);

  return { routes, count: sigma[target] };
}

/** One route plus the count: the shape the tests pin. */
export function shortestPathInfo(
  graph: MetricGraph,
  from: string,
  to: string,
  options: { directed?: boolean } = {},
): { path: string[]; count: number } | null {
  const info = shortestRoutes(graph, from, to, { ...options, limit: 1 });
  return info === null ? null : { path: info.routes[0], count: info.count };
}

/** Just the route, undirected: the shape most callers and tests want. */
export function shortestPath(graph: MetricGraph, from: string, to: string): string[] | null {
  return shortestPathInfo(graph, from, to)?.path ?? null;
}

/** Path measures sample their sources above this many nodes. */
export const SAMPLE_LIMIT = 600;

export function sampleSources(n: number): number[] {
  if (n <= SAMPLE_LIMIT) return Array.from({ length: n }, (_, i) => i);
  const stride = Math.ceil(n / SAMPLE_LIMIT);
  const sources: number[] = [];
  for (let i = 0; i < n; i += stride) sources.push(i);
  return sources;
}
