import {
  bfsDistances,
  sampleSources,
  undirected,
  type MetricGraph,
  type Undirected,
} from "./model";

/** Local clustering is skipped for hubs above this degree to stay O(n·k²)-safe. */
const CLUSTERING_DEGREE_CAP = 300;

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

export function networkMetrics(graph: MetricGraph): NetworkMetrics {
  const n = graph.ids.length;
  if (n === 0) {
    return {
      density: null,
      diameter: null,
      avgPathLength: null,
      clustering: null,
      approximate: false,
    };
  }
  const density = n > 1 ? graph.source.length / (n * (n - 1)) : null;
  const { neighbors, sets } = undirected(graph);

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
    approximate: n > sources.length,
  };
}

/**
 * k-core decomposition: the largest k for which a node survives repeatedly
 * peeling away everything of degree below k. Bucket-sorted peeling, so it is
 * linear in nodes plus edges.
 */
export function coreness(u: Undirected): Int32Array {
  const { n, neighbors } = u;
  const deg = new Int32Array(n);
  let maxDegree = 0;
  for (let v = 0; v < n; v++) {
    deg[v] = neighbors[v].length;
    if (deg[v] > maxDegree) maxDegree = deg[v];
  }

  // Bin-sort the vertices by degree, keeping the position of each so a
  // vertex can be swapped to the front of its bin in constant time.
  const bin = new Int32Array(maxDegree + 2);
  for (let v = 0; v < n; v++) bin[deg[v]]++;
  let start = 0;
  for (let d = 0; d <= maxDegree; d++) {
    const count = bin[d];
    bin[d] = start;
    start += count;
  }

  const vert = new Int32Array(n);
  const pos = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    pos[v] = bin[deg[v]];
    vert[pos[v]] = v;
    bin[deg[v]]++;
  }
  for (let d = maxDegree; d > 0; d--) bin[d] = bin[d - 1];
  bin[0] = 0;

  for (let i = 0; i < n; i++) {
    const v = vert[i];
    for (const w of neighbors[v]) {
      if (deg[w] <= deg[v]) continue;
      const degW = deg[w];
      const posW = pos[w];
      const posFirst = bin[degW];
      const first = vert[posFirst];
      if (w !== first) {
        pos[w] = posFirst;
        vert[posW] = first;
        pos[first] = posW;
        vert[posFirst] = w;
      }
      bin[degW]++;
      deg[w]--;
    }
  }
  return deg;
}

/**
 * Triangles through each node, counted over edges rather than neighbour pairs
 * so a single hub cannot make it quadratic.
 */
export function triangles(u: Undirected): Float64Array {
  const { n, neighbors, sets } = u;
  const counts = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    for (const w of neighbors[v]) {
      if (w < v) continue;
      // Walk the smaller neighbourhood and test membership in the larger.
      const [small, large] = neighbors[v].length <= neighbors[w].length ? [v, w] : [w, v];
      for (const x of neighbors[small]) {
        if (x === v || x === w || !sets[large].has(x)) continue;
        counts[v]++;
        counts[w]++;
        counts[x]++;
      }
    }
  }
  // Every triangle is discovered once per edge, three times in total, and each
  // discovery credits all three corners.
  for (let v = 0; v < n; v++) counts[v] /= 3;
  return counts;
}

export interface Components {
  /** Component index per node, renumbered so 0 is the largest component. */
  ids: Int32Array;
  /** Node count of each component, largest first. */
  sizes: number[];
}

/** Connected components, ignoring direction. */
export function components(u: Undirected): Components {
  const { n, neighbors } = u;
  const raw = new Int32Array(n).fill(-1);
  const sizes: number[] = [];

  for (let v = 0; v < n; v++) {
    if (raw[v] !== -1) continue;
    const id = sizes.length;
    let size = 0;
    const queue = [v];
    raw[v] = id;
    while (queue.length > 0) {
      const current = queue.pop() as number;
      size++;
      for (const w of neighbors[current]) {
        if (raw[w] === -1) {
          raw[w] = id;
          queue.push(w);
        }
      }
    }
    sizes.push(size);
  }

  const order = sizes
    .map((size, id) => ({ size, id }))
    .sort((a, b) => b.size - a.size || a.id - b.id);
  const rank = new Map(order.map((entry, i) => [entry.id, i]));
  const ids = new Int32Array(n);
  for (let v = 0; v < n; v++) ids[v] = rank.get(raw[v]) as number;
  return { ids, sizes: order.map((entry) => entry.size) };
}
