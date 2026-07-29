import type {
  BaseGraph,
  ColumnFilter,
  Filters,
  Graph,
  GraphDoc,
  GraphLink,
  GraphNode,
  GraphStyle,
  Row,
} from "../types";
import { styleColumn } from "../types";
import { cellKey, cellToId, edgeKey } from "./cells";
import { findColumn, hasColumn } from "./doc";
import { asNumber } from "./parse";
import { centralityValues, type CentralityKind } from "./metrics";

/** Style tokens that rank nodes by a computed network metric. */
export const CENTRALITY_TOKENS: Record<string, CentralityKind> = {
  "metric:degree": "degree",
  "metric:betweenness": "betweenness",
  "metric:closeness": "closeness",
  "metric:eigenvector": "eigenvector",
};

export const endpointId = (e: string | GraphNode): string => (typeof e === "string" ? e : e.id);

export interface BuildOptions {
  /** Edge rows to build from; defaults to every row in the document. */
  edgeRows?: Row[];
  /** Keep nodes that end up with no edges. */
  showIsolated?: boolean;
  /**
   * Restrict the graph to these node ids. A row naming an excluded endpoint
   * drops out entirely rather than counting as malformed.
   */
  keepNodes?: ReadonlySet<string> | null;
}

/**
 * Build the structural graph: nodes come from the document's node table,
 * links from its edge rows. Rows with an empty endpoint or a self-loop are
 * skipped; duplicate source->target pairs merge into one link that keeps
 * every original row.
 *
 * Nothing here depends on appearance settings, so the result can be cached
 * against the document and restyled freely.
 */
export function buildBaseGraph(doc: GraphDoc, options: BuildOptions = {}): BaseGraph {
  const edgeRows = options.edgeRows ?? doc.edges.rows;
  const showIsolated = options.showIsolated ?? doc.nodesDeclared;
  const keepNodes = options.keepNodes ?? null;

  const nodes = new Map<string, GraphNode>();
  const newNode = (id: string, row: Row): GraphNode => ({
    id,
    row,
    group: null,
    value: null,
    inDegree: 0,
    outDegree: 0,
    degree: 0,
    radius: 0,
  });

  for (const row of doc.nodes.rows) {
    const id = cellToId(row[doc.nodeIdColumn]);
    if (id === null || nodes.has(id)) continue;
    if (keepNodes && !keepNodes.has(id)) continue;
    nodes.set(id, newNode(id, row));
  }

  // An endpoint the node table has never heard of still has to render; the
  // document is reconciled separately so the Nodes tab catches up.
  const getNode = (id: string): GraphNode => {
    let node = nodes.get(id);
    if (!node) {
      node = newNode(id, { [doc.nodeIdColumn]: id });
      nodes.set(id, node);
    }
    return node;
  };

  const links = new Map<string, GraphLink>();
  const rows: Row[] = [];
  let skippedRows = 0;

  for (const row of edgeRows) {
    const sourceId = cellToId(row[doc.mapping.source]);
    const targetId = cellToId(row[doc.mapping.target]);
    if (!sourceId || !targetId || sourceId === targetId) {
      skippedRows++;
      continue;
    }
    // Excluded by an upstream filter rather than malformed, so not "skipped".
    if (keepNodes && (!keepNodes.has(sourceId) || !keepNodes.has(targetId))) continue;
    rows.push(row);

    const key = edgeKey(sourceId, targetId);
    const existing = links.get(key);
    if (existing) {
      existing.rows.push(row);
      continue;
    }
    links.set(key, {
      source: sourceId,
      target: targetId,
      rows: [row],
      weight: null,
      colorValue: null,
      curve: false,
    });
    getNode(sourceId).outDegree++;
    getNode(targetId).inDegree++;
  }

  for (const link of links.values()) {
    // Reciprocal pairs render as opposing arcs so both edges stay visible.
    if (links.has(edgeKey(link.target as string, link.source as string))) link.curve = true;
  }

  let nodeList = [...nodes.values()];
  for (const node of nodeList) {
    node.degree = node.inDegree + node.outDegree;
  }
  if (!showIsolated) nodeList = nodeList.filter((n) => n.degree > 0);

  return { nodes: nodeList, links: [...links.values()], rows, skippedRows };
}

/**
 * Apply appearance settings to a structural graph, returning fresh node and
 * link objects so the base graph stays reusable.
 *
 * Column tokens resolve against the node table first and fall back to the
 * edge rows: a categorical value is taken from the first incident row naming
 * the node as a target, a numeric one is summed over every incident row.
 */
export function applyStyle(base: BaseGraph, doc: GraphDoc, style: GraphStyle): Graph {
  const colorCol = styleColumn(style.nodeColor);
  const sizeCol = styleColumn(style.nodeSize);
  const widthCol = styleColumn(style.edgeWidth);
  const edgeColorCol = styleColumn(style.edgeColor);

  const colorIsNumeric = colorCol !== null && isNumericAttr(doc, colorCol);
  const colorCentrality = CENTRALITY_TOKENS[style.nodeColor];
  const ranking = colorCentrality !== undefined || colorIsNumeric;

  const nodes: GraphNode[] = base.nodes.map((n) => ({ ...n }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const centralityCache = new Map<CentralityKind, Map<string, number>>();
  const getCentrality = (kind: CentralityKind): Map<string, number> => {
    let map = centralityCache.get(kind);
    if (!map) {
      map = centralityValues(base, kind);
      centralityCache.set(kind, map);
    }
    return map;
  };

  if (colorCol !== null && !colorIsNumeric) {
    const groups = categoricalAttr(base, doc, colorCol);
    for (const node of nodes) node.group = groups.get(node.id) ?? null;
  }
  if (ranking) {
    const values = colorCentrality
      ? getCentrality(colorCentrality)
      : numericAttr(base, doc, colorCol as string);
    for (const node of nodes) node.value = values.get(node.id) ?? 0;
  }

  // Node radius: sqrt scale of the chosen metric into [4.5, 22].
  const sizeCentrality = CENTRALITY_TOKENS[style.nodeSize];
  const sizeValues =
    sizeCol !== null
      ? numericAttr(base, doc, sizeCol)
      : sizeCentrality && sizeCentrality !== "degree"
        ? getCentrality(sizeCentrality)
        : null;
  const sizeMetric = (n: GraphNode): number => {
    if (style.nodeSize === "metric:uniform") return 1;
    if (style.nodeSize === "metric:in") return n.inDegree;
    if (style.nodeSize === "metric:out") return n.outDegree;
    if (sizeValues) return Math.max(0, sizeValues.get(n.id) ?? 0);
    return n.degree;
  };
  const maxMetric = Math.max(1e-9, ...nodes.map(sizeMetric));
  for (const node of nodes) {
    node.radius =
      style.nodeSize === "metric:uniform" ? 8 : 4.5 + 17 * Math.sqrt(sizeMetric(node) / maxMetric);
  }

  const links: GraphLink[] = base.links.map((l) => {
    const link: GraphLink = {
      ...l,
      source: byId.get(endpointId(l.source)) ?? endpointId(l.source),
      target: byId.get(endpointId(l.target)) ?? endpointId(l.target),
      weight: null,
      colorValue: null,
    };
    if (widthCol) {
      const values = l.rows
        .map((r) => asNumber(r[widthCol]))
        .filter((v): v is number => v !== null);
      if (values.length > 0) link.weight = values.reduce((a, b) => a + b, 0) / values.length;
    }
    if (edgeColorCol) {
      link.colorValue = l.rows.map((r) => cellKey(r[edgeColorCol])).find((k) => k !== "") ?? null;
    }
    return link;
  });

  const groups = ranking ? [] : countValues(nodes.map((n) => n.group));
  const edgeGroups = countValues(links.map((l) => l.colorValue));

  let rankRange: Graph["ranking"] = null;
  if (ranking && nodes.length > 0) {
    const values = nodes.map((n) => n.value ?? 0);
    rankRange = { min: Math.min(...values), max: Math.max(...values) };
  }

  return {
    nodes,
    links,
    rows: base.rows,
    skippedRows: base.skippedRows,
    groups,
    edgeGroups,
    ranking: rankRange,
  };
}

/** Whether a style column reads as numeric, preferring the declared type. */
function isNumericAttr(doc: GraphDoc, column: string): boolean {
  const onNodes = findColumn(doc.nodes, column);
  if (onNodes) return onNodes.type === "number";
  return findColumn(doc.edges, column)?.type === "number";
}

/** Categorical value per node: node table, else the first incident target row. */
function categoricalAttr(base: BaseGraph, doc: GraphDoc, column: string): Map<string, string> {
  const values = new Map<string, string>();
  if (hasColumn(doc.nodes, column)) {
    for (const node of base.nodes) {
      const v = cellToId(node.row[column]);
      if (v !== null) values.set(node.id, v);
    }
    return values;
  }
  for (const row of base.rows) {
    const target = cellToId(row[doc.mapping.target]);
    const v = cellToId(row[column]);
    if (target !== null && v !== null && !values.has(target)) values.set(target, v);
  }
  return values;
}

/** Numeric value per node: node table, else summed over every incident row. */
function numericAttr(base: BaseGraph, doc: GraphDoc, column: string): Map<string, number> {
  const values = new Map<string, number>();
  if (hasColumn(doc.nodes, column)) {
    for (const node of base.nodes) {
      const v = asNumber(node.row[column]);
      if (v !== null) values.set(node.id, v);
    }
    return values;
  }
  const add = (id: string | null, v: number) => {
    if (id !== null) values.set(id, (values.get(id) ?? 0) + v);
  };
  for (const row of base.rows) {
    const v = asNumber(row[column]);
    if (v === null) continue;
    add(cellToId(row[doc.mapping.source]), v);
    add(cellToId(row[doc.mapping.target]), v);
  }
  return values;
}

function countValues(values: (string | null)[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([g]) => g);
}

/** Whether the styling of a graph produces anything worth putting in a legend. */
export function hasLegend(graph: Graph): boolean {
  return graph.ranking !== null || graph.groups.length > 0 || graph.edgeGroups.length > 0;
}

/** Scale for edge stroke width when a width column is mapped. */
export function weightScale(links: GraphLink[]): (l: GraphLink) => number {
  const weights = links.map((l) => l.weight).filter((w): w is number => w !== null);
  if (weights.length === 0) return () => 1.4;
  const min = Math.min(...weights);
  const max = Math.max(...weights);
  if (min === max) return () => 2;
  return (l) => {
    if (l.weight === null) return 1;
    const t = Math.sqrt((l.weight - min) / (max - min));
    return 1 + t * 5;
  };
}

/** Rows that pass every active column filter. */
export function applyFilters(rows: Row[], filters: Filters): Row[] {
  const active = Object.entries(filters);
  if (active.length === 0) return rows;
  return rows.filter((row) => active.every(([column, filter]) => rowPasses(row, column, filter)));
}

function rowPasses(row: Row, column: string, filter: ColumnFilter): boolean {
  if (filter.kind === "values") return filter.selected.includes(cellKey(row[column]));
  const v = asNumber(row[column]);
  if (v === null) return false;
  if (filter.min !== null && v < filter.min) return false;
  if (filter.max !== null && v > filter.max) return false;
  return true;
}

/** Distinct values of a column with row counts, most frequent first. */
export function distinctValues(rows: Row[], column: string): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = cellKey(row[column]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

/** Range of a numeric column, ignoring non-numeric cells. */
export function columnRange(rows: Row[], column: string): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const v = asNumber(row[column]);
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return isFinite(min) ? { min, max } : null;
}

/** Number of connected components, treating edges as undirected. */
export function componentCount(graph: BaseGraph): number {
  const adjacency = new Map<string, string[]>();
  for (const n of graph.nodes) adjacency.set(n.id, []);
  for (const l of graph.links) {
    const s = endpointId(l.source);
    const t = endpointId(l.target);
    adjacency.get(s)?.push(t);
    adjacency.get(t)?.push(s);
  }
  const seen = new Set<string>();
  let components = 0;
  for (const n of graph.nodes) {
    if (seen.has(n.id)) continue;
    components++;
    const queue = [n.id];
    seen.add(n.id);
    while (queue.length > 0) {
      const id = queue.pop() as string;
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return components;
}
