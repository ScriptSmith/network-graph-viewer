import type {
  CellValue,
  Column,
  EdgeTypeStyle,
  GraphDoc,
  GraphStyle,
  Mapping,
  NodeTypeStyle,
  Row,
  Table,
  TypeStyles,
} from "../types";
import { styleColumn } from "../types";
import type { MetricRunResult } from "./metrics";
import { cellToId, edgeKey } from "./cells";
import { guessMapping } from "./parse";
import { parseColor } from "../theme";

export const DEFAULT_NODE_ID_COLUMN = "Id";

/** Column names that look like a node identifier in a supplied node table. */
const ID_HINTS = /^(id|name|label|node|node id|key)$/i;

export function columnNames(table: Table): string[] {
  return table.columns.map((c) => c.name);
}

export function hasColumn(table: Table, name: string): boolean {
  return table.columns.some((c) => c.name === name);
}

export function findColumn(table: Table, name: string): Column | undefined {
  return table.columns.find((c) => c.name === name);
}

/**
 * Every node's display name, from the node table alone.
 *
 * The built graph carries labels already, but only for the nodes on stage, and
 * the places that name a node the reader cannot currently see (the ego step's
 * seed picker and its chips) need the whole document's answer. Cached against
 * the rows and the column, so asking per chip costs one lookup.
 */
const labelCaches = new WeakMap<
  Row[],
  { column: string | null; idColumn: string; labels: Map<string, string> }
>();

export function nodeLabels(doc: GraphDoc, labelColumn: string | null): ReadonlyMap<string, string> {
  const column = labelColumn !== null && hasColumn(doc.nodes, labelColumn) ? labelColumn : null;
  const cached = labelCaches.get(doc.nodes.rows);
  // The id column is part of the key, the way `docIncidence` keys itself: the
  // rows can survive a change of which column names the nodes.
  if (cached !== undefined && cached.column === column && cached.idColumn === doc.nodeIdColumn) {
    return cached.labels;
  }

  const labels = new Map<string, string>();
  for (const row of doc.nodes.rows) {
    const id = cellToId(row[doc.nodeIdColumn]);
    if (id === null || labels.has(id)) continue;
    labels.set(id, (column === null ? null : cellToId(row[column])) ?? id);
  }
  labelCaches.set(doc.nodes.rows, { column, idColumn: doc.nodeIdColumn, labels });
  return labels;
}

/** A column name not already taken by the table, suffixed if it collides. */
export function uniqueColumnName(table: Table, base: string): string {
  if (!hasColumn(table, base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!hasColumn(table, candidate)) return candidate;
  }
}

/**
 * Every distinct edge endpoint as a node row, in order of first appearance.
 * This is the fallback when a dataset is an edge list and nothing else.
 */
export function deriveNodeTable(
  edgeRows: Row[],
  mapping: Mapping,
  idColumn = DEFAULT_NODE_ID_COLUMN,
): Table {
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const row of edgeRows) {
    for (const end of [cellToId(row[mapping.source]), cellToId(row[mapping.target])]) {
      if (end !== null && !seen.has(end)) {
        seen.add(end);
        rows.push({ [idColumn]: end });
      }
    }
  }
  return { name: "Nodes", columns: [{ name: idColumn, type: "text" }], rows };
}

/** The column of a supplied node table most likely to hold the node id. */
export function guessNodeIdColumn(table: Table): string {
  const hinted = table.columns.find((c) => ID_HINTS.test(c.name));
  const textual = table.columns.find((c) => c.type === "text");
  return (hinted ?? textual ?? table.columns[0])?.name ?? DEFAULT_NODE_ID_COLUMN;
}

/**
 * Assemble a working document. Without a node table the nodes are derived
 * from the edge endpoints, which is the plain edge-list case.
 */
export function buildDoc(
  name: string,
  edges: Table,
  options: { nodes?: Table; mapping?: Mapping; nodeAttrs?: string[] } = {},
): GraphDoc {
  const guessed = options.mapping ?? guessMapping(edges);
  const mapping =
    options.nodeAttrs === undefined ? guessed : { ...guessed, nodeAttrs: options.nodeAttrs };
  if (options.nodes) {
    const nodeIdColumn = guessNodeIdColumn(options.nodes);
    return reconcileNodes({
      name,
      edges,
      nodes: options.nodes,
      nodeIdColumn,
      mapping,
      nodesDeclared: true,
    });
  }
  return {
    name,
    edges,
    nodes: deriveNodeTable(edges.rows, mapping),
    nodeIdColumn: DEFAULT_NODE_ID_COLUMN,
    mapping,
    nodesDeclared: false,
  };
}

/**
 * Add a node row for every edge endpoint the node table is missing. Run after
 * any edit that can introduce an endpoint, so the Nodes tab and the canvas
 * never disagree about who exists.
 */
export function reconcileNodes(doc: GraphDoc): GraphDoc {
  const known = new Set<string>();
  for (const row of doc.nodes.rows) {
    const id = cellToId(row[doc.nodeIdColumn]);
    if (id !== null) known.add(id);
  }

  const added: Row[] = [];
  for (const row of doc.edges.rows) {
    for (const end of [cellToId(row[doc.mapping.source]), cellToId(row[doc.mapping.target])]) {
      if (end !== null && !known.has(end)) {
        known.add(end);
        added.push({ [doc.nodeIdColumn]: end });
      }
    }
  }
  if (added.length === 0) return doc;
  return { ...doc, nodes: { ...doc.nodes, rows: [...doc.nodes.rows, ...added] } };
}

/**
 * Columns that can drive node appearance, in resolution order: the node
 * table's own attributes first, then edge columns, which get projected onto
 * the nodes they touch.
 */
export function nodeStyleColumns(doc: GraphDoc): Column[] {
  const taken = new Set([doc.nodeIdColumn, doc.mapping.source, doc.mapping.target]);
  const out: Column[] = [];
  for (const c of [...doc.nodes.columns, ...doc.edges.columns]) {
    if (taken.has(c.name)) continue;
    taken.add(c.name);
    out.push(c);
  }
  return out;
}

/**
 * The node columns shown as details in tooltips and the inspector: the chosen
 * set where one was chosen, otherwise every column but the id.
 */
export function nodeDetailColumns(doc: GraphDoc): Column[] {
  const candidates = doc.nodes.columns.filter((c) => c.name !== doc.nodeIdColumn);
  const chosen = doc.mapping.nodeAttrs;
  if (chosen === undefined) return candidates;
  const set = new Set(chosen);
  return candidates.filter((c) => set.has(c.name));
}

/**
 * The same question for one particular node: its type may choose its own
 * details, and a type with no opinion falls back to the shared set. The row
 * itself answers what type the node is, so this stays a lookup, not a scan.
 */
export function nodeDetailColumnsFor(doc: GraphDoc, style: GraphStyle, row: Row): Column[] {
  const types = style.typeStyles;
  if (types !== undefined) {
    const kind = cellToId(row[types.column]);
    if (kind !== null && Object.hasOwn(types.styles, kind)) {
      const attrs = types.styles[kind].attrs;
      if (attrs !== undefined) {
        const set = new Set(attrs);
        return doc.nodes.columns.filter((c) => c.name !== doc.nodeIdColumn && set.has(c.name));
      }
    }
  }
  return nodeDetailColumns(doc);
}

/**
 * The edge side: a link merges every row with the same endpoints, and its
 * type is the first row that says one, matching how the styling reads it.
 */
export function edgeDetailColumnsFor(doc: GraphDoc, style: GraphStyle, rows: Row[]): string[] {
  const types = style.edgeTypeStyles;
  if (types !== undefined) {
    const kind = rows.map((r) => cellToId(r[types.column])).find((k) => k !== null) ?? null;
    if (kind !== null && Object.hasOwn(types.styles, kind)) {
      const attrs = types.styles[kind].attrs;
      if (attrs !== undefined) {
        const set = new Set(attrs);
        return doc.edges.columns
          .filter(
            (c) =>
              c.name !== doc.mapping.source && c.name !== doc.mapping.target && set.has(c.name),
          )
          .map((c) => c.name);
      }
    }
  }
  return doc.mapping.attrs;
}

/** Edge columns that aren't the source or target. */
export function edgeStyleColumns(doc: GraphDoc): Column[] {
  return doc.edges.columns.filter(
    (c) => c.name !== doc.mapping.source && c.name !== doc.mapping.target,
  );
}

/** What each style option falls back to when the column driving it goes away. */
const STYLE_FALLBACKS = {
  nodeColor: "none",
  nodeSize: "metric:degree",
  nodeImage: "none",
  nodeLabel: "none",
  edgeWidth: "uniform",
  edgeColor: "uniform",
} as const;

/**
 * Point the style at a column that has just been renamed, or off one that has
 * just been deleted. Style tokens name columns by string, so a column edit that
 * left them alone would silently un-style the graph.
 *
 * A token is only moved when it no longer resolves against `next`, which is the
 * document after the change: node styling falls back from the node table to the
 * edge columns, so renaming one table's copy of a name the other table also
 * carries should leave the token where it is, still answered.
 */
export function retargetStyle(
  style: GraphStyle,
  next: GraphDoc,
  from: string,
  to: string | null,
): GraphStyle {
  const move = <K extends keyof typeof STYLE_FALLBACKS>(key: K, resolves: boolean): string => {
    const token = style[key];
    if (styleColumn(token) !== from || resolves) return token;
    if (to === null) return STYLE_FALLBACKS[key];
    return `${token.slice(0, token.indexOf(":") + 1)}${to}`;
  };

  const onNodes = hasColumn(next.nodes, from) || hasColumn(next.edges, from);
  const onEdges = hasColumn(next.edges, from);
  // Labels never fall back to the edges, so only the node table answers them.
  const onNodeTable = hasColumn(next.nodes, from);

  return {
    ...style,
    nodeColor: move("nodeColor", onNodes),
    nodeSize: move("nodeSize", onNodes),
    nodeImage: move("nodeImage", onNodes),
    nodeLabel: move("nodeLabel", onNodeTable),
    edgeWidth: move("edgeWidth", onEdges),
    edgeColor: move("edgeColor", onEdges),
    typeStyles: retargetNodeTypes(style.typeStyles, from, to, onNodes, onNodeTable),
    edgeTypeStyles: retargetEdgeTypes(style.edgeTypeStyles, from, to, onEdges),
  };
}

/**
 * Type blocks name columns in two places: the type column itself, and inside
 * each override, where a label column or a chosen detail set does. A rename
 * follows into all of them; a delete drops exactly the part that named it,
 * the whole block for the type column, one field for the rest.
 */
function retargetNodeTypes(
  types: TypeStyles<NodeTypeStyle> | undefined,
  from: string,
  to: string | null,
  resolvesAnywhere: boolean,
  resolvesOnNodes: boolean,
): TypeStyles<NodeTypeStyle> | undefined {
  if (types === undefined) return undefined;
  let column = types.column;
  if (column === from && !resolvesAnywhere) {
    if (to === null) return undefined;
    column = to;
  }
  const styles = Object.create(null) as Record<string, NodeTypeStyle>;
  for (const [key, override] of Object.entries(types.styles)) {
    const moved: NodeTypeStyle = { ...override };
    if (moved.labelColumn === from && !resolvesOnNodes) {
      if (to === null) delete moved.labelColumn;
      else moved.labelColumn = to;
    }
    if (moved.attrs !== undefined && moved.attrs.includes(from) && !resolvesOnNodes) {
      moved.attrs =
        to === null
          ? moved.attrs.filter((a) => a !== from)
          : moved.attrs.map((a) => (a === from ? to : a));
    }
    styles[key] = moved;
  }
  return { column, styles };
}

function retargetEdgeTypes(
  types: TypeStyles<EdgeTypeStyle> | undefined,
  from: string,
  to: string | null,
  resolvesOnEdges: boolean,
): TypeStyles<EdgeTypeStyle> | undefined {
  if (types === undefined) return undefined;
  let column = types.column;
  if (column === from && !resolvesOnEdges) {
    if (to === null) return undefined;
    column = to;
  }
  const styles = Object.create(null) as Record<string, EdgeTypeStyle>;
  for (const [key, override] of Object.entries(types.styles)) {
    const moved: EdgeTypeStyle = { ...override };
    if (moved.attrs !== undefined && moved.attrs.includes(from) && !resolvesOnEdges) {
      moved.attrs =
        to === null
          ? moved.attrs.filter((a) => a !== from)
          : moved.attrs.map((a) => (a === from ? to : a));
    }
    styles[key] = moved;
  }
  return { column, styles };
}

/**
 * Columns whose cells are colors rather than categories, so they can paint the
 * marks themselves. Offered only when most of the column reads as a color: a
 * column of prose that happens to mention "red" is not a color column.
 */
export function colorCellColumns(doc: GraphDoc, scope: "nodes" | "edges"): Column[] {
  const candidates = scope === "nodes" ? nodeStyleColumns(doc) : edgeStyleColumns(doc);
  return candidates.filter((c) => {
    if (c.type !== "text") return false;
    // A declared role settles it either way; counting is for the undeclared.
    if (c.role !== undefined) return c.role === "color";
    // Node styling resolves against the node table first, so that is where the
    // cells are read from when both tables happen to carry the name.
    const rows =
      scope === "nodes" && hasColumn(doc.nodes, c.name) ? doc.nodes.rows : doc.edges.rows;
    let filled = 0;
    let colors = 0;
    for (const row of rows) {
      const value = cellToId(row[c.name]);
      if (value === null) continue;
      filled++;
      if (parseColor(value) !== null) colors++;
    }
    return filled > 0 && colors * 2 >= filled;
  });
}

/**
 * Replace or append a column, filling it from a per-row value function. Used
 * by the metrics compute step, which writes its results as ordinary columns.
 */
export function withColumn(
  table: Table,
  column: Column,
  valueFor: (row: Row, index: number) => CellValue,
): Table {
  const columns = hasColumn(table, column.name)
    ? table.columns.map((c) => (c.name === column.name ? column : c))
    : [...table.columns, column];
  const rows = table.rows.map((row, i) => ({ ...row, [column.name]: valueFor(row, i) }));
  return { ...table, columns, rows };
}

/** Drop a column and its values. */
export function withoutColumn(table: Table, name: string): Table {
  if (!hasColumn(table, name)) return table;
  return {
    ...table,
    columns: table.columns.filter((c) => c.name !== name),
    rows: table.rows.map((row) => {
      const next = { ...row };
      delete next[name];
      return next;
    }),
  };
}

/** Drop every column the compute step wrote, restoring the imported shape. */
export function withoutComputedColumns(table: Table): Table {
  const computed = table.columns.filter((c) => c.computed).map((c) => c.name);
  return computed.reduce(withoutColumn, table);
}

export function clearComputedColumns(doc: GraphDoc): GraphDoc {
  return {
    ...doc,
    nodes: withoutComputedColumns(doc.nodes),
    edges: withoutComputedColumns(doc.edges),
  };
}

/**
 * Write metric results into the document as ordinary columns. A metric never
 * overwrites a column the user brought with them: if the name is taken by
 * imported data, the result gets a suffixed name instead.
 */
export function applyComputedColumns(doc: GraphDoc, result: MetricRunResult): GraphDoc {
  const nameFor = (table: Table, wanted: string) => {
    const existing = findColumn(table, wanted);
    return existing === undefined || existing.computed ? wanted : uniqueColumnName(table, wanted);
  };

  let nodes = doc.nodes;
  for (const column of result.nodeColumns) {
    const name = nameFor(nodes, column.name);
    nodes = withColumn(nodes, { name, type: column.type, computed: true }, (row) => {
      const id = cellToId(row[doc.nodeIdColumn]);
      // By own property: a node id is whatever a cell said, and a cell saying
      // "toString" would otherwise read a function off the prototype.
      return id !== null && Object.hasOwn(column.values, id) ? column.values[id] : null;
    });
  }

  let edges = doc.edges;
  for (const column of result.edgeColumns) {
    const name = nameFor(edges, column.name);
    edges = withColumn(edges, { name, type: column.type, computed: true }, (row) => {
      const source = cellToId(row[doc.mapping.source]);
      const target = cellToId(row[doc.mapping.target]);
      if (source === null || target === null) return null;
      const key = edgeKey(source, target);
      return Object.hasOwn(column.values, key) ? column.values[key] : null;
    });
  }

  return { ...doc, nodes, edges };
}
