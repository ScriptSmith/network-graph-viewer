import { describe, expect, test } from "vitest";
import { SAMPLE_DATASET } from "../samples";
import { guessStyle } from "./parse";
import { buildDoc } from "./doc";
import { applyStyle, buildBaseGraph, CELL_RADIUS, CELL_WIDTH, weightScale } from "./graph";
import { applyChain, type FilterStep } from "./filter";
import { DEFAULT_STYLE, type GraphDoc, type GraphStyle } from "../types";
import { NEUTRAL } from "../theme";

/**
 * Golden output for the sample dataset across the styling and filtering paths.
 * The snapshot was seeded from the pre-node-table pipeline and matched it
 * exactly, so it pins the behaviour that refactors must not drift from.
 */

const round = (v: number | null) => (v === null ? null : Math.round(v * 1e6) / 1e6);

const table = SAMPLE_DATASET.tables[0];
const doc = buildDoc(SAMPLE_DATASET.fileName, table);
const guessed = guessStyle(table, doc.mapping);

const CASES: { name: string; style: GraphStyle; chain: FilterStep[] }[] = [
  { name: "guessed", style: guessed, chain: [] },
  { name: "default", style: DEFAULT_STYLE, chain: [] },
  {
    name: "betweenness-color",
    style: { ...DEFAULT_STYLE, nodeColor: "metric:betweenness" },
    chain: [],
  },
  {
    name: "numeric-color",
    style: { ...DEFAULT_STYLE, nodeColor: "column:Meetings per month" },
    chain: [],
  },
  {
    name: "sized-by-column",
    style: { ...DEFAULT_STYLE, nodeSize: "column:Years together" },
    chain: [],
  },
  {
    name: "eigenvector-size",
    style: { ...DEFAULT_STYLE, nodeSize: "metric:eigenvector" },
    chain: [],
  },
  {
    name: "edge-styled",
    style: {
      ...DEFAULT_STYLE,
      edgeColor: "column:Relationship",
      edgeWidth: "column:Meetings per month",
    },
    chain: [],
  },
  {
    name: "value-filtered",
    style: guessed,
    chain: [
      {
        id: "a",
        enabled: true,
        kind: "column",
        table: "edges",
        column: "Department",
        op: { kind: "values", selected: ["Engineering", "Design"] },
      },
    ],
  },
  {
    name: "range-filtered",
    style: guessed,
    chain: [
      {
        id: "b",
        enabled: true,
        kind: "column",
        table: "edges",
        column: "Meetings per month",
        op: { kind: "range", min: 2, max: null },
      },
    ],
  },
];

function summarize(style: GraphStyle, chain: FilterStep[]) {
  const { graph: base } = applyChain(doc, chain, { showIsolated: false });
  const graph = applyStyle(base, doc, style);
  return {
    nodes: graph.nodes
      .map((n) => [n.id, n.group, round(n.value), n.inDegree, n.outDegree, round(n.radius)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    links: graph.links
      .map((l) => [
        typeof l.source === "string" ? l.source : l.source.id,
        typeof l.target === "string" ? l.target : l.target.id,
        round(l.weight),
        l.colorValue,
        l.curve,
      ])
      .sort((a, b) => `${a[0]}>${a[1]}`.localeCompare(`${b[0]}>${b[1]}`)),
    groups: graph.groups,
    edgeGroups: graph.edgeGroups,
    ranking: graph.ranking && { min: round(graph.ranking.min), max: round(graph.ranking.max) },
    skippedRows: graph.skippedRows,
  };
}

for (const { name, style, chain } of CASES) {
  test(`sample graph: ${name}`, () => {
    expect(summarize(style, chain)).toMatchSnapshot();
  });
}

test("nodes derived from the edge endpoints cover every endpoint exactly once", () => {
  const ids = doc.nodes.rows.map((r) => r[doc.nodeIdColumn]);
  expect(new Set(ids).size).toBe(ids.length);
  const graph = buildBaseGraph(doc);
  expect(graph.nodes.length).toBe(ids.length);
});

test("isolated nodes appear only when asked for", () => {
  const withGhost = {
    ...doc,
    nodes: { ...doc.nodes, rows: [...doc.nodes.rows, { [doc.nodeIdColumn]: "Nobody" }] },
  };
  expect(
    buildBaseGraph(withGhost, { showIsolated: false }).nodes.some((n) => n.id === "Nobody"),
  ).toBe(false);
  expect(
    buildBaseGraph(withGhost, { showIsolated: true }).nodes.some((n) => n.id === "Nobody"),
  ).toBe(true);
});

test("colors and sizes in a column reach the marks as written", () => {
  const withCells = {
    ...doc,
    nodes: {
      ...doc.nodes,
      columns: [
        ...doc.nodes.columns,
        { name: "Ink", type: "text" as const },
        { name: "Px", type: "number" as const },
      ],
      rows: doc.nodes.rows.map((r, i) => ({
        ...r,
        Ink: i === 0 ? "burnt sienna" : "SteelBlue",
        // Past the ceiling on purpose: a stray value can't blow up the canvas.
        Px: i === 0 ? null : 500,
      })),
    },
  };
  const graph = applyStyle(buildBaseGraph(withCells), withCells, {
    ...DEFAULT_STYLE,
    nodeColor: "cell:Ink",
    nodeSize: "cell:Px",
  });

  // A column of colors is not a partition, so there is nothing to key or rank.
  expect(graph.groups).toEqual([]);
  expect(graph.ranking).toBeNull();
  expect(graph.nodes.every((n) => n.group === null)).toBe(true);

  const [first, ...rest] = graph.nodes;
  // A cell that isn't a color takes the neutral; a cell with no number in it
  // keeps the plain size.
  expect(first.color).toBe(NEUTRAL);
  expect(first.radius).toBe(8);
  expect(rest.every((n) => n.color === "#4682b4")).toBe(true);
  expect(rest.every((n) => n.radius === CELL_RADIUS.max)).toBe(true);
});

test("edge colors and widths in a column reach the links as written", () => {
  const withCells = {
    ...doc,
    edges: {
      ...doc.edges,
      columns: [
        ...doc.edges.columns,
        { name: "Ink", type: "text" as const },
        { name: "Px", type: "number" as const },
      ],
      rows: doc.edges.rows.map((r) => ({ ...r, Ink: "#B41", Px: 400 })),
    },
  };
  const graph = applyStyle(buildBaseGraph(withCells), withCells, {
    ...DEFAULT_STYLE,
    edgeColor: "cell:Ink",
    edgeWidth: "cell:Px",
  });

  expect(graph.edgeGroups).toEqual([]);
  expect(graph.links.every((l) => l.colorValue === null)).toBe(true);
  expect(graph.links.every((l) => l.color === "#bb4411")).toBe(true);

  const width = weightScale(graph.links, true);
  expect(graph.links.every((l) => width(l) === CELL_WIDTH.max)).toBe(true);
  // Without the pixel token the same weights normalize onto the usual scale.
  expect(weightScale(graph.links)(graph.links[0])).toBeLessThan(CELL_WIDTH.max);
});

test("node table attributes take precedence over projected edge columns", () => {
  const withDept = {
    ...doc,
    nodes: {
      ...doc.nodes,
      columns: [...doc.nodes.columns, { name: "Department", type: "text" as const }],
      rows: doc.nodes.rows.map((r) => ({ ...r, Department: "Overridden" })),
    },
  };
  const graph = applyStyle(buildBaseGraph(withDept), withDept, {
    ...DEFAULT_STYLE,
    nodeColor: "column:Department",
  });
  expect(graph.groups).toEqual(["Overridden"]);
});

/**
 * Everything counted per node or per link is aggregated with a loop rather
 * than by spreading an array into `Math.max`, because an argument list runs
 * out somewhere around 125,000 and `PARQUET_ROW_LIMIT` alone allows 200,000
 * rows. This is the size at which the spread stops working, so it is the size
 * worth building once.
 */
describe("at the scale the readers actually allow", () => {
  const N = 150_000;
  const rows = Array.from({ length: N }, (_, i) => ({
    From: `n${i}`,
    To: `n${(i + 1) % N}`,
    Weight: i % 97,
  }));
  const big: GraphDoc = {
    name: "big",
    edges: {
      name: "Edges",
      columns: [
        { name: "From", type: "text" },
        { name: "To", type: "text" },
        { name: "Weight", type: "number" },
      ],
      rows,
    },
    nodes: {
      name: "Nodes",
      columns: [{ name: "Id", type: "text" }],
      rows: rows.map((r) => ({ Id: r.From })),
    },
    nodeIdColumn: "Id",
    mapping: { source: "From", target: "To", attrs: ["Weight"] },
    nodesDeclared: true,
  };
  const base = buildBaseGraph(big);

  test("the structure is all there", () => {
    expect(base.nodes).toHaveLength(N);
    expect(base.links).toHaveLength(N);
  });

  test("sizing every node gives every node a radius", () => {
    const graph = applyStyle(base, big, DEFAULT_STYLE);
    expect(graph.nodes.every((n) => isFinite(n.radius) && n.radius > 0)).toBe(true);
  });

  test("a numeric ranking still finds both ends of its range", () => {
    const graph = applyStyle(base, big, { ...DEFAULT_STYLE, nodeColor: "metric:degree" });
    expect(graph.ranking).toEqual({ min: 2, max: 2 });
  });

  test("scaling edge widths finds both ends of theirs", () => {
    const graph = applyStyle(base, big, { ...DEFAULT_STYLE, edgeWidth: "column:Weight" });
    const width = weightScale(graph.links);
    expect(graph.links.every((l) => isFinite(width(l)))).toBe(true);
  });
});
