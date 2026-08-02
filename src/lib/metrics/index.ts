import type { BaseGraph, CellValue, ColumnType } from "../../types";
import { centrality, hits, type CentralityKind } from "./centrality";
import { DEFAULT_RESOLUTION, louvain, louvainStability } from "./community";
import { edgeMetrics } from "./edges";
import { components, coreness, networkMetrics, triangles } from "./structure";
import { bfsDistances, toMetricGraph, undirected, type MetricGraph } from "./model";
import { edgeKey } from "../cells";

export { CENTRALITY_NAMES, type CentralityKind } from "./centrality";
export { DEFAULT_RESOLUTION } from "./community";
export type { NetworkMetrics } from "./structure";
export {
  shortestPath,
  shortestPathInfo,
  shortestRoutes,
  toMetricGraph,
  type MetricGraph,
} from "./model";

/** Scores by node id, for callers holding a projected graph already. */
export function centralityScores(graph: MetricGraph, kind: CentralityKind): Map<string, number> {
  const scores = centrality(graph, kind);
  return new Map(graph.ids.map((id, i) => [id, scores[i]]));
}

/** Adapter for the live styling path, which still speaks in node ids. */
export function centralityValues(graph: BaseGraph, kind: CentralityKind): Map<string, number> {
  return centralityScores(toMetricGraph(graph), kind);
}

export function graphMetrics(graph: BaseGraph) {
  return networkMetrics(toMetricGraph(graph));
}

export type MetricTarget = "nodes" | "edges";
export type MetricCost = "cheap" | "moderate" | "heavy";

export interface MetricDefinition {
  id: string;
  name: string;
  target: MetricTarget;
  /** Columns this metric writes, in order. */
  columns: string[];
  cost: MetricCost;
  blurb: string;
}

/**
 * Everything the compute step can produce. Results land as ordinary columns,
 * so they immediately work as styling inputs, filter subjects, table columns
 * and export attributes without any of those knowing what a metric is.
 */
export const METRICS: MetricDefinition[] = [
  {
    id: "degree",
    name: "Degree",
    target: "nodes",
    columns: ["Degree", "In-degree", "Out-degree"],
    cost: "cheap",
    blurb: "Connection counts, total and by direction.",
  },
  {
    id: "pagerank",
    name: "PageRank",
    target: "nodes",
    columns: ["PageRank"],
    cost: "moderate",
    blurb: "Influence that flows along the arrows; scores sum to 1.",
  },
  {
    id: "hits",
    name: "HITS hub and authority",
    target: "nodes",
    columns: ["Hub", "Authority"],
    cost: "moderate",
    blurb: "Hubs point at good authorities; authorities are pointed at by good hubs.",
  },
  {
    id: "betweenness",
    name: "Betweenness",
    target: "nodes",
    columns: ["Betweenness"],
    cost: "heavy",
    blurb: "How often a node sits on the shortest path between two others.",
  },
  {
    id: "closeness",
    name: "Closeness",
    target: "nodes",
    columns: ["Closeness", "Harmonic closeness"],
    cost: "heavy",
    blurb: "How few steps a node needs to reach everyone else.",
  },
  {
    id: "eigenvector",
    name: "Eigenvector",
    target: "nodes",
    columns: ["Eigenvector"],
    cost: "moderate",
    blurb: "Degree, but connections to well-connected nodes count for more.",
  },
  {
    id: "louvain",
    name: "Modularity class",
    target: "nodes",
    columns: ["Modularity class"],
    cost: "moderate",
    blurb: "Louvain communities: densely connected groups, largest numbered 0.",
  },
  {
    id: "coreness",
    name: "k-core",
    target: "nodes",
    columns: ["Coreness"],
    cost: "cheap",
    blurb: "The densest shell a node survives into as low-degree nodes are peeled away.",
  },
  {
    id: "triangles",
    name: "Triangles",
    target: "nodes",
    columns: ["Triangles"],
    cost: "moderate",
    blurb: "Closed triads a node takes part in.",
  },
  {
    id: "components",
    name: "Components",
    target: "nodes",
    columns: ["Component", "Component size"],
    cost: "cheap",
    blurb: "Which island a node belongs to, largest numbered 0.",
  },
  {
    id: "edges",
    name: "Edge structure",
    target: "edges",
    columns: ["Embeddedness", "Simmelian strength", "Disparity alpha"],
    cost: "moderate",
    blurb: "Shared neighbours, reciprocated triads, and disparity-filter significance.",
  },
];

export const METRIC_IDS = METRICS.map((m) => m.id);

export interface MetricOptions {
  /** Numeric edge column used as the weight, or null for unweighted. */
  weightColumn: string | null;
  /** Louvain resolution: higher finds more, smaller communities. */
  resolution: number;
  /**
   * Also estimate how firmly each node sits in its Louvain community, as a
   * companion column. Costs several extra Louvain runs, so it is opt-in.
   */
  louvainStability?: boolean;
}

export const DEFAULT_METRIC_OPTIONS: MetricOptions = {
  weightColumn: null,
  resolution: DEFAULT_RESOLUTION,
};

/**
 * One compute run the user asked for, as an instruction rather than as the
 * values it produced. The workspace carries these so "update data" can run
 * the same metrics against whatever arrives next.
 */
export interface ComputedRecipe {
  metrics: string[];
  options: MetricOptions;
}

export interface ComputedColumn {
  name: string;
  type: ColumnType;
  /**
   * Values keyed by node id, or by `edgeKey(source, target)`.
   *
   * Built with a null prototype, and read back the same way. A node id is
   * whatever a cell said, and a cell can say `__proto__`: assigning that on an
   * ordinary object silently stores nothing and reading it back hands out
   * `Object.prototype`, which then lands in a table cell as "[object Object]".
   * Keys named after anything on the prototype behave the same way.
   */
  values: Record<string, CellValue>;
}

/** A map keyed by data. See `ComputedColumn.values` for why it is not `{}`. */
export function emptyValues(): Record<string, CellValue> {
  return Object.create(null) as Record<string, CellValue>;
}

export interface MetricRunResult {
  nodeColumns: ComputedColumn[];
  edgeColumns: ComputedColumn[];
  /** Findings that are about the whole graph rather than one row. */
  summary: { modularity?: number; communityCount?: number };
}

/**
 * Hop distance from one node as a computed column: the heat-map question
 * asked the columns way, so ramps, sizes and filters compose with the answer
 * for free. Unreachable nodes stay blank rather than wearing a fake number.
 */
export function hopsColumn(graph: MetricGraph, from: string, name: string): ComputedColumn | null {
  const at = graph.ids.indexOf(from);
  if (at === -1) return null;
  const dist = new Int32Array(graph.ids.length);
  bfsDistances(undirected(graph).neighbors, at, dist);
  const values = emptyValues();
  graph.ids.forEach((id, i) => {
    values[id] = dist[i] === -1 ? null : dist[i];
  });
  return { name, type: "number", values };
}

/**
 * Run the selected metrics over an already-projected graph. Pure and
 * synchronous, so it works identically on the main thread and in the worker.
 */
export function runMetrics(
  graph: MetricGraph,
  selected: string[],
  options: MetricOptions = DEFAULT_METRIC_OPTIONS,
): MetricRunResult {
  const wanted = new Set(selected);
  const nodeColumns: ComputedColumn[] = [];
  const edgeColumns: ComputedColumn[] = [];
  const summary: MetricRunResult["summary"] = {};

  // Undirected structure is shared by most of these, so build it at most once.
  let cached: ReturnType<typeof undirected> | null = null;
  const shared = () => (cached ??= undirected(graph));

  const nodeColumn = (name: string, type: ColumnType, valueAt: (i: number) => CellValue) => {
    const values = emptyValues();
    graph.ids.forEach((id, i) => {
      values[id] = valueAt(i);
    });
    nodeColumns.push({ name, type, values });
  };

  const edgeColumn = (name: string, type: ColumnType, valueAt: (e: number) => CellValue) => {
    const values = emptyValues();
    for (let e = 0; e < graph.source.length; e++) {
      values[edgeKey(graph.ids[graph.source[e]], graph.ids[graph.target[e]])] = valueAt(e);
    }
    edgeColumns.push({ name, type, values });
  };

  if (wanted.has("degree")) {
    const u = shared();
    const out = new Int32Array(graph.ids.length);
    const inn = new Int32Array(graph.ids.length);
    for (let e = 0; e < graph.source.length; e++) {
      out[graph.source[e]]++;
      inn[graph.target[e]]++;
    }
    nodeColumn("Degree", "number", (i) => u.neighbors[i].length);
    nodeColumn("In-degree", "number", (i) => inn[i]);
    nodeColumn("Out-degree", "number", (i) => out[i]);
  }

  if (wanted.has("pagerank")) {
    const scores = centrality(graph, "pagerank");
    nodeColumn("PageRank", "number", (i) => scores[i]);
  }

  if (wanted.has("hits")) {
    const { hubs, authorities } = hits(graph);
    nodeColumn("Hub", "number", (i) => hubs[i]);
    nodeColumn("Authority", "number", (i) => authorities[i]);
  }

  if (wanted.has("betweenness")) {
    const scores = centrality(graph, "betweenness");
    nodeColumn("Betweenness", "number", (i) => scores[i]);
  }

  if (wanted.has("closeness")) {
    const close = centrality(graph, "closeness");
    const harm = centrality(graph, "harmonic");
    nodeColumn("Closeness", "number", (i) => close[i]);
    nodeColumn("Harmonic closeness", "number", (i) => harm[i]);
  }

  if (wanted.has("eigenvector")) {
    const scores = centrality(graph, "eigenvector");
    nodeColumn("Eigenvector", "number", (i) => scores[i]);
  }

  if (wanted.has("louvain")) {
    const result = louvain(graph, options.resolution);
    // Text, not number: these are labels, and a sequential ramp over community
    // ids would imply an order that does not exist.
    nodeColumn("Modularity class", "text", (i) => String(result.communities[i]));
    summary.modularity = result.modularity;
    summary.communityCount = result.communityCount;
    if (options.louvainStability === true) {
      const stability = louvainStability(graph, options.resolution, result.communities);
      nodeColumn("Modularity stability", "number", (i) => stability[i]);
    }
  }

  if (wanted.has("coreness")) {
    const scores = coreness(shared());
    nodeColumn("Coreness", "number", (i) => scores[i]);
  }

  if (wanted.has("triangles")) {
    const scores = triangles(shared());
    nodeColumn("Triangles", "number", (i) => scores[i]);
  }

  if (wanted.has("components")) {
    const { ids, sizes } = components(shared());
    nodeColumn("Component", "text", (i) => String(ids[i]));
    nodeColumn("Component size", "number", (i) => sizes[ids[i]]);
  }

  if (wanted.has("edges")) {
    const { embeddedness, simmelian, disparity } = edgeMetrics(graph);
    edgeColumn("Embeddedness", "number", (e) => embeddedness[e]);
    edgeColumn("Simmelian strength", "number", (e) => simmelian[e]);
    edgeColumn("Disparity alpha", "number", (e) => disparity[e]);
  }

  return { nodeColumns, edgeColumns, summary };
}
