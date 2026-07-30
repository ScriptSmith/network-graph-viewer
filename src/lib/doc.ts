import type { CellValue, Column, GraphDoc, Mapping, Row, Table } from "../types";
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
  options: { nodes?: Table; mapping?: Mapping } = {},
): GraphDoc {
  const mapping = options.mapping ?? guessMapping(edges);
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

/** Edge columns that aren't the source or target. */
export function edgeStyleColumns(doc: GraphDoc): Column[] {
  return doc.edges.columns.filter(
    (c) => c.name !== doc.mapping.source && c.name !== doc.mapping.target,
  );
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
      return id === null ? null : (column.values[id] ?? null);
    });
  }

  let edges = doc.edges;
  for (const column of result.edgeColumns) {
    const name = nameFor(edges, column.name);
    edges = withColumn(edges, { name, type: column.type, computed: true }, (row) => {
      const source = cellToId(row[doc.mapping.source]);
      const target = cellToId(row[doc.mapping.target]);
      if (source === null || target === null) return null;
      return column.values[edgeKey(source, target)] ?? null;
    });
  }

  return { ...doc, nodes, edges };
}
