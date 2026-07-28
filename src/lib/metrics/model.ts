import type { BaseGraph, GraphNode, Row } from "../../types";
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
  const ids = graph.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));

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

export function undirected(graph: MetricGraph): Undirected {
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

/** Path measures sample their sources above this many nodes. */
export const SAMPLE_LIMIT = 600;

export function sampleSources(n: number): number[] {
  if (n <= SAMPLE_LIMIT) return Array.from({ length: n }, (_, i) => i);
  const stride = Math.ceil(n / SAMPLE_LIMIT);
  const sources: number[] = [];
  for (let i = 0; i < n; i += stride) sources.push(i);
  return sources;
}
