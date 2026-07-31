import type { CellValue, GraphDoc, Row, Table } from "../types";
import { cellToId } from "./cells";
import { reconcileNodes } from "./doc";

/**
 * Table edits, as pure transforms. The graph is derived from these two tables,
 * so editing a cell in the data table is the only editing there is: there is
 * no separate mutable graph to keep in step.
 */

export type EditTarget = "nodes" | "edges";

export const tableOf = (doc: GraphDoc, target: EditTarget): Table =>
  target === "nodes" ? doc.nodes : doc.edges;

export function withTable(doc: GraphDoc, target: EditTarget, table: Table): GraphDoc {
  return target === "nodes"
    ? { ...doc, nodes: table, nodesDeclared: true }
    : { ...doc, edges: table };
}

/**
 * Fold node rows that have come to share an id into the first of them. Two rows
 * answering to one id is not a state the graph can render: `buildBaseGraph`
 * takes the first and the rest are a ghost in the Nodes tab. The survivor keeps
 * everything it had and takes only what it was missing, so a merge never
 * overwrites an attribute, it only fills a hole.
 */
export function coalesceById(rows: Row[], idColumn: string): Row[] {
  const byId = new Map<string, Row>();
  const out: Row[] = [];
  let merged = false;
  for (const row of rows) {
    const id = cellToId(row[idColumn]);
    const kept = id === null ? undefined : byId.get(id);
    if (kept === undefined) {
      const copy = { ...row };
      if (id !== null) byId.set(id, copy);
      out.push(copy);
      continue;
    }
    merged = true;
    for (const [key, value] of Object.entries(row)) {
      // By own property, so a column named after something on the prototype
      // does not read as already filled on every row it touches.
      const held = Object.hasOwn(kept, key) ? kept[key] : null;
      if (held === null && value !== null) kept[key] = value;
    }
  }
  return merged ? out : rows;
}

/** A node id that is not already taken, based on a preferred stem. */
export function freeNodeId(doc: GraphDoc, stem = "New node"): string {
  const taken = new Set(doc.nodes.rows.map((r) => cellToId(r[doc.nodeIdColumn])));
  if (!taken.has(stem)) return stem;
  for (let i = 2; ; i++) {
    const candidate = `${stem} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Write one cell. Changing a node's id is a rename, which has to travel to
 * both endpoint columns of every edge that names it, so it is handled apart
 * from an ordinary value edit.
 */
export function setCell(
  doc: GraphDoc,
  target: EditTarget,
  rowIndex: number,
  column: string,
  value: CellValue,
): GraphDoc {
  const table = tableOf(doc, target);
  const row = table.rows[rowIndex];
  if (!row) return doc;

  if (target === "nodes" && column === doc.nodeIdColumn) {
    const from = cellToId(row[doc.nodeIdColumn]);
    const to = cellToId(value);
    if (from === null || to === null || from === to) return doc;
    return renameNode(doc, from, to);
  }

  const rows = table.rows.map((r, i) => (i === rowIndex ? { ...r, [column]: value } : r));
  const next = withTable(doc, target, { ...table, rows });
  return target === "edges" ? reconcileNodes(next) : next;
}

/**
 * Rename a node, carrying the new id into every edge that referenced it.
 * Renaming onto an id that already exists is a merge, not a collision: the two
 * rows become one and every edge that named either now names the survivor.
 */
export function renameNode(doc: GraphDoc, from: string, to: string): GraphDoc {
  if (from === to) return doc;
  const renamed = doc.nodes.rows.map((row) =>
    cellToId(row[doc.nodeIdColumn]) === from ? { ...row, [doc.nodeIdColumn]: to } : row,
  );
  const nodes = { ...doc.nodes, rows: coalesceById(renamed, doc.nodeIdColumn) };
  const { source, target } = doc.mapping;
  const edges = {
    ...doc.edges,
    // A row that named neither end is handed back as it was. The history keeps
    // whole documents on the understanding that an edit copies only the rows it
    // touches, and a rename touches the rows that named the node.
    rows: doc.edges.rows.map((row) => {
      const hitSource = cellToId(row[source]) === from;
      const hitTarget = cellToId(row[target]) === from;
      if (!hitSource && !hitTarget) return row;
      const next = { ...row };
      if (hitSource) next[source] = to;
      if (hitTarget) next[target] = to;
      return next;
    }),
  };
  return { ...doc, nodes, edges, nodesDeclared: true };
}

export function addNode(doc: GraphDoc, id = freeNodeId(doc)): GraphDoc {
  const row: Row = {};
  for (const column of doc.nodes.columns) row[column.name] = null;
  row[doc.nodeIdColumn] = id;
  return {
    ...doc,
    nodes: { ...doc.nodes, rows: [...doc.nodes.rows, row] },
    nodesDeclared: true,
  };
}

/** Remove nodes and every edge that touched them. */
export function deleteNodes(doc: GraphDoc, ids: string[]): GraphDoc {
  const gone = new Set(ids);
  if (gone.size === 0) return doc;
  const { source, target } = doc.mapping;
  return {
    ...doc,
    nodes: {
      ...doc.nodes,
      rows: doc.nodes.rows.filter((row) => !gone.has(cellToId(row[doc.nodeIdColumn]) ?? "")),
    },
    edges: {
      ...doc.edges,
      rows: doc.edges.rows.filter(
        (row) => !gone.has(cellToId(row[source]) ?? "") && !gone.has(cellToId(row[target]) ?? ""),
      ),
    },
    nodesDeclared: true,
  };
}

/** An empty row, which for the node table still needs a fresh id. */
export function addRow(doc: GraphDoc, target: EditTarget): GraphDoc {
  if (target === "nodes") return addNode(doc);
  const row: Row = {};
  for (const column of doc.edges.columns) row[column.name] = null;
  return { ...doc, edges: { ...doc.edges, rows: [...doc.edges.rows, row] } };
}

export function deleteRows(doc: GraphDoc, target: EditTarget, indexes: number[]): GraphDoc {
  const gone = new Set(indexes);
  if (gone.size === 0) return doc;
  if (target === "nodes") {
    const ids = doc.nodes.rows
      .filter((_, i) => gone.has(i))
      .map((row) => cellToId(row[doc.nodeIdColumn]))
      .filter((id): id is string => id !== null);
    return deleteNodes(doc, ids);
  }
  const rows = doc.edges.rows.filter((_, i) => !gone.has(i));
  return { ...doc, edges: { ...doc.edges, rows } };
}
