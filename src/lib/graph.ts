import type {
  BaseGraph,
  Graph,
  GraphDoc,
  GraphLink,
  GraphNode,
  GraphStyle,
  Row,
  StyleCurve,
} from "../types";
import { isCellStyle, styleColumn } from "../types";
import { cellKey, cellToId, edgeKey } from "./cells";
import { findColumn, hasColumn } from "./doc";
import { imageSource } from "./images";
import { asNumber } from "./parse";
import { extentOf, maxOf } from "./numbers";
import { centralityValues, type CentralityKind } from "./metrics";
import { NEUTRAL, nodeColor, parseColor, sequentialColor, type Palette } from "../theme";

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
    label: id,
    row,
    group: null,
    value: null,
    color: null,
    image: null,
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
      color: null,
      width: null,
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

/** Pixel bounds for sizes taken straight from a column, either end inclusive. */
export const CELL_RADIUS = { min: 1, max: 100 };
export const CELL_WIDTH = { min: 0.2, max: 24 };

/**
 * The log curve's steepness: t is stretched over one decade before the log,
 * so the bottom tenth of the range takes about a third of the channel.
 */
const LOG_CURVE_SPAN = 9;

/**
 * Interpolators over the normalized 0-1 value of a numeric mapping. All three
 * take 0 to 0 and 1 to 1 and rise monotonically in between; `log` goes through
 * `log1p`, so a zero maps to zero rather than off the bottom of the scale.
 */
export function curveFn(curve: StyleCurve): (t: number) => number {
  if (curve === "sqrt") return Math.sqrt;
  if (curve === "log") return (t) => Math.log1p(LOG_CURVE_SPAN * t) / Math.log1p(LOG_CURVE_SPAN);
  return (t) => t;
}

const clamp = (v: number, { min, max }: { min: number; max: number }) =>
  Math.max(min, Math.min(max, v));

/**
 * Apply appearance settings to a structural graph, returning fresh node and
 * link objects so the base graph stays reusable.
 *
 * Column tokens resolve against the node table first and fall back to the
 * edge rows: a categorical value is taken from the first incident row naming
 * the node as a target, a numeric one is summed over every incident row.
 *
 * A "cell:" token means the column is not a value to encode but the answer
 * itself, a color to paint or a size in pixels, so it skips the palettes and
 * the scales and lands on the mark as it was written.
 */
export function applyStyle(base: BaseGraph, doc: GraphDoc, style: GraphStyle): Graph {
  const colorCol = styleColumn(style.nodeColor);
  const sizeCol = styleColumn(style.nodeSize);
  const widthCol = styleColumn(style.edgeWidth);
  const edgeColorCol = styleColumn(style.edgeColor);

  const colorFromCells = colorCol !== null && isCellStyle(style.nodeColor);
  const sizeFromCells = sizeCol !== null && isCellStyle(style.nodeSize);
  const edgeColorFromCells = edgeColorCol !== null && isCellStyle(style.edgeColor);

  const colorIsNumeric = colorCol !== null && !colorFromCells && isNumericAttr(doc, colorCol);
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

  if (colorFromCells) {
    // A column of colors is decoration, not a partition: the nodes get no group
    // and the legend has nothing to key, since the values are the colors. A cell
    // that says nothing a color could be read from lands on the neutral, which
    // is what a node with nothing to say wears everywhere else.
    const cells = categoricalAttr(base, doc, colorCol as string);
    for (const node of nodes) node.color = parseColor(cells.get(node.id) ?? null) ?? NEUTRAL;
  } else if (colorCol !== null && !colorIsNumeric) {
    const groups = categoricalAttr(base, doc, colorCol);
    for (const node of nodes) node.group = groups.get(node.id) ?? null;
  }
  if (ranking) {
    const values = colorCentrality
      ? getCentrality(colorCentrality)
      : numericAttr(base, doc, colorCol as string);
    for (const node of nodes) node.value = values.get(node.id) ?? 0;
  }
  // Labels resolve against the node table alone: a display name is the node's
  // own, not something to project off whichever edge row got there first.
  const labelCol = styleColumn(style.nodeLabel);
  if (labelCol !== null && hasColumn(doc.nodes, labelCol)) {
    for (const node of nodes) node.label = cellToId(node.row[labelCol]) ?? node.id;
  }
  // Images resolve here rather than at draw time, so the canvas, the tooltips
  // and an export all see the same source for a node.
  const imageCol = styleColumn(style.nodeImage);
  if (imageCol !== null) {
    const sources = categoricalAttr(base, doc, imageCol);
    for (const node of nodes) node.image = imageSource(sources.get(node.id) ?? null);
  }

  // Node radius: sqrt scale of the chosen metric into [4.5, 22]. Pictures need
  // room to be recognized, so a graph carrying them starts larger and spans
  // further; the sizing still says the same thing, just at a readable scale.
  const sized = imageCol !== null ? { floor: 8, span: 20, uniform: 13 } : null;
  if (sizeFromCells) {
    // Radii in pixels, so a node keeps the size it was given whatever the rest
    // of the graph does. A cell with no number in it takes the plain size.
    const cells = cellNumberAttr(base, doc, sizeCol as string);
    const fallback = sized?.uniform ?? 8;
    for (const node of nodes) {
      const v = cells.get(node.id);
      node.radius = v === undefined ? fallback : clamp(v, CELL_RADIUS);
    }
  } else if (style.nodeSize === "metric:uniform") {
    for (const node of nodes) node.radius = sized?.uniform ?? 8;
  } else {
    const sizeCentrality = CENTRALITY_TOKENS[style.nodeSize];
    const sizeValues =
      sizeCol !== null
        ? numericAttr(base, doc, sizeCol)
        : sizeCentrality && sizeCentrality !== "degree"
          ? getCentrality(sizeCentrality)
          : null;
    const sizeMetric = (n: GraphNode): number => {
      if (style.nodeSize === "metric:in") return n.inDegree;
      if (style.nodeSize === "metric:out") return n.outDegree;
      if (sizeValues) return Math.max(0, sizeValues.get(n.id) ?? 0);
      return n.degree;
    };
    // Measured once and kept: the metric can be a centrality lookup, and asking
    // for it again inside the loop would be a second pass over every node.
    const metrics = nodes.map(sizeMetric);
    const maxMetric = maxOf(metrics, 1e-9);
    const floor = sized?.floor ?? 4.5;
    const span = sized?.span ?? 17;
    const sizeCurve = curveFn(style.nodeSizeCurve ?? "sqrt");
    nodes.forEach((node, i) => {
      node.radius = floor + span * sizeCurve(metrics[i] / maxMetric);
    });
  }

  // Type overrides land last, so each channel replaces exactly what the
  // global rules computed. One map lookup per node keeps this O(nodes).
  const typeStyles = style.typeStyles;
  if (typeStyles !== undefined) {
    const kinds = categoricalAttr(base, doc, typeStyles.column);
    for (const node of nodes) {
      const kind = kinds.get(node.id);
      if (kind === undefined || !Object.hasOwn(typeStyles.styles, kind)) continue;
      const override = typeStyles.styles[kind];
      if (override.color !== undefined) node.color = override.color;
      if (override.size !== undefined) node.radius = clamp(override.size, CELL_RADIUS);
      if (override.image !== undefined) node.image = imageSource(override.image);
      if (override.labelColumn !== undefined && hasColumn(doc.nodes, override.labelColumn)) {
        node.label = cellToId(node.row[override.labelColumn]) ?? node.id;
      }
    }
  }

  const edgeTypeStyles = style.edgeTypeStyles;

  const links: GraphLink[] = base.links.map((l) => {
    const link: GraphLink = {
      ...l,
      source: byId.get(endpointId(l.source)) ?? endpointId(l.source),
      target: byId.get(endpointId(l.target)) ?? endpointId(l.target),
      weight: null,
      colorValue: null,
      color: null,
      width: null,
    };
    if (widthCol) {
      const values = l.rows
        .map((r) => asNumber(r[widthCol]))
        .filter((v): v is number => v !== null);
      if (values.length > 0) link.weight = values.reduce((a, b) => a + b, 0) / values.length;
    }
    if (edgeColorCol) {
      const value = l.rows.map((r) => cellKey(r[edgeColorCol])).find((k) => k !== "") ?? null;
      if (edgeColorFromCells) link.color = parseColor(value);
      else link.colorValue = value;
    }
    // Edge type overrides land last for the same reason the node ones do.
    if (edgeTypeStyles !== undefined) {
      const kind =
        l.rows.map((r) => cellKey(r[edgeTypeStyles.column])).find((k) => k !== "") ?? null;
      if (kind !== null && Object.hasOwn(edgeTypeStyles.styles, kind)) {
        const override = edgeTypeStyles.styles[kind];
        if (override.color !== undefined) link.color = override.color;
        if (override.width !== undefined) link.width = clamp(override.width, CELL_WIDTH);
      }
    }
    return link;
  });

  const groups = ranking ? [] : countValues(nodes.map((n) => n.group));
  const edgeGroups = countValues(links.map((l) => l.colorValue));

  // The chosen curve travels with the range, so everyone asking `markColor`
  // reads the ramp the same way. Left off entirely when unset, which is the
  // linear read the ramp has always had.
  const extent = ranking ? extentOf(nodes.map((n) => n.value ?? 0)) : null;
  const rankRange: Graph["ranking"] =
    extent === null
      ? null
      : style.nodeColorCurve === undefined
        ? extent
        : { ...extent, curve: style.nodeColorCurve };

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

/**
 * Numeric value per node, taken as written: node table, else the first incident
 * row that has one. Nothing is summed, since a pixel size is a value rather
 * than a quantity to accumulate.
 */
function cellNumberAttr(base: BaseGraph, doc: GraphDoc, column: string): Map<string, number> {
  const values = new Map<string, number>();
  if (hasColumn(doc.nodes, column)) {
    for (const node of base.nodes) {
      const v = asNumber(node.row[column]);
      if (v !== null) values.set(node.id, v);
    }
    return values;
  }
  for (const row of base.rows) {
    const v = asNumber(row[column]);
    if (v === null) continue;
    for (const end of [cellToId(row[doc.mapping.source]), cellToId(row[doc.mapping.target])]) {
      if (end !== null && !values.has(end)) values.set(end, v);
    }
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

/**
 * What color a node is painted, wherever that came from: its own cell first,
 * then a ranking along the ramp, then its group's palette slot. The canvas, the
 * inspector and the GEXF writer all ask this, so they can't disagree.
 */
export function markColor(
  node: GraphNode,
  ranking: Graph["ranking"],
  colors: Map<string, string>,
  palette: Palette,
): string {
  if (node.color !== null) return node.color;
  if (ranking) {
    const span = ranking.max - ranking.min || 1;
    const t = ((node.value ?? ranking.min) - ranking.min) / span;
    return sequentialColor(curveFn(ranking.curve ?? "linear")(t), palette.sequential);
  }
  return nodeColor(node.group, colors, palette.categorical);
}

/**
 * Scale for edge stroke width when a width column is mapped. Widths taken
 * straight from a column are already in pixels, so they only get clamped.
 */
export function weightScale(
  links: GraphLink[],
  asPixels = false,
  curve: StyleCurve = "sqrt",
): (l: GraphLink) => number {
  if (asPixels) return (l) => (l.weight === null ? 1.4 : clamp(l.weight, CELL_WIDTH));
  const weights = links.map((l) => l.weight).filter((w): w is number => w !== null);
  const extent = extentOf(weights);
  if (extent === null) return () => 1.4;
  const { min, max } = extent;
  if (min === max) return () => 2;
  const shape = curveFn(curve);
  return (l) => {
    if (l.weight === null) return 1;
    const t = shape((l.weight - min) / (max - min));
    return 1 + t * 5;
  };
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
