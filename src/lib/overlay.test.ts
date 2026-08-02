import { expect, test } from "vitest";
import type { GraphDoc, Row, Table } from "../types";
import { buildDoc } from "./doc";
import {
  addColumn,
  deleteColumn,
  fillColumn,
  mergeNodes,
  renameColumn,
  retypeColumn,
} from "./bulk";
import { addRow, deleteRows, renameNode, setCell } from "./edit";
import { compoundKey } from "./cells";
import {
  diffDocs,
  EMPTY_OVERLAY,
  extendOverlay,
  mergeWithOverlay,
  overlayFromJson,
  overlayIsEmpty,
  overlayToJson,
  type EditsOverlay,
} from "./overlay";

function docOf(
  edges: [string, string, Row?][],
  nodeRows?: Row[],
  nodeColumns?: Table["columns"],
): GraphDoc {
  const rows: Row[] = edges.map(([Source, Target, extra]) => ({
    Source,
    Target,
    Weight: null,
    ...extra,
  }));
  const table: Table = {
    name: "Edges",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
      { name: "Weight", type: "number" },
    ],
    rows,
  };
  const nodes: Table | undefined = nodeRows
    ? {
        name: "Nodes",
        columns: nodeColumns ?? [
          { name: "Id", type: "text" },
          { name: "Team", type: "text" },
        ],
        rows: nodeRows,
      }
    : undefined;
  return buildDoc("test", table, {
    nodes,
    mapping: { source: "Source", target: "Target", attrs: ["Weight"] },
  });
}

const baseDoc = () =>
  docOf(
    [
      ["A", "B", { Weight: 1 }],
      ["B", "C", { Weight: 2 }],
    ],
    [
      { Id: "A", Team: "red" },
      { Id: "B", Team: "red" },
      { Id: "C", Team: "blue" },
    ],
  );

/** Diff and fold in one step, the way the history hook does. */
const record = (overlay: EditsOverlay, before: GraphDoc, after: GraphDoc) =>
  extendOverlay(overlay, diffDocs(before, after));

test("a cell edit records exactly one dirty cell", () => {
  const before = baseDoc();
  const after = setCell(before, "nodes", 0, "Team", "green");
  const delta = diffDocs(before, after);
  expect([...delta.dirtyCells]).toEqual([compoundKey("nodes", "A", "Team")]);
  expect(delta.tombstones.size).toBe(0);
  expect(delta.addedRows.size).toBe(0);
  expect(delta.idRenames).toEqual([]);
});

test("an edge cell edit records under the pair-and-occurrence key", () => {
  const before = baseDoc();
  const after = setCell(before, "edges", 1, "Weight", 9);
  const delta = diffDocs(before, after);
  expect([...delta.dirtyCells]).toEqual([compoundKey("edges", "B", "C", 0, "Weight")]);
});

test("adding and deleting rows record as additions and tombstones", () => {
  const before = baseDoc();
  const added = addRow(before, "nodes");
  expect([...diffDocs(before, added).addedRows]).toEqual([compoundKey("nodes", "New node")]);

  const deleted = deleteRows(before, "edges", [0]);
  expect(diffDocs(before, deleted).tombstones.has(compoundKey("edges", "A", "B", 0))).toBe(true);

  // Deleting a node also tombstones it; its edges' disappearance rides along.
  const nodeGone = deleteRows(before, "nodes", [2]);
  const delta = diffDocs(before, nodeGone);
  expect(delta.tombstones.has(compoundKey("nodes", "C"))).toBe(true);
  expect(delta.idRenames).toEqual([]);
});

test("a rename is a rename, not a delete plus a stranger", () => {
  const before = baseDoc();
  const after = renameNode(before, "B", "Bee");
  const delta = diffDocs(before, after);
  expect(delta.idRenames).toEqual([{ from: "B", to: "Bee" }]);
  expect(delta.tombstones.size).toBe(0);
  expect(delta.addedRows.size).toBe(0);
  // The rewritten endpoints are the rename, not edits to the edges.
  expect(delta.dirtyCells.size).toBe(0);
});

test("merging ids reads the rename off the rewritten endpoints", () => {
  const before = baseDoc();
  const after = mergeNodes(before, ["C"], "B");
  const delta = diffDocs(before, after);
  expect(delta.idRenames).toEqual([{ from: "C", to: "B" }]);
  expect(delta.tombstones.size).toBe(0);
});

test("column work records as ops, and computed columns stay invisible", () => {
  const before = baseDoc();
  const withCol = addColumn(before, "nodes", "Notes");
  expect(diffDocs(before, withCol).columnOps).toEqual([
    { op: "add", table: "nodes", name: "Notes", type: "text" },
  ]);

  const renamed = renameColumn(before, "edges", "Weight", "Load");
  expect(diffDocs(before, renamed).columnOps).toEqual([
    { op: "rename", table: "edges", from: "Weight", to: "Load" },
  ]);
  // A rename moves the name, not the values, so no cells read as dirty.
  expect(diffDocs(before, renamed).dirtyCells.size).toBe(0);

  const retyped = retypeColumn(before, "edges", "Weight", "text");
  expect(
    diffDocs(before, retyped).columnOps.some(
      (op) => op.op === "retype" && op.name === "Weight" && op.type === "text",
    ),
  ).toBe(true);

  const dropped = deleteColumn(before, "nodes", "Team");
  expect(diffDocs(before, dropped).columnOps).toEqual([
    { op: "delete", table: "nodes", name: "Team" },
  ]);

  // A computed column appearing is the compute step's business, not an edit.
  const computed: GraphDoc = {
    ...before,
    nodes: {
      ...before.nodes,
      columns: [...before.nodes.columns, { name: "PageRank", type: "number", computed: true }],
      rows: before.nodes.rows.map((r, i) => ({ ...r, PageRank: i })),
    },
  };
  const delta = diffDocs(before, computed);
  expect(delta.columnOps).toEqual([]);
  expect(delta.dirtyCells.size).toBe(0);
});

test("a row added and then deleted never existed as far as the file knows", () => {
  const before = baseDoc();
  const added = addRow(before, "nodes");
  let overlay = record(EMPTY_OVERLAY, before, added);
  const deleted = deleteRows(added, "nodes", [3]);
  overlay = record(overlay, added, deleted);
  expect(overlay.addedRows.size).toBe(0);
  expect(overlay.tombstones.size).toBe(0);
});

test("a rename after an edit carries the edit's key with it", () => {
  const before = baseDoc();
  const edited = setCell(before, "nodes", 1, "Team", "gold");
  let overlay = record(EMPTY_OVERLAY, before, edited);
  const renamed = renameNode(edited, "B", "Bee");
  overlay = record(overlay, edited, renamed);
  expect(overlay.dirtyCells.has(compoundKey("nodes", "Bee", "Team"))).toBe(true);
  expect(overlay.dirtyCells.has(compoundKey("nodes", "B", "Team"))).toBe(false);
});

/* ---- The merge policy, rule by rule ---- */

test("edited cells win, unedited cells track the new file", () => {
  const current = baseDoc();
  const edited = setCell(current, "nodes", 0, "Team", "green");
  const overlay = record(EMPTY_OVERLAY, current, edited);

  // The new file changed both A's and B's teams.
  const incoming = docOf(
    [
      ["A", "B", { Weight: 5 }],
      ["B", "C", { Weight: 2 }],
    ],
    [
      { Id: "A", Team: "purple" },
      { Id: "B", Team: "purple" },
      { Id: "C", Team: "blue" },
    ],
  );
  const { doc, report } = mergeWithOverlay(edited, overlay, incoming);
  const teamOf = (id: string) => doc.nodes.rows.find((r) => r.Id === id)?.Team;
  expect(teamOf("A")).toBe("green");
  expect(teamOf("B")).toBe("purple");
  // Unedited edge weights track the file too.
  expect(doc.edges.rows[0].Weight).toBe(5);
  expect(report.editsKept).toBe(1);
  expect(report.updated).toBeGreaterThan(0);
});

test("deletions hold, and a deleted node keeps its incoming edges out", () => {
  const current = baseDoc();
  const deleted = deleteRows(current, "nodes", [2]);
  const overlay = record(EMPTY_OVERLAY, current, deleted);

  const incoming = baseDoc();
  const { doc, report } = mergeWithOverlay(deleted, overlay, incoming);
  expect(doc.nodes.rows.some((r) => r.Id === "C")).toBe(false);
  expect(doc.edges.rows.some((r) => r.Target === "C")).toBe(false);
  expect(report.deletionsHeld).toBeGreaterThan(0);
});

test("added rows and edited-but-vanished rows outlive the file", () => {
  const current = baseDoc();
  let working = addRow(current, "nodes");
  let overlay = record(EMPTY_OVERLAY, current, working);
  const edited = setCell(working, "nodes", 2, "Team", "gold");
  overlay = record(overlay, working, edited);
  working = edited;

  // The new file has forgotten C entirely and never met the added row.
  const incoming = docOf(
    [["A", "B", { Weight: 1 }]],
    [
      { Id: "A", Team: "red" },
      { Id: "B", Team: "red" },
    ],
  );
  const { doc, report } = mergeWithOverlay(working, overlay, incoming);
  expect(doc.nodes.rows.some((r) => r.Id === "New node")).toBe(true);
  // C was edited, so it survives the file dropping it; its team survives too.
  expect(doc.nodes.rows.find((r) => r.Id === "C")?.Team).toBe("gold");
  expect(report.keptExtras).toBe(2);
});

test("a rename replays onto incoming rows instead of resurrecting the old id", () => {
  const current = baseDoc();
  const renamed = renameNode(current, "B", "Bee");
  const overlay = record(EMPTY_OVERLAY, current, renamed);

  const incoming = baseDoc(); // still says B everywhere
  const { doc } = mergeWithOverlay(renamed, overlay, incoming);
  expect(doc.nodes.rows.some((r) => r.Id === "B")).toBe(false);
  expect(doc.nodes.rows.some((r) => r.Id === "Bee")).toBe(true);
  expect(doc.edges.rows.filter((r) => r.Source === "Bee" || r.Target === "Bee")).toHaveLength(2);
});

test("a merge of two ids keeps merging what the file sends", () => {
  const current = baseDoc();
  const merged = mergeNodes(current, ["C"], "B");
  const overlay = record(EMPTY_OVERLAY, current, merged);

  const incoming = docOf(
    [
      ["A", "B", { Weight: 1 }],
      ["B", "C", { Weight: 2 }],
      ["C", "A", { Weight: 3 }],
    ],
    [
      { Id: "A", Team: "red" },
      { Id: "B", Team: "red" },
      { Id: "C", Team: "blue" },
    ],
  );
  const { doc } = mergeWithOverlay(merged, overlay, incoming);
  expect(doc.nodes.rows.some((r) => r.Id === "C")).toBe(false);
  // C's fresh edge arrives, renamed onto B.
  expect(doc.edges.rows.some((r) => r.Source === "B" && r.Target === "A")).toBe(true);
});

test("user columns replay onto the new file, values and all", () => {
  const current = baseDoc();
  let working = addColumn(current, "nodes", "Notes");
  let overlay = record(EMPTY_OVERLAY, current, working);
  const filled = fillColumn(working, "nodes", "Notes", "checked", false, null);
  overlay = record(overlay, working, filled);
  working = filled;

  const incoming = baseDoc();
  const { doc } = mergeWithOverlay(working, overlay, incoming);
  expect(doc.nodes.columns.some((c) => c.name === "Notes")).toBe(true);
  expect(doc.nodes.rows.every((r) => r.Notes === "checked")).toBe(true);
});

test("edge edits ride occurrence keys, best effort when the counts drift", () => {
  const current = docOf([
    ["A", "B", { Weight: 1 }],
    ["A", "B", { Weight: 2 }],
  ]);
  const edited = setCell(current, "edges", 1, "Weight", 99);
  const overlay = record(EMPTY_OVERLAY, current, edited);

  // Same file again: the second A-B row keeps the edit.
  const same = mergeWithOverlay(edited, overlay, current).doc;
  expect(same.edges.rows.map((r) => r.Weight)).toEqual([1, 99]);

  // A file with only one A-B row: the edited second occurrence is absent,
  // but the edit marked it, so it is kept as an extra row. Documented trade.
  const thinner = docOf([["A", "B", { Weight: 7 }]]);
  const { doc } = mergeWithOverlay(edited, overlay, thinner);
  expect(doc.edges.rows).toHaveLength(2);
  expect(doc.edges.rows[0].Weight).toBe(7);
  expect(doc.edges.rows[1].Weight).toBe(99);
});

test("the overlay survives its trip through JSON, and junk does not", () => {
  const current = baseDoc();
  const edited = setCell(current, "nodes", 0, "Team", "green");
  const overlay = record(EMPTY_OVERLAY, current, edited);

  const back = overlayFromJson(JSON.parse(JSON.stringify(overlayToJson(overlay))));
  expect([...back.dirtyCells]).toEqual([...overlay.dirtyCells]);
  expect(overlayIsEmpty(back)).toBe(false);

  expect(overlayIsEmpty(overlayFromJson(null))).toBe(true);
  expect(overlayIsEmpty(overlayFromJson({ dirtyCells: "everything" }))).toBe(true);
  const junky = overlayFromJson({
    dirtyCells: ["ok", 7, null],
    tombstones: [],
    addedRows: [],
    idRenames: [{ from: "a", to: "b" }, { from: 1 }],
    columnOps: [
      { op: "add", table: "nodes", name: "x", type: "text" },
      { op: "explode", table: "nodes" },
      { op: "add", table: "elsewhere", name: "x", type: "text" },
    ],
  });
  expect(junky.dirtyCells.size).toBe(1);
  expect(junky.idRenames).toEqual([{ from: "a", to: "b" }]);
  expect(junky.columnOps).toEqual([{ op: "add", table: "nodes", name: "x", type: "text" }]);
});
