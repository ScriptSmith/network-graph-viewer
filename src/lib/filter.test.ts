import { expect, test } from "vitest";
import type { GraphDoc, Row, Table } from "../types";
import { buildDoc } from "./doc";
import {
  applyChain,
  chainInputBefore,
  describeStep,
  isFilterStep,
  retargetChain,
  type FilterSpec,
  type FilterStep,
} from "./filter";

let counter = 0;
const step = (spec: FilterSpec & { enabled?: boolean; invert?: boolean }): FilterStep => ({
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

test("an inverted degree step keeps exactly the nodes the plain one drops", () => {
  const doc = branchy();
  const plain = step({ kind: "degree", mode: "all", min: 2, max: null });
  const kept = idsOf(doc, [plain]);
  const dropped = idsOf(doc, [{ ...plain, invert: true }]);
  expect(kept).toEqual(["B", "C", "D"]);
  expect(dropped).toEqual(["A", "E", "X", "Y"]);
  expect([...kept, ...dropped].sort()).toEqual(idsOf(doc, []));
});

test("an inverted ego step is everything outside the neighbourhood", () => {
  const doc = branchy();
  const ego = step({ kind: "ego", centers: ["B"], depth: 1, direction: "any" });
  expect(idsOf(doc, [{ ...ego, invert: true }])).toEqual(["D", "E", "Y"]);
});

test("an inverted component step keeps the small islands", () => {
  const doc = docOf([
    ["A", "B"],
    ["B", "C"],
    ["X", "Y"],
  ]);
  expect(idsOf(doc, [step({ kind: "component", count: 1, invert: true })])).toEqual(["X", "Y"]);
});

test("an inverted edge step keeps the rows the plain one would drop", () => {
  const doc = docOf([
    ["A", "B"],
    ["B", "A"],
    ["B", "C"],
  ]);
  const { graph } = run(doc, [step({ kind: "mutual", invert: true })], false);
  expect(graph.links).toHaveLength(1);
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(["B", "C"]);
});

test("inversion complements within what enters the step, not the whole document", () => {
  const doc = branchy();
  const ego = step({ kind: "ego", centers: ["B"], depth: 1, direction: "any" });
  const degree = step({ kind: "degree", mode: "all", min: 2, max: null, invert: true });
  // Inside B's neighbourhood only B has degree >= 2, so "not" keeps the rest
  // of the neighbourhood rather than the rest of the document.
  expect(idsOf(doc, [ego, degree])).toEqual(["A", "C", "X"]);
});

test("inverting twice is a round trip", () => {
  const doc = branchy();
  const plain = step({ kind: "degree", mode: "all", min: 2, max: null });
  const once = idsOf(doc, [{ ...plain, invert: true }]);
  const twiceDoc = idsOf(doc, [
    { ...plain, invert: true },
    { ...step({ kind: "degree", mode: "all", min: 2, max: null }), invert: true },
  ]);
  // The second inversion complements within the first's survivors: everyone
  // there has degree below 2 inside that subgraph, so nothing survives twice
  // inverting the same condition only if some of them regained degree.
  expect(once).toEqual(["A", "E", "X", "Y"]);
  expect(twiceDoc.every((id) => once.includes(id))).toBe(true);
});

test("isolated-node rules still apply after an inversion", () => {
  const doc = branchy();
  const plain = step({ kind: "degree", mode: "all", min: 2, max: null });
  // A, E, X and Y survive the inversion but share no edges; hidden isolated
  // nodes take them all out.
  expect(idsOf(doc, [{ ...plain, invert: true }], false)).toEqual([]);
});

test("invert is tolerated by the validator and read back honestly", () => {
  const plain = step({ kind: "kcore", k: 2 });
  expect(isFilterStep({ ...plain, invert: true })).toBe(true);
  expect(isFilterStep({ ...plain, invert: "yes" })).toBe(false);
  expect(describeStep({ ...plain, invert: true })).toBe("not: 2-core");
  expect(describeStep(plain)).toBe("2-core");
});

test("chainInputBefore hands a step what the chain above it produced", () => {
  const doc = branchy();
  const degree = step({ kind: "degree", mode: "all", min: 2, max: null });
  const ego = step({ kind: "ego", centers: ["B"], depth: 1, direction: "any" });
  const chain = [degree, ego];
  const before = chainInputBefore(doc, chain, ego.id, { showIsolated: true });
  expect(before.graph.nodes.map((n) => n.id).sort()).toEqual(["B", "C", "D"]);
  // The first step sees the untouched document.
  const first = chainInputBefore(doc, chain, degree.id, { showIsolated: true });
  expect(first.graph.nodes).toHaveLength(7);
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

test("a time window keeps rows inside inclusive bounds, dates included", () => {
  const rows: Row[] = [
    { Source: "A", Target: "B", When: "2024-01-01" },
    { Source: "B", Target: "C", When: "2024-02-01" },
    { Source: "C", Target: "D", When: "2024-03-01" },
    { Source: "D", Target: "E", When: "not a date" },
  ];
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
      { name: "When", type: "text" },
    ],
    rows,
  };
  const doc = buildDoc("dated", edges, {
    mapping: { source: "Source", target: "Target", attrs: ["When"] },
  });
  const from = Date.parse("2024-02-01");
  const { graph } = run(
    doc,
    [step({ kind: "timewindow", table: "edges", column: "When", min: from, max: from })],
    false,
  );
  // Inclusive at both ends: exactly the February row survives.
  expect(graph.links).toHaveLength(1);
  expect(graph.nodes.map((n) => n.id).sort()).toEqual(["B", "C"]);
});

test("a node-table time window narrows nodes, and order in the chain matters", () => {
  const nodes: Table = {
    name: "Nodes",
    columns: [
      { name: "Id", type: "text" },
      { name: "Joined", type: "number" },
    ],
    rows: [
      { Id: "A", Joined: 2001 },
      { Id: "B", Joined: 2005 },
      { Id: "C", Joined: 2010 },
    ],
  };
  const doc = docOf(
    [
      ["A", "B"],
      ["B", "C"],
    ],
    nodes,
  );
  const window = step({
    kind: "timewindow",
    table: "nodes",
    column: "Joined",
    min: 2000,
    max: 2006,
  });
  expect(idsOf(doc, [window])).toEqual(["A", "B"]);

  // After a degree step the window sees the narrowed graph, not the document.
  const degree = step({ kind: "degree", mode: "all", min: 2, max: null });
  expect(idsOf(doc, [degree, window], false)).toEqual([]);
});

test("an unbounded window lets everything through, and null bounds are half-open", () => {
  const doc = branchy();
  const open = step({ kind: "timewindow", table: "edges", column: "Source", min: null, max: null });
  // "Source" holds no numbers, so an unbounded window still requires a
  // readable time; every row drops. That is the honest reading: the window
  // asks when, and these rows never say.
  expect(run(doc, [open], false).graph.links).toHaveLength(0);
});

test("timewindow validates, describes, inverts and follows renames", () => {
  const window = step({
    kind: "timewindow",
    table: "edges",
    column: "When",
    min: 1,
    max: null,
  });
  expect(isFilterStep(window)).toBe(true);
  expect(isFilterStep({ ...window, min: "early" })).toBe(false);
  expect(describeStep(window)).toBe("When window");

  const renamed = retargetChain([window], "edges", "When", "At");
  expect(renamed[0].kind === "timewindow" && renamed[0].column).toBe("At");
  expect(retargetChain([window], "edges", "When", null)).toHaveLength(0);
  expect(retargetChain([window], "nodes", "When", null)).toHaveLength(1);

  // Inversion complements: rows outside the window survive instead.
  const rows: Row[] = [
    { Source: "A", Target: "B", T: 1 },
    { Source: "B", Target: "C", T: 9 },
  ];
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "Source", type: "text" },
      { name: "Target", type: "text" },
      { name: "T", type: "number" },
    ],
    rows,
  };
  const timed = buildDoc("t", edges, {
    mapping: { source: "Source", target: "Target", attrs: [] },
  });
  const inside = step({ kind: "timewindow", table: "edges", column: "T", min: 0, max: 5 });
  expect(run(timed, [inside], false).graph.links).toHaveLength(1);
  expect(
    run(timed, [{ ...inside, invert: true }], false)
      .graph.nodes.map((n) => n.id)
      .sort(),
  ).toEqual(["B", "C"]);
});
