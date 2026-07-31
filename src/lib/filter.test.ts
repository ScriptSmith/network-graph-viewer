import { expect, test } from "vitest";
import type { GraphDoc, Row, Table } from "../types";
import { buildDoc } from "./doc";
import {
  applyChain,
  isFilterStep,
  retargetChain,
  type FilterSpec,
  type FilterStep,
} from "./filter";

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

test("an ego step with an edge constraint walks only the matching edges", () => {
  // Two routes out of A: a "rail" line through B to C, and a "bus" hop to Y.
  const rows: Row[] = [
    { Source: "A", Target: "B", Line: "rail" },
    { Source: "B", Target: "C", Line: "rail" },
    { Source: "A", Target: "Y", Line: "bus" },
    { Source: "Y", Target: "Z", Line: "bus" },
  ];
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
      { name: "Line", type: "text" },
    ],
    rows,
  };
  const doc = buildDoc("lines", edges, {
    mapping: { source: "Source", target: "Target", attrs: ["Line"] },
  });

  const along = (values: string[]) =>
    idsOf(doc, [
      step({
        kind: "ego",
        centers: ["A"],
        depth: 2,
        direction: "any",
        where: { column: "Line", values },
      }),
    ]);

  expect(along(["rail"])).toEqual(["A", "B", "C"]);
  expect(along(["bus"])).toEqual(["A", "Y", "Z"]);
  expect(along(["rail", "bus"])).toEqual(["A", "B", "C", "Y", "Z"]);
  // The unconstrained step still reaches everything.
  expect(idsOf(doc, [step({ kind: "ego", centers: ["A"], depth: 2, direction: "any" })])).toEqual([
    "A",
    "B",
    "C",
    "Y",
    "Z",
  ]);
});

test("the ego constraint is validated and follows column renames", () => {
  const good: FilterStep = step({
    kind: "ego",
    centers: ["A"],
    depth: 1,
    direction: "any",
    where: { column: "Line", values: ["rail"] },
  });
  expect(isFilterStep(good)).toBe(true);
  expect(isFilterStep({ ...good, where: { column: 7, values: [] } })).toBe(false);
  expect(isFilterStep({ ...good, where: { column: "Line", values: [null] } })).toBe(false);

  const renamed = retargetChain([good], "edges", "Line", "Route");
  expect(renamed[0].kind === "ego" && renamed[0].where?.column).toBe("Route");

  // Deleting the column drops the constraint, not the step.
  const dropped = retargetChain([good], "edges", "Line", null);
  expect(dropped).toHaveLength(1);
  expect(dropped[0].kind === "ego" && dropped[0].where).toBeUndefined();
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

/**
 * A fresh column step is seeded with every distinct value, so that adding one
 * never blanks the canvas. That makes the selection as long as the column, and
 * testing membership by walking it once per row is quadratic: at this size the
 * old list scan took about ten seconds, so a regression fails by timeout rather
 * than by a wall-clock assertion that would be flaky on a loaded machine.
 */
test("a values condition over a high-cardinality column does not walk its list per row", () => {
  const N = 100_000;
  const rows: Row[] = Array.from({ length: N }, (_, i) => ({
    From: `n${i}`,
    To: `n${(i + 1) % N}`,
  }));
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "From", type: "text" },
      { name: "To", type: "text" },
    ],
    rows,
  };
  const doc = buildDoc("wide", edges);
  const everyValue = step({
    kind: "column",
    table: "edges",
    column: "From",
    op: { kind: "values", selected: rows.map((r) => String(r.From)) },
  });

  const { graph } = applyChain(doc, [everyValue], { showIsolated: true });
  expect(graph.links).toHaveLength(N);
}, 5000);
