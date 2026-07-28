import { expect, test } from "vitest";
import type { GraphDoc, Table } from "../types";
import { buildDoc } from "./doc";
import { buildBaseGraph } from "./graph";
import { addNode, deleteNodes, deleteRows, renameNode, setCell } from "./edit";

function docOf(edges: [string, string][]): GraphDoc {
  const table: Table = {
    name: "Edges",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
      { name: "Weight", type: "number" },
    ],
    rows: edges.map(([Source, Target], i) => ({ Source, Target, Weight: i + 1 })),
  };
  return buildDoc("test", table, {
    mapping: { source: "Source", target: "Target", attrs: ["Weight"] },
  });
}

const ids = (doc: GraphDoc) => doc.nodes.rows.map((r) => r[doc.nodeIdColumn]).sort();

const base = (): GraphDoc =>
  docOf([
    ["A", "B"],
    ["B", "C"],
  ]);

test("renaming a node rewrites both endpoint columns", () => {
  const doc = renameNode(base(), "B", "Bee");
  expect(ids(doc)).toEqual(["A", "Bee", "C"]);
  expect(doc.edges.rows.map((r) => `${r.Source}->${r.Target}`)).toEqual(["A->Bee", "Bee->C"]);
  expect(buildBaseGraph(doc).links).toHaveLength(2);
});

test("editing the id cell is a rename, not an orphaning", () => {
  const doc = base();
  const index = doc.nodes.rows.findIndex((r) => r[doc.nodeIdColumn] === "B");
  const next = setCell(doc, "nodes", index, doc.nodeIdColumn, "Bee");
  expect(ids(next)).toEqual(["A", "Bee", "C"]);
  expect(buildBaseGraph(next).nodes).toHaveLength(3);
});

test("editing an endpoint cell introduces the new node", () => {
  const doc = setCell(base(), "edges", 0, "Target", "Zed");
  expect(ids(doc)).toEqual(["A", "B", "C", "Zed"]);
});

test("deleting a node takes its edges with it", () => {
  const doc = deleteNodes(base(), ["B"]);
  expect(ids(doc)).toEqual(["A", "C"]);
  expect(doc.edges.rows).toHaveLength(0);
});

test("adding a node leaves it out of the graph until an edge arrives", () => {
  const added = addNode(base(), "Solo");
  expect(ids(added)).toContain("Solo");
  expect(buildBaseGraph(added, { showIsolated: false }).nodes.map((n) => n.id)).not.toContain(
    "Solo",
  );
  expect(buildBaseGraph(added, { showIsolated: true }).nodes.map((n) => n.id)).toContain("Solo");
});

test("deleting a row from the node table removes that node and its edges", () => {
  const doc = base();
  const index = doc.nodes.rows.findIndex((r) => r[doc.nodeIdColumn] === "B");
  const next = deleteRows(doc, "nodes", [index]);
  expect(ids(next)).toEqual(["A", "C"]);
  expect(next.edges.rows).toHaveLength(0);
});

test("deleting a row from the edge table leaves the nodes alone", () => {
  const next = deleteRows(base(), "edges", [0]);
  expect(next.edges.rows).toHaveLength(1);
  expect(ids(next)).toEqual(["A", "B", "C"]);
});
