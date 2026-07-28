import { expect, test } from "vitest";
import type { GraphDoc, Row, Table } from "../types";
import { buildDoc } from "./doc";
import { applyChain, type FilterSpec, type FilterStep } from "./filter";

let counter = 0;
const step = (spec: FilterSpec & { enabled?: boolean }): FilterStep => ({
  id: `s${++counter}`,
  enabled: true,
  ...spec,
});

function docOf(edges: [string, string][], nodes?: Table): GraphDoc {
  const rows: Row[] = edges.map(([Source, Target]) => ({ Source, Target }));
  const table: Table = {
    name: "Edges",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
    ],
    rows,
  };
  return buildDoc("test", table, {
    nodes,
    mapping: { source: "Source", target: "Target", attrs: [] },
  });
}

const run = (doc: GraphDoc, chain: FilterStep[], showIsolated = true) =>
  applyChain(doc, chain, { showIsolated });

const idsOf = (doc: GraphDoc, chain: FilterStep[], showIsolated = true) =>
  run(doc, chain, showIsolated)
    .graph.nodes.map((n) => n.id)
    .sort();

/** A path A-B-C-D-E with a pendant hanging off B and off C. */
const branchy = (): GraphDoc =>
  docOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "D"],
    ["D", "E"],
    ["B", "X"],
    ["C", "Y"],
  ]);

test("reordering two steps changes the answer, which is the point of a chain", () => {
  const doc = branchy();
  const ego = step({ kind: "ego", centers: ["B"], depth: 1, direction: "any" });
  const degree = step({ kind: "degree", mode: "all", min: 2, max: null });

  // Ego first: degree is then measured inside B's immediate neighbourhood,
  // where only B itself has more than one connection.
  expect(idsOf(doc, [ego, degree])).toEqual(["B"]);

  // Degree first: the hubs survive, and B's neighbourhood within that smaller
  // graph still contains C.
  expect(idsOf(doc, [degree, ego])).toEqual(["B", "C"]);
});

test("a disabled step is skipped but still reports the counts around it", () => {
  const doc = branchy();
  const degree = step({ kind: "degree", mode: "all", min: 2, max: null, enabled: false });
  const { graph, steps } = run(doc, [degree]);
  expect(graph.nodes.length).toBe(7);
  expect(steps).toHaveLength(1);
  expect(steps[0].nodes).toBe(7);
});

test("each step reports what is left after it", () => {
  const doc = branchy();
  const chain = [
    step({ kind: "degree", mode: "all", min: 2, max: null }),
    step({ kind: "ego", centers: ["B"], depth: 1, direction: "any" }),
  ];
  const { steps } = run(doc, chain);
  expect(steps.map((s) => s.nodes)).toEqual([3, 2]);
});

test("ego networks can follow the arrows or ignore them", () => {
  const doc = docOf([
    ["A", "B"],
    ["C", "B"],
    ["B", "D"],
  ]);
  const at = (direction: "any" | "out" | "in") =>
    idsOf(doc, [step({ kind: "ego", centers: ["B"], depth: 1, direction })]);
  expect(at("any")).toEqual(["A", "B", "C", "D"]);
  expect(at("out")).toEqual(["B", "D"]);
  expect(at("in")).toEqual(["A", "B", "C"]);
});

test("k-core keeps the dense middle and drops the pendant", () => {
  const doc = docOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "A"],
    ["C", "D"],
  ]);
  expect(idsOf(doc, [step({ kind: "kcore", k: 2 })])).toEqual(["A", "B", "C"]);
});

test("the component step keeps the largest islands", () => {
  const doc = docOf([
    ["A", "B"],
    ["B", "C"],
    ["X", "Y"],
  ]);
  expect(idsOf(doc, [step({ kind: "component", count: 1 })])).toEqual(["A", "B", "C"]);
  expect(idsOf(doc, [step({ kind: "component", count: 2 })])).toEqual(["A", "B", "C", "X", "Y"]);
});

test("the reciprocated step keeps only edges whose reverse exists", () => {
  const doc = docOf([
    ["A", "B"],
    ["B", "A"],
    ["B", "C"],
  ]);
  const { graph } = run(doc, [step({ kind: "mutual" })], false);
  expect(graph.links).toHaveLength(2);
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
});

test("filtering a node-table column narrows the graph without touching edge rows", () => {
  const nodes: Table = {
    name: "Nodes",
    columns: [
      { name: "Id", type: "text" },
      { name: "Team", type: "text" },
    ],
    rows: [
      { Id: "A", Team: "red" },
      { Id: "B", Team: "red" },
      { Id: "C", Team: "blue" },
    ],
  };
  const doc = docOf(
    [
      ["A", "B"],
      ["B", "C"],
    ],
    nodes,
  );
  const chain = [
    step({
      kind: "column",
      table: "nodes",
      column: "Team",
      op: { kind: "values", selected: ["red"] },
    }),
  ];
  expect(idsOf(doc, chain)).toEqual(["A", "B"]);
  // The B-C edge needed a node that is gone, so it goes too.
  expect(run(doc, chain).graph.links).toHaveLength(1);
});

test("the disparity backbone keeps a dominant edge and drops the filler", () => {
  const rows: Row[] = [
    { Source: "hub", Target: "heavy", W: 100 },
    { Source: "hub", Target: "light1", W: 1 },
    { Source: "hub", Target: "light2", W: 1 },
    { Source: "hub", Target: "light3", W: 1 },
    { Source: "heavy", Target: "other", W: 1 },
    { Source: "light1", Target: "other", W: 1 },
    { Source: "light2", Target: "other", W: 1 },
    { Source: "light3", Target: "other", W: 1 },
  ];
  const table: Table = {
    name: "Edges",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
      { name: "W", type: "number" },
    ],
    rows,
  };
  const doc = buildDoc("test", table, {
    mapping: { source: "Source", target: "Target", attrs: ["W"] },
  });
  const { graph } = run(doc, [step({ kind: "backbone", alpha: 0.05, weightColumn: "W" })], false);
  const kept = graph.links.map((l) => `${l.source as string}->${l.target as string}`);
  expect(kept).toContain("hub->heavy");
  expect(kept).not.toContain("hub->light1");
});

test("an empty chain leaves the graph alone", () => {
  const doc = branchy();
  expect(idsOf(doc, [])).toEqual(["A", "B", "C", "D", "E", "X", "Y"]);
});
