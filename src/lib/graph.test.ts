import { expect, test } from "vitest";
import { SAMPLE_DATASET } from "../sample-data";
import { guessStyle } from "./parse";
import { buildDoc } from "./doc";
import { applyStyle, buildBaseGraph } from "./graph";
import { applyChain, type FilterStep } from "./filter";
import { DEFAULT_STYLE, type GraphStyle } from "../types";

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
