import type { CellValue, ColumnType, GraphDoc, Row, Table } from "../types";
import { cellToId, compoundKey, splitKey } from "./cells";
import { reconcileNodes } from "./doc";
import { renameNode, type EditTarget } from "./edit";
import { addColumn, deleteColumn, renameColumn, retypeColumn } from "./bulk";

/**
 * The edits overlay: what the user has done to the tables, kept apart from
 * the tables themselves, so "update data" can pour a fresh file underneath
 * and lay the same work back on top. The policy is the proven one for this
 * problem: edited cells win, unedited cells track the new file, edited rows
 * survive their source vanishing, and deletions hold.
 *
 * Row identity. Nodes go by their id, tracked through `idRenames`, since a
 * rename has to replay onto incoming rows or the old id would resurrect.
 * Edges go by source, target and occurrence index among rows with the same
 * endpoints, which makes edge-cell edits best-effort when a new file changes
 * how many parallel rows a pair has; that is the documented trade.
 *
 * Recording happens by diffing each edit's before and after documents inside
 * the history hook, so nothing that changes the document can slip past it,
 * and undoing a step rewinds the overlay with the snapshot it rode in on.
 */

export type ColumnOp =
  | { op: "add"; table: EditTarget; name: string; type: ColumnType }
  | { op: "rename"; table: EditTarget; from: string; to: string }
  | { op: "delete"; table: EditTarget; name: string }
  | { op: "retype"; table: EditTarget; name: string; type: ColumnType };

export interface EditsOverlay {
  /** `compoundKey(table, ...rowKey, column)` per cell the user edited. */
  dirtyCells: ReadonlySet<string>;
  /** `compoundKey(table, ...rowKey)` per row the user deleted. */
  tombstones: ReadonlySet<string>;
  /** `compoundKey(table, ...rowKey)` per row the user created. */
  addedRows: ReadonlySet<string>;
  /** Node renames and merges, in the order they were made. */
  idRenames: readonly { from: string; to: string }[];
  /** Added, renamed, deleted and retyped columns, in order. */
  columnOps: readonly ColumnOp[];
}

export const EMPTY_OVERLAY: EditsOverlay = {
  dirtyCells: new Set(),
  tombstones: new Set(),
  addedRows: new Set(),
  idRenames: [],
  columnOps: [],
};

export function overlayIsEmpty(overlay: EditsOverlay): boolean {
  return (
    overlay.dirtyCells.size === 0 &&
    overlay.tombstones.size === 0 &&
    overlay.addedRows.size === 0 &&
    overlay.idRenames.length === 0 &&
    overlay.columnOps.length === 0
  );
}

/* ---- Row identity ---- */

const nodeRowKey = (id: string) => compoundKey("nodes", id);

/**
 * Keys for edge rows in table order: source, target, and how many rows with
 * the same pair came before. Rows with a blank endpoint have no identity to
 * track and key to null.
 */
export function edgeRowKeys(doc: GraphDoc, rows: readonly Row[]): (string | null)[] {
  const counts = new Map<string, number>();
  return rows.map((row) => {
    const s = cellToId(row[doc.mapping.source]);
    const t = cellToId(row[doc.mapping.target]);
    if (s === null || t === null) return null;
    const pair = compoundKey(s, t);
    const n = counts.get(pair) ?? 0;
    counts.set(pair, n + 1);
    return compoundKey("edges", s, t, n);
  });
}

/* ---- Recording: diff one edit's before and after ---- */

const cell = (row: Row | undefined, column: string): CellValue => {
  const v = row?.[column];
  return v === undefined ? null : v;
};

/** Node id per row, through the id column the document names. */
const nodeIds = (doc: GraphDoc): (string | null)[] =>
  doc.nodes.rows.map((row) => cellToId(row[doc.nodeIdColumn]));

interface ColumnDiff {
  ops: ColumnOp[];
  /** before-name to after-name, for the row diff to compare through. */
  renamed: Map<string, string>;
}

/**
 * Column changes per table, computed columns excluded: those are re-derived
 * from the recipe rather than replayed as edits. A single delete paired with
 * a single add whose cells match positionally is a rename, which matters
 * because replaying delete-then-add onto a fresh file would drop the values
 * a rename carries.
 */
function diffColumns(table: EditTarget, before: Table, after: Table): ColumnDiff {
  const ops: ColumnOp[] = [];
  const renamed = new Map<string, string>();
  const bCols = new Map(before.columns.filter((c) => !c.computed).map((c) => [c.name, c]));
  const aCols = new Map(after.columns.filter((c) => !c.computed).map((c) => [c.name, c]));

  const added = [...aCols.values()].filter((c) => !bCols.has(c.name));
  const deleted = [...bCols.values()].filter((c) => !aCols.has(c.name));

  if (added.length === 1 && deleted.length === 1 && added[0].type === deleted[0].type) {
    const same =
      before.rows.length === after.rows.length &&
      before.rows.every(
        (row, i) => cell(row, deleted[0].name) === cell(after.rows[i], added[0].name),
      );
    if (same) {
      ops.push({ op: "rename", table, from: deleted[0].name, to: added[0].name });
      renamed.set(deleted[0].name, added[0].name);
    }
  }
  if (renamed.size === 0) {
    for (const c of added) ops.push({ op: "add", table, name: c.name, type: c.type });
    for (const c of deleted) ops.push({ op: "delete", table, name: c.name });
  }
  for (const [name, c] of aCols) {
    const was = bCols.get(name);
    if (was !== undefined && was.type !== c.type) {
      ops.push({ op: "retype", table, name, type: c.type });
    }
  }
  return { ops, renamed };
}

/**
 * Node renames read off the shape of the change rather than reported by the
 * call sites, which hand up opaque transforms. A pure rename keeps the node
 * row count and swaps the id at the same index for a fresh one; a merge
 * shrinks the node table but leaves every edge row in place with rewritten
 * endpoints, so the renames are read off the endpoints instead. A node that
 * vanished without either signature was deleted.
 */
function detectRenames(before: GraphDoc, after: GraphDoc): Map<string, string> {
  const renames = new Map<string, string>();
  const beforeIds = nodeIds(before);
  const beforeSet = new Set(beforeIds);
  const afterSet = new Set(nodeIds(after));
  const removed = [...beforeSet].filter((id) => id !== null && !afterSet.has(id));
  if (removed.length === 0) return renames;

  if (before.nodes.rows.length === after.nodes.rows.length) {
    after.nodes.rows.forEach((row, i) => {
      const from = beforeIds[i];
      const to = cellToId(row[after.nodeIdColumn]);
      if (from !== null && to !== null && from !== to && !beforeSet.has(to)) {
        renames.set(from, to);
      }
    });
    return renames;
  }

  if (before.edges.rows.length === after.edges.rows.length) {
    const removedSet = new Set(removed);
    before.edges.rows.forEach((row, i) => {
      const arow = after.edges.rows[i];
      const ends: [string, string][] = [
        [before.mapping.source, after.mapping.source],
        [before.mapping.target, after.mapping.target],
      ];
      for (const [bCol, aCol] of ends) {
        const from = cellToId(row[bCol]);
        const to = cellToId(arow?.[aCol] ?? null);
        if (from !== null && to !== null && from !== to && removedSet.has(from)) {
          renames.set(from, to);
        }
      }
    });
  }
  return renames;
}

/** The overlay delta one edit produced, computed from its two documents. */
export function diffDocs(before: GraphDoc, after: GraphDoc): EditsOverlay {
  const dirtyCells = new Set<string>();
  const tombstones = new Set<string>();
  const addedRows = new Set<string>();

  const nodeCols = diffColumns("nodes", before.nodes, after.nodes);
  const edgeCols = diffColumns("edges", before.edges, after.edges);
  const columnOps = [...nodeCols.ops, ...edgeCols.ops];

  const renames = detectRenames(before, after);
  const mapId = (id: string) => renames.get(id) ?? id;

  // Node rows, matched by id with the renames already applied, so a rename
  // is a rename and not a delete plus a stranger.
  if (before.nodes !== after.nodes || renames.size > 0) {
    const beforeById = new Map<string, Row>();
    for (const row of before.nodes.rows) {
      const id = cellToId(row[before.nodeIdColumn]);
      if (id !== null && !beforeById.has(mapId(id))) beforeById.set(mapId(id), row);
    }
    const afterIds = new Set<string>();
    const beforeNames = new Map([...nodeCols.renamed].map(([from, to]) => [to, from]));
    const comparable = after.nodes.columns.filter(
      (c) => !c.computed && c.name !== after.nodeIdColumn,
    );
    for (const row of after.nodes.rows) {
      const id = cellToId(row[after.nodeIdColumn]);
      if (id === null) continue;
      afterIds.add(id);
      const was = beforeById.get(id);
      if (was === undefined) {
        addedRows.add(nodeRowKey(id));
        continue;
      }
      for (const column of comparable) {
        const oldName = beforeNames.get(column.name) ?? column.name;
        if (cell(row, column.name) !== cell(was, oldName)) {
          dirtyCells.add(compoundKey("nodes", id, column.name));
        }
      }
    }
    for (const id of beforeById.keys()) {
      if (!afterIds.has(id)) tombstones.add(nodeRowKey(id));
    }
  }

  // Edge rows, matched by endpoint-pair-and-occurrence keys, before keyed
  // through the renames for the same reason.
  if (before.edges !== after.edges || renames.size > 0) {
    const renamedBefore =
      renames.size === 0
        ? before
        : {
            ...before,
            edges: {
              ...before.edges,
              rows: before.edges.rows.map((row) => {
                const s = cellToId(row[before.mapping.source]);
                const t = cellToId(row[before.mapping.target]);
                const next = { ...row };
                if (s !== null) next[before.mapping.source] = mapId(s);
                if (t !== null) next[before.mapping.target] = mapId(t);
                return next;
              }),
            },
          };
    const bKeys = edgeRowKeys(renamedBefore, renamedBefore.edges.rows);
    const aKeys = edgeRowKeys(after, after.edges.rows);
    const beforeByKey = new Map<string, Row>();
    bKeys.forEach((key, i) => {
      if (key !== null) beforeByKey.set(key, before.edges.rows[i]);
    });
    const afterKeySet = new Set<string>();
    const beforeNames = new Map([...edgeCols.renamed].map(([from, to]) => [to, from]));
    const comparable = after.edges.columns.filter(
      (c) => !c.computed && c.name !== after.mapping.source && c.name !== after.mapping.target,
    );
    aKeys.forEach((key, i) => {
      if (key === null) return;
      afterKeySet.add(key);
      const row = after.edges.rows[i];
      const was = beforeByKey.get(key);
      if (was === undefined) {
        addedRows.add(key);
        return;
      }
      // Reference-equal rows have not changed; the transforms copy only what
      // they touch, and this is what keeps the diff cheap per keystroke.
      if (was === row) return;
      for (const column of comparable) {
        const oldName = beforeNames.get(column.name) ?? column.name;
        if (cell(row, column.name) !== cell(was, oldName)) {
          dirtyCells.add(compoundKey(key, column.name));
        }
      }
    });
    for (const key of beforeByKey.keys()) {
      if (!afterKeySet.has(key)) tombstones.add(key);
    }
  }

  return {
    dirtyCells,
    tombstones,
    addedRows,
    idRenames: [...renames].map(([from, to]) => ({ from, to })),
    columnOps,
  };
}

/* ---- Accumulation ---- */

/** Rewrite one overlay key's node id through a rename. */
function renameInKey(key: string, from: string, to: string): string {
  const parts = splitKey(key);
  if (parts[0] === "nodes") {
    if (parts[1] === from) parts[1] = to;
  } else {
    if (parts[1] === from) parts[1] = to;
    if (parts[2] === from) parts[2] = to;
  }
  return compoundKey(...parts);
}

const renameKeys = (keys: ReadonlySet<string>, from: string, to: string): Set<string> => {
  const out = new Set<string>();
  for (const key of keys) out.add(renameInKey(key, from, to));
  return out;
};

/**
 * Fold one edit's delta into the running overlay. Renames rewrite the keys
 * already held, so a cell edited and then renamed still finds its row; a
 * tombstone for a row this session added simply cancels it, since the file
 * never heard of that row; and a tombstone takes the row's dirty cells with
 * it.
 */
export function extendOverlay(current: EditsOverlay, delta: EditsOverlay): EditsOverlay {
  let dirtyCells = new Set(current.dirtyCells);
  let tombstones = new Set(current.tombstones);
  let addedRows = new Set(current.addedRows);

  for (const { from, to } of delta.idRenames) {
    dirtyCells = renameKeys(dirtyCells, from, to);
    tombstones = renameKeys(tombstones, from, to);
    addedRows = renameKeys(addedRows, from, to);
  }

  for (const key of delta.dirtyCells) dirtyCells.add(key);
  for (const key of delta.addedRows) addedRows.add(key);
  for (const key of delta.tombstones) {
    const prefix = compoundKey(key, "");
    for (const dirty of dirtyCells) {
      if (dirty.startsWith(prefix)) dirtyCells.delete(dirty);
    }
    if (addedRows.has(key)) {
      addedRows.delete(key);
      continue;
    }
    tombstones.add(key);
  }

  return {
    dirtyCells,
    tombstones,
    addedRows,
    idRenames: [...current.idRenames, ...delta.idRenames],
    columnOps: [...current.columnOps, ...delta.columnOps],
  };
}

/* ---- Merge: lay the overlay over a fresh document ---- */

export interface MergeReport {
  /** Incoming rows that matched a row already here. */
  updated: number;
  /** Incoming rows this document had never seen. */
  added: number;
  /** Edited cells laid back on top of incoming rows. */
  editsKept: number;
  /** Incoming rows dropped because their row was deleted here. */
  deletionsHeld: number;
  /** Rows kept although the new file no longer carries them. */
  keptExtras: number;
}

/** The dirty columns of one row, from the flat cell keys. */
function dirtyColumnsOf(overlay: EditsOverlay, rowKey: string): string[] {
  const prefix = compoundKey(rowKey, "");
  const out: string[] = [];
  for (const key of overlay.dirtyCells) {
    if (key.startsWith(prefix)) {
      const rest = key.slice(prefix.length);
      // The column is the last part, and a column name cannot contain the
      // separator, so anything with more parts belongs to a longer row key.
      if (splitKey(rest).length === 1) out.push(rest);
    }
  }
  return out;
}

/** A row cut down to the given columns, so stray cells do not ride along. */
function restrict(row: Row, columns: readonly string[]): Row {
  const out: Row = {};
  for (const name of columns) out[name] = Object.hasOwn(row, name) ? (row[name] ?? null) : null;
  return out;
}

export function mergeWithOverlay(
  current: GraphDoc,
  overlay: EditsOverlay,
  incoming: GraphDoc,
): { doc: GraphDoc; report: MergeReport } {
  const report: MergeReport = {
    updated: 0,
    added: 0,
    editsKept: 0,
    deletionsHeld: 0,
    keptExtras: 0,
  };

  // Renames replay first, so a row the user renamed or merged arrives under
  // the name it has here rather than resurrecting the old id.
  let staged = incoming;
  for (const { from, to } of overlay.idRenames) staged = renameNode(staged, from, to);

  // Then the column journal, through the same transforms the edits used.
  for (const op of overlay.columnOps) {
    switch (op.op) {
      case "add":
        staged = addColumn(staged, op.table, op.name, op.type);
        break;
      case "rename":
        staged = renameColumn(staged, op.table, op.from, op.to);
        break;
      case "delete":
        staged = deleteColumn(staged, op.table, op.name);
        break;
      case "retype":
        staged = retypeColumn(staged, op.table, op.name, op.type);
        break;
    }
  }

  const nodeColumns = staged.nodes.columns.map((c) => c.name);
  const edgeColumns = staged.edges.columns.map((c) => c.name);

  // Nodes: incoming rows lead, deletions hold, edited cells win, and rows
  // the user added or edited survive the file forgetting them.
  const currentNodeById = new Map<string, Row>();
  for (const row of current.nodes.rows) {
    const id = cellToId(row[current.nodeIdColumn]);
    if (id !== null && !currentNodeById.has(id)) currentNodeById.set(id, row);
  }

  const nodeRows: Row[] = [];
  const seenNodeIds = new Set<string>();
  for (const row of staged.nodes.rows) {
    const id = cellToId(row[staged.nodeIdColumn]);
    if (id === null) {
      nodeRows.push(row);
      continue;
    }
    if (overlay.tombstones.has(nodeRowKey(id))) {
      report.deletionsHeld++;
      continue;
    }
    seenNodeIds.add(id);
    const held = currentNodeById.get(id);
    if (held === undefined) {
      report.added++;
      nodeRows.push(row);
      continue;
    }
    report.updated++;
    const merged = { ...row };
    for (const column of dirtyColumnsOf(overlay, nodeRowKey(id))) {
      if (nodeColumns.includes(column)) {
        merged[column] = held[column] ?? null;
        report.editsKept++;
      }
    }
    nodeRows.push(merged);
  }
  for (const [id, row] of currentNodeById) {
    if (seenNodeIds.has(id)) continue;
    const key = nodeRowKey(id);
    const edited = overlay.addedRows.has(key) || dirtyColumnsOf(overlay, key).length > 0;
    if (!edited) continue;
    report.keptExtras++;
    nodeRows.push(restrict(row, nodeColumns));
  }

  // Edges: the same policy over pair-and-occurrence keys, plus one rule of
  // their own: an edge naming a deleted node stays deleted.
  const nodeTombstoned = (id: string | null) =>
    id !== null && overlay.tombstones.has(nodeRowKey(id));

  const currentEdgeByKey = new Map<string, Row>();
  edgeRowKeys(current, current.edges.rows).forEach((key, i) => {
    if (key !== null && !currentEdgeByKey.has(key)) {
      currentEdgeByKey.set(key, current.edges.rows[i]);
    }
  });

  const edgeRows: Row[] = [];
  const seenEdgeKeys = new Set<string>();
  const stagedKeys = edgeRowKeys(staged, staged.edges.rows);
  staged.edges.rows.forEach((row, i) => {
    const key = stagedKeys[i];
    if (key === null) {
      edgeRows.push(row);
      return;
    }
    if (overlay.tombstones.has(key)) {
      report.deletionsHeld++;
      return;
    }
    if (
      nodeTombstoned(cellToId(row[staged.mapping.source])) ||
      nodeTombstoned(cellToId(row[staged.mapping.target]))
    ) {
      report.deletionsHeld++;
      return;
    }
    seenEdgeKeys.add(key);
    const held = currentEdgeByKey.get(key);
    if (held === undefined) {
      report.added++;
      edgeRows.push(row);
      return;
    }
    report.updated++;
    const merged = { ...row };
    for (const column of dirtyColumnsOf(overlay, key)) {
      if (edgeColumns.includes(column)) {
        merged[column] = held[column] ?? null;
        report.editsKept++;
      }
    }
    edgeRows.push(merged);
  });
  for (const [key, row] of currentEdgeByKey) {
    if (seenEdgeKeys.has(key)) continue;
    const edited = overlay.addedRows.has(key) || dirtyColumnsOf(overlay, key).length > 0;
    if (!edited) continue;
    report.keptExtras++;
    edgeRows.push(restrict(row, edgeColumns));
  }

  const doc: GraphDoc = reconcileNodes({
    ...staged,
    nodes: { ...staged.nodes, rows: nodeRows },
    edges: { ...staged.edges, rows: edgeRows },
    nodesDeclared: staged.nodesDeclared || current.nodesDeclared,
  });

  return { doc, report };
}

/* ---- Persistence ---- */

export interface OverlayJson {
  dirtyCells: string[];
  tombstones: string[];
  addedRows: string[];
  idRenames: { from: string; to: string }[];
  columnOps: ColumnOp[];
}

export function overlayToJson(overlay: EditsOverlay): OverlayJson {
  return {
    dirtyCells: [...overlay.dirtyCells],
    tombstones: [...overlay.tombstones],
    addedRows: [...overlay.addedRows],
    idRenames: [...overlay.idRenames],
    columnOps: [...overlay.columnOps],
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const stringSet = (v: unknown): Set<string> =>
  new Set(Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

const isTarget = (v: unknown): v is EditTarget => v === "nodes" || v === "edges";
const isType = (v: unknown): v is ColumnType => v === "text" || v === "number" || v === "bool";

function validColumnOp(v: unknown): ColumnOp | null {
  if (!isRecord(v) || !isTarget(v.table)) return null;
  switch (v.op) {
    case "add":
    case "retype":
      return typeof v.name === "string" && isType(v.type)
        ? { op: v.op, table: v.table, name: v.name, type: v.type }
        : null;
    case "rename":
      return typeof v.from === "string" && typeof v.to === "string"
        ? { op: "rename", table: v.table, from: v.from, to: v.to }
        : null;
    case "delete":
      return typeof v.name === "string" ? { op: "delete", table: v.table, name: v.name } : null;
    default:
      return null;
  }
}

/**
 * An overlay as it arrives inside a workspace, which is to say inside a link
 * anyone could have written: shapes checked, unknown op kinds dropped, and
 * anything that is not a string simply not an edit.
 */
export function overlayFromJson(value: unknown): EditsOverlay {
  if (!isRecord(value)) return EMPTY_OVERLAY;
  const idRenames = Array.isArray(value.idRenames)
    ? value.idRenames.filter(
        (r): r is { from: string; to: string } =>
          isRecord(r) && typeof r.from === "string" && typeof r.to === "string",
      )
    : [];
  const columnOps = Array.isArray(value.columnOps)
    ? value.columnOps.map(validColumnOp).filter((op): op is ColumnOp => op !== null)
    : [];
  return {
    dirtyCells: stringSet(value.dirtyCells),
    tombstones: stringSet(value.tombstones),
    addedRows: stringSet(value.addedRows),
    idRenames,
    columnOps,
  };
}
