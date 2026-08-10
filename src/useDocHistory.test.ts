/**
 * The history's row budget: a cell edit weighs one row, a column op weighs
 * the table, and the oldest entries fall off once the total passes the
 * budget, but never below the minimum number of steps.
 */
import { expect, test } from "vitest";
import type { GraphDoc, Row } from "./types";
import { entryWeight, trimPast, MIN_DEPTH, ROW_BUDGET } from "./useDocHistory";

function docOf(edgeRows: Row[], nodeRows: Row[]): GraphDoc {
  return {
    name: "t",
    edges: {
      name: "Edges",
      columns: [
        { name: "a", type: "text" },
        { name: "b", type: "text" },
      ],
      rows: edgeRows,
    },
    nodes: { name: "Nodes", columns: [{ name: "Id", type: "text" }], rows: nodeRows },
    nodeIdColumn: "Id",
    mapping: { source: "a", target: "b", attrs: [] },
    nodesDeclared: false,
  };
}

test("a cell edit weighs one row; a column op weighs the whole table", () => {
  const edges = [
    { a: "x", b: "y" },
    { a: "y", b: "z" },
    { a: "z", b: "x" },
  ];
  const nodes = [{ Id: "x" }, { Id: "y" }, { Id: "z" }];
  const before = docOf(edges, nodes);

  // Copy-on-write cell edit: one row object replaced, the rest shared.
  const cellEdit = docOf([edges[0], { ...edges[1], b: "w" }, edges[2]], nodes);
  expect(entryWeight(before, cellEdit)).toBe(1);

  // A column op rebuilds every edge row; the node table is untouched.
  const columnOp = docOf(
    edges.map((r) => ({ ...r })),
    nodes,
  );
  expect(entryWeight(before, columnOp)).toBe(3);

  // Identical arrays cost nothing at all.
  expect(entryWeight(before, docOf(edges, nodes))).toBe(0);
});

test("the budget evicts the oldest entries but a minimum always survives", () => {
  // Each entry is heavier than the whole budget: only the minimum holds.
  const heavy = Array.from({ length: 20 }, (_, i) => ({ weight: ROW_BUDGET + 1, i }));
  const kept = trimPast(heavy);
  expect(kept).toHaveLength(MIN_DEPTH);
  // The newest survive, not the oldest.
  expect(kept[kept.length - 1].i).toBe(19);
  expect(kept[0].i).toBe(20 - MIN_DEPTH);

  // Light entries all fit, up to the depth cap.
  const light = Array.from({ length: 60 }, (_, i) => ({ weight: 1, i }));
  expect(trimPast(light)).toHaveLength(50);

  // A mixed history keeps everything under the budget plus the minimum.
  const mixed = [
    { weight: ROW_BUDGET, i: 0 },
    ...Array.from({ length: 10 }, (_, i) => ({ weight: 1, i: i + 1 })),
  ];
  const trimmed = trimPast(mixed);
  // The ten light entries fit; the one heavy oldest entry tips the total over
  // and goes, since more than the minimum remain without it.
  expect(trimmed).toHaveLength(10);
  expect(trimmed[0].i).toBe(1);

  // Under the minimum, nothing is ever dropped.
  const few = Array.from({ length: 3 }, (_, i) => ({ weight: ROW_BUDGET * 2, i }));
  expect(trimPast(few)).toHaveLength(3);
});
