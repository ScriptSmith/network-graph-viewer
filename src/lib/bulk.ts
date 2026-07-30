import type { CellValue, Column, ColumnType, GraphDoc, Row, Table } from "../types";
import { cellKey, cellToId, parseCell } from "./cells";
import { hasColumn, reconcileNodes, uniqueColumnName } from "./doc";
import { coalesceById, tableOf, withTable, type EditTarget } from "./edit";
import { asNumber } from "./parse";

/**
 * Bulk edits: one act over many cells, many rows or a whole column. Same shape
 * as the single-cell transforms in edit.ts, pure `GraphDoc -> GraphDoc`, so
 * each one lands in the undo history as a single step however many cells it
 * touched.
 *
 * Renaming or deleting a column changes more than the document: style tokens,
 * filter steps and the drawer's own grouping all name columns by string. Those
 * live outside the document, so the caller repairs them; what is in here is
 * only ever the document's half of the change.
 */

/** The rows an edit acts on: the ones in view, or every row when null. */
export type RowScope = ReadonlySet<Row> | null;

/**
 * Rewrite one column's cells through a function. Every value-level bulk edit
 * comes down to this, including the two that are not really value edits: on the
 * node id column it is a rename, so the new ids have to travel into both
 * endpoint columns and rows landing on the same id fold together; on an
 * endpoint column it can name a node nobody has declared yet.
 */
export function mapColumn(
  doc: GraphDoc,
  target: EditTarget,
  column: string,
  scope: RowScope,
  map: (value: CellValue, row: Row) => CellValue,
): GraphDoc {
  const table = tableOf(doc, target);
  if (!hasColumn(table, column)) return doc;

  let changed = false;
  const rows = table.rows.map((row) => {
    if (scope !== null && !scope.has(row)) return row;
    const value = map(row[column] ?? null, row);
    if (value === (row[column] ?? null)) return row;
    changed = true;
    return { ...row, [column]: value };
  });
  if (!changed) return doc;

  if (target === "edges") {
    const next = withTable(doc, "edges", { ...table, rows });
    return column === doc.mapping.source || column === doc.mapping.target
      ? reconcileNodes(next)
      : next;
  }

  if (column !== doc.nodeIdColumn) {
    return withTable(doc, "nodes", { ...table, rows });
  }

  const renames = new Map<string, string>();
  table.rows.forEach((row, i) => {
    const from = cellToId(row[doc.nodeIdColumn]);
    const to = cellToId(rows[i][doc.nodeIdColumn]);
    if (from !== null && to !== null && from !== to) renames.set(from, to);
  });
  return {
    ...doc,
    nodes: { ...table, rows: coalesceById(rows, doc.nodeIdColumn) },
    edges: renames.size === 0 ? doc.edges : remapEndpoints(doc, renames),
    nodesDeclared: true,
  };
}

/** Carry a batch of node renames into both endpoint columns at once. */
function remapEndpoints(doc: GraphDoc, renames: ReadonlyMap<string, string>): Table {
  const { source, target } = doc.mapping;
  return {
    ...doc.edges,
    rows: doc.edges.rows.map((row) => {
      const s = renames.get(cellToId(row[source]) ?? "");
      const t = renames.get(cellToId(row[target]) ?? "");
      if (s === undefined && t === undefined) return row;
      const next = { ...row };
      if (s !== undefined) next[source] = s;
      if (t !== undefined) next[target] = t;
      return next;
    }),
  };
}

/* ---- Values ---- */

export interface ReplaceSpec {
  find: string;
  replace: string;
  /** Read `find` as a regular expression rather than as literal text. */
  regex: boolean;
  caseSensitive: boolean;
  /** Match only when the pattern covers the cell end to end. */
  wholeCell: boolean;
}

export type Replacer = (text: string) => string;

const escapeRegex = (source: string) => source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compile a find and replace into a function over cell text, or say why it
 * would not compile. Literal text is escaped into the same machinery a pattern
 * uses, so there is one substitution path rather than two that can disagree.
 * A `$` in the replacement is the user's own character in text mode and a group
 * reference in regex mode, which is the only difference between them.
 */
export function compileReplace(spec: ReplaceSpec): Replacer | { error: string } {
  const body = spec.regex ? spec.find : escapeRegex(spec.find);
  const source = spec.wholeCell ? `^(?:${body})$` : body;
  try {
    const pattern = new RegExp(source, spec.caseSensitive ? "g" : "gi");
    const replacement = spec.regex ? spec.replace : spec.replace.replace(/\$/g, "$$$$");
    return (text: string) => text.replace(pattern, replacement);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "That is not a valid pattern." };
  }
}

export const replaceFailed = (r: Replacer | { error: string }): r is { error: string } =>
  typeof r !== "function";

/**
 * Cells a replacer would change, as row objects, so the control can say how
 * much is about to happen before it happens.
 */
export function replaceMatches(
  table: Table,
  column: string,
  scope: RowScope,
  apply: Replacer,
): Row[] {
  return table.rows.filter((row) => {
    if (scope !== null && !scope.has(row)) return false;
    const value = row[column];
    if (value === null || value === undefined) return false;
    const text = String(value);
    return apply(text) !== text;
  });
}

/**
 * Find and replace over one column. Blank cells are left alone: an empty cell
 * has no text to match, and a pattern that would fill every hole in a column is
 * the fill operation, not this one.
 */
export function replaceInColumn(
  doc: GraphDoc,
  target: EditTarget,
  column: string,
  scope: RowScope,
  apply: Replacer,
): GraphDoc {
  const type = columnType(tableOf(doc, target), column);
  return mapColumn(doc, target, column, scope, (value) => {
    if (value === null) return null;
    const text = String(value);
    const next = apply(text);
    return next === text ? value : parseCell(type, next);
  });
}

/**
 * Rename values wholesale: every cell keying to one of the old values takes the
 * new one. On the node id column this is how nodes are merged, since renaming
 * several ids to one id leaves one node with everything the others' edges had.
 */
export function renameValues(
  doc: GraphDoc,
  target: EditTarget,
  column: string,
  renames: ReadonlyMap<string, string>,
  scope: RowScope,
): GraphDoc {
  const type = columnType(tableOf(doc, target), column);
  return mapColumn(doc, target, column, scope, (value) => {
    const next = renames.get(cellKey(value));
    return next === undefined ? value : parseCell(type, next);
  });
}

/** Merge nodes into one, rewiring every edge that named any of them. */
export function mergeNodes(doc: GraphDoc, ids: string[], into: string): GraphDoc {
  const renames = new Map<string, string>();
  for (const id of ids) {
    if (id !== into) renames.set(id, into);
  }
  if (renames.size === 0) return doc;
  return renameValues(doc, "nodes", doc.nodeIdColumn, renames, null);
}

/**
 * Write one value across a column. "Only blanks" is the common case by a long
 * way: filling holes left by an import is not the same act as overwriting data
 * somebody already has.
 */
export function fillColumn(
  doc: GraphDoc,
  target: EditTarget,
  column: string,
  value: CellValue,
  onlyBlanks: boolean,
  scope: RowScope,
): GraphDoc {
  return mapColumn(doc, target, column, scope, (current) =>
    onlyBlanks && current !== null ? current : value,
  );
}

/* ---- Columns ---- */

function columnType(table: Table, name: string): ColumnType {
  return table.columns.find((c) => c.name === name)?.type ?? "text";
}

/** Columns that hold the graph together, so they can be renamed but not removed. */
export function structuralColumns(doc: GraphDoc, target: EditTarget): Set<string> {
  return target === "nodes"
    ? new Set([doc.nodeIdColumn])
    : new Set([doc.mapping.source, doc.mapping.target]);
}

/**
 * Rename a column, carrying the new name to everything inside the document that
 * referred to the old one: the node id column, the endpoint mapping and the
 * edge attributes shown in tooltips.
 */
export function renameColumn(
  doc: GraphDoc,
  target: EditTarget,
  from: string,
  to: string,
): GraphDoc {
  const table = tableOf(doc, target);
  const name = to.trim();
  if (name === "" || name === from || !hasColumn(table, from) || hasColumn(table, name)) return doc;

  const renamed: Table = {
    ...table,
    columns: table.columns.map((c) => (c.name === from ? { ...c, name } : c)),
    // Rebuilt rather than patched, so the key order still follows the columns.
    rows: table.rows.map((row) => {
      const next: Row = {};
      for (const [key, value] of Object.entries(row)) next[key === from ? name : key] = value;
      return next;
    }),
  };

  const next = withTable(doc, target, renamed);
  if (target === "nodes") {
    return doc.nodeIdColumn === from ? { ...next, nodeIdColumn: name } : next;
  }
  const swap = (c: string) => (c === from ? name : c);
  return {
    ...next,
    mapping: {
      source: swap(doc.mapping.source),
      target: swap(doc.mapping.target),
      attrs: doc.mapping.attrs.map(swap),
    },
  };
}

/** Drop a column and its values. Structural columns refuse: nothing works without them. */
export function deleteColumn(doc: GraphDoc, target: EditTarget, name: string): GraphDoc {
  const table = tableOf(doc, target);
  if (!hasColumn(table, name) || structuralColumns(doc, target).has(name)) return doc;

  const next = withTable(doc, target, {
    ...table,
    columns: table.columns.filter((c) => c.name !== name),
    rows: table.rows.map((row) => {
      const copy = { ...row };
      delete copy[name];
      return copy;
    }),
  });
  return target === "edges"
    ? { ...next, mapping: { ...next.mapping, attrs: next.mapping.attrs.filter((c) => c !== name) } }
    : next;
}

/**
 * Put the columns in a given order. Names the order leaves out keep their
 * relative places at the end, so a partial order is still an order.
 */
export function reorderColumns(doc: GraphDoc, target: EditTarget, order: string[]): GraphDoc {
  const table = tableOf(doc, target);
  const rank = new Map(order.map((name, i) => [name, i]));
  const columns = table.columns
    .map((column, i) => ({ column, key: rank.get(column.name) ?? order.length + i }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.column);
  if (columns.every((c, i) => c === table.columns[i])) return doc;

  const names = columns.map((c) => c.name);
  return withTable(doc, target, {
    ...table,
    columns,
    // The rows carry the order too: a CSV or a GEXF written straight from them
    // should come out in the order the table is showing.
    rows: table.rows.map((row) => {
      const next: Row = {};
      for (const name of names) {
        if (name in row) next[name] = row[name];
      }
      for (const [key, value] of Object.entries(row)) {
        if (!(key in next)) next[key] = value;
      }
      return next;
    }),
  });
}

/** A new empty column at the end of the table. */
export function addColumn(
  doc: GraphDoc,
  target: EditTarget,
  name: string,
  type: ColumnType = "text",
): GraphDoc {
  const table = tableOf(doc, target);
  const wanted = name.trim();
  if (wanted === "" || hasColumn(table, wanted)) return doc;
  return withTable(doc, target, {
    ...table,
    columns: [...table.columns, { name: wanted, type }],
    rows: table.rows.map((row) => ({ ...row, [wanted]: null })),
  });
}

/**
 * Copy a column, values and all, next to the original. The copy is never marked
 * computed even when the original was: it is the user's now, and the compute
 * panel's "clear computed columns" should not take it away.
 */
export function duplicateColumn(doc: GraphDoc, target: EditTarget, name: string): GraphDoc {
  const table = tableOf(doc, target);
  const source = table.columns.find((c) => c.name === name);
  if (!source) return doc;

  const copy: Column = { name: uniqueColumnName(table, `${name} copy`), type: source.type };
  const at = table.columns.indexOf(source) + 1;
  return withTable(doc, target, {
    ...table,
    columns: [...table.columns.slice(0, at), copy, ...table.columns.slice(at)],
    rows: table.rows.map((row) => ({ ...row, [copy.name]: row[name] ?? null })),
  });
}

/**
 * Read a cell the way a column of this type holds it, or null when it cannot be
 * read that way at all.
 */
export function coerceCell(value: CellValue, type: ColumnType): CellValue {
  if (value === null) return null;
  if (type === "number") return asNumber(value);
  if (type === "bool") {
    if (typeof value === "boolean") return value;
    const lowered = String(value).trim().toLowerCase();
    if (["true", "yes", "1"].includes(lowered)) return true;
    if (["false", "no", "0"].includes(lowered)) return false;
    return null;
  }
  return typeof value === "string" ? value : String(value);
}

/** Cells that a retype would empty, because they cannot be read as that type. */
export function retypeLosses(table: Table, name: string, type: ColumnType): number {
  let losses = 0;
  for (const row of table.rows) {
    const value = row[name] ?? null;
    if (value !== null && coerceCell(value, type) === null) losses++;
  }
  return losses;
}

/**
 * Change a column's type and re-read its cells accordingly. The type is set
 * once at import and everything downstream trusts it, so a column that was
 * inferred wrong is fixed here rather than worked around everywhere else.
 */
export function retypeColumn(
  doc: GraphDoc,
  target: EditTarget,
  name: string,
  type: ColumnType,
): GraphDoc {
  const table = tableOf(doc, target);
  const column = table.columns.find((c) => c.name === name);
  if (!column || column.type === type) return doc;

  const retyped = withTable(doc, target, {
    ...table,
    columns: table.columns.map((c) => (c.name === name ? { ...c, type } : c)),
    rows: table.rows.map((row) => ({ ...row, [name]: coerceCell(row[name] ?? null, type) })),
  });
  // Emptying the id column would orphan the edges that still name those nodes,
  // so the reconcile puts the rows back rather than leaving a broken document.
  return target === "nodes" && name === doc.nodeIdColumn ? reconcileNodes(retyped) : retyped;
}
