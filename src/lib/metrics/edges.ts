import { undirected, type MetricGraph } from "./model";

/**
 * Per-edge measures. Each returns one value per entry in the metric graph's
 * source/target arrays, so results line up with the links they describe.
 */

export interface EdgeMetrics {
  /** Common neighbours of the two endpoints, ignoring direction. */
  embeddedness: Float64Array;
  /** Common neighbours forming a fully reciprocated triad. */
  simmelian: Float64Array;
  /** Disparity-filter significance; lower means harder to explain by chance. */
  disparity: Float64Array;
}

export function edgeMetrics(graph: MetricGraph): EdgeMetrics {
  return {
    embeddedness: embeddedness(graph),
    simmelian: simmelian(graph),
    disparity: disparity(graph),
  };
}

/** Number of nodes adjacent to both endpoints. */
export function embeddedness(graph: MetricGraph): Float64Array {
  const u = undirected(graph);
  const out = new Float64Array(graph.source.length);
  for (let e = 0; e < graph.source.length; e++) {
    const s = graph.source[e];
    const t = graph.target[e];
    if (s === t) continue;
    const [small, large] = u.neighbors[s].length <= u.neighbors[t].length ? [s, t] : [t, s];
    let shared = 0;
    for (const w of u.neighbors[small]) {
      if (w !== s && w !== t && u.sets[large].has(w)) shared++;
    }
    out[e] = shared;
  }
  return out;
}

/**
 * Simmelian strength: how many third parties are tied reciprocally to both
 * endpoints of an already-reciprocated edge. Simmel's argument is that a tie
 * embedded in such a triad is constrained by the group rather than negotiable
 * between two people, so it behaves differently from a merely frequent one.
 *
 * Data with no reciprocal edges at all — a reporting hierarchy, say — scores
 * zero throughout. That is the honest answer for a one-directional graph, not
 * a defect; `embeddedness` is the measure to reach for there.
 */
export function simmelian(graph: MetricGraph): Float64Array {
  const u = undirected(graph);
  const out = new Float64Array(graph.source.length);

  const pairs = new Set<number>();
  const n = graph.ids.length;
  for (let e = 0; e < graph.source.length; e++) {
    pairs.add(graph.source[e] * n + graph.target[e]);
  }
  const reciprocal = (a: number, b: number) => pairs.has(a * n + b) && pairs.has(b * n + a);

  for (let e = 0; e < graph.source.length; e++) {
    const s = graph.source[e];
    const t = graph.target[e];
    if (s === t || !reciprocal(s, t)) continue;
    const [small, large] = u.neighbors[s].length <= u.neighbors[t].length ? [s, t] : [t, s];
    let strength = 0;
    for (const w of u.neighbors[small]) {
      if (w === s || w === t || !u.sets[large].has(w)) continue;
      if (reciprocal(s, w) && reciprocal(t, w)) strength++;
    }
    out[e] = strength;
  }
  return out;
}

/**
 * Serrano, Boguñá and Vespignani's disparity filter. For each endpoint, the
 * edge's share of that node's total weight is compared against what a uniform
 * random split of the same strength would produce: alpha is the probability of
 * seeing a share at least this large by chance, so a *low* alpha marks an edge
 * that carries more weight than its node's other edges can explain. The edge
 * takes the smaller of its two endpoint alphas, meaning it survives if it
 * matters to either end.
 *
 * A degree-one node has nothing to compare against and the formula degenerates,
 * so its edge is treated as maximally significant (alpha 0) and always kept,
 * which is the usual convention.
 */
export function disparity(graph: MetricGraph): Float64Array {
  const u = undirected(graph);
  const out = new Float64Array(graph.source.length);

  // Neighbour weights by id, so each edge is a lookup rather than a scan.
  const weightTo = u.neighbors.map(
    (list, v) => new Map(list.map((other, i) => [other, u.weights[v][i]])),
  );

  const alphaFrom = (node: number, other: number): number => {
    const k = u.neighbors[node].length;
    if (k < 2) return 0;
    const weight = weightTo[node].get(other);
    const strength = u.strength[node];
    if (weight === undefined || strength <= 0) return 1;
    return (1 - weight / strength) ** (k - 1);
  };

  for (let e = 0; e < graph.source.length; e++) {
    const s = graph.source[e];
    const t = graph.target[e];
    out[e] = s === t ? 1 : Math.min(alphaFrom(s, t), alphaFrom(t, s));
  }
  return out;
}
