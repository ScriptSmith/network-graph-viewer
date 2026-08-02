import { describe, expect, test } from "vitest";
import { SAMPLE_DATASET } from "../samples";
import { guessStyle } from "./parse";
import { buildDoc } from "./doc";
import {
  applyStyle,
  buildBaseGraph,
  CELL_RADIUS,
  CELL_WIDTH,
  curveFn,
  markColor,
  weightScale,
} from "./graph";
import { applyChain, type FilterStep } from "./filter";
import { DEFAULT_STYLE, type GraphDoc, type GraphStyle } from "../types";
import { NEUTRAL } from "../theme";
import { maxOf } from "./numbers";

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

test("a label column names the nodes without re-keying them", () => {
  const withNames = {
    ...doc,
    nodes: {
      ...doc.nodes,
      columns: [...doc.nodes.columns, { name: "Name", type: "text" as const }],
      rows: doc.nodes.rows.map((r, i) => ({ ...r, Name: i === 0 ? "" : `Person ${i}` })),
    },
  };
  const graph = applyStyle(buildBaseGraph(withNames), withNames, {
    ...DEFAULT_STYLE,
    nodeLabel: "column:Name",
  });

  const [first, ...rest] = graph.nodes;
  // A blank cell keeps the id, and the ids themselves never move.
  expect(first.label).toBe(first.id);
  expect(rest.every((n) => n.label.startsWith("Person "))).toBe(true);
  expect(graph.nodes.map((n) => n.id)).toEqual(buildBaseGraph(doc).nodes.map((n) => n.id));

  // Off, or pointed at a column that is not there, labels stay ids.
  const off = applyStyle(buildBaseGraph(withNames), withNames, DEFAULT_STYLE);
  expect(off.nodes.every((n) => n.label === n.id)).toBe(true);
  const gone = applyStyle(buildBaseGraph(withNames), withNames, {
    ...DEFAULT_STYLE,
    nodeLabel: "column:Nope",
  });
  expect(gone.nodes.every((n) => n.label === n.id)).toBe(true);
});

test("type overrides replace exactly the channels they name", () => {
  const withKind = {
    ...doc,
    nodes: {
      ...doc.nodes,
      columns: [
        ...doc.nodes.columns,
        { name: "Kind", type: "text" as const },
        { name: "Alias", type: "text" as const },
      ],
      rows: doc.nodes.rows.map((r, i) => ({
        ...r,
        Kind: i % 2 === 0 ? "A" : "B",
        Alias: `alias-${i}`,
      })),
    },
  };
  const plain = applyStyle(buildBaseGraph(withKind), withKind, DEFAULT_STYLE);
  const styled = applyStyle(buildBaseGraph(withKind), withKind, {
    ...DEFAULT_STYLE,
    typeStyles: {
      column: "Kind",
      styles: { A: { color: "#112233", size: 40, labelColumn: "Alias" } },
    },
  });

  const plainById = new Map(plain.nodes.map((n) => [n.id, n]));
  for (const node of styled.nodes) {
    const before = plainById.get(node.id) as (typeof styled.nodes)[number];
    if (node.row.Kind === "A") {
      expect(node.color).toBe("#112233");
      expect(node.radius).toBe(40);
      expect(node.label).toBe(node.row.Alias);
    } else {
      // The other kind is untouched, channel for channel.
      expect(node.color).toBe(before.color);
      expect(node.radius).toBe(before.radius);
      expect(node.label).toBe(node.id);
    }
  }
});

test("edge type overrides paint and widen only their own kind", () => {
  const withKind = {
    ...doc,
    edges: {
      ...doc.edges,
      columns: [...doc.edges.columns, { name: "Tie", type: "text" as const }],
      rows: doc.edges.rows.map((r, i) => ({ ...r, Tie: i % 2 === 0 ? "strong" : "weak" })),
    },
  };
  const graph = applyStyle(buildBaseGraph(withKind), withKind, {
    ...DEFAULT_STYLE,
    edgeTypeStyles: { column: "Tie", styles: { strong: { color: "#445566", width: 9 } } },
  });

  for (const link of graph.links) {
    const kind = link.rows[0].Tie;
    if (kind === "strong") {
      expect(link.color).toBe("#445566");
      expect(link.width).toBe(9);
    } else {
      expect(link.color).toBeNull();
      expect(link.width).toBeNull();
    }
  }
});

describe("curve functions", () => {
  test("every curve pins the endpoints and rises monotonically between them", () => {
    for (const curve of ["linear", "sqrt", "log"] as const) {
      const f = curveFn(curve);
      expect(f(0)).toBe(0);
      expect(f(1)).toBeCloseTo(1, 12);
      let last = 0;
      for (let i = 1; i <= 20; i++) {
        const v = f(i / 20);
        expect(v).toBeGreaterThan(last);
        last = v;
      }
    }
  });

  test("log lifts small values without blowing up at zero", () => {
    const log = curveFn("log");
    expect(log(0)).toBe(0);
    expect(isFinite(log(0.001))).toBe(true);
    expect(log(0.1)).toBeGreaterThan(0.1);
  });

  test("curves left unset reproduce the old sizing and widths exactly", () => {
    const base = buildBaseGraph(doc);
    const plain = applyStyle(base, doc, DEFAULT_STYLE);
    const spelled = applyStyle(base, doc, { ...DEFAULT_STYLE, nodeSizeCurve: "sqrt" });
    expect(spelled.nodes.map((n) => n.radius)).toEqual(plain.nodes.map((n) => n.radius));

    const weighted = applyStyle(base, doc, {
      ...DEFAULT_STYLE,
      edgeWidth: "column:Meetings per month",
    });
    const defaultWidth = weightScale(weighted.links);
    const sqrtWidth = weightScale(weighted.links, false, "sqrt");
    expect(weighted.links.map(defaultWidth)).toEqual(weighted.links.map(sqrtWidth));
  });

  test("a log size curve reshapes the middle and leaves the largest alone", () => {
    const base = buildBaseGraph(doc);
    const sqrtSized = applyStyle(base, doc, DEFAULT_STYLE);
    const logSized = applyStyle(base, doc, { ...DEFAULT_STYLE, nodeSizeCurve: "log" });
    const before = new Map(sqrtSized.nodes.map((n) => [n.id, n.radius]));
    const maxRadius = maxOf(sqrtSized.nodes.map((n) => n.radius));
    let changed = 0;
    for (const node of logSized.nodes) {
      const was = before.get(node.id) as number;
      if (was === maxRadius) expect(node.radius).toBeCloseTo(was, 9);
      else if (Math.abs(node.radius - was) > 1e-9) changed++;
    }
    expect(changed).toBeGreaterThan(0);
  });

  test("the color curve rides the ranking into markColor", () => {
    const base = buildBaseGraph(doc);
    const linear = applyStyle(base, doc, { ...DEFAULT_STYLE, nodeColor: "metric:degree" });
    expect(linear.ranking?.curve).toBeUndefined();
    const curved = applyStyle(base, doc, {
      ...DEFAULT_STYLE,
      nodeColor: "metric:degree",
      nodeColorCurve: "log",
    });
    expect(curved.ranking?.curve).toBe("log");
    // A mid-range node reads further up the ramp through the log curve.
    const mid = curved.nodes.find(
      (n) =>
        n.value !== null &&
        n.value > (curved.ranking?.min ?? 0) &&
        n.value < (curved.ranking?.max ?? 0),
    );
    expect(mid).toBeDefined();
    const colors = new Map<string, string>();
    const palette = { categorical: ["#111111"], sequential: ["#000001", "#000002", "#000003"] };
    const lin = markColor(mid as (typeof curved.nodes)[number], linear.ranking, colors, palette);
    const log = markColor(mid as (typeof curved.nodes)[number], curved.ranking, colors, palette);
    expect(log >= lin).toBe(true);
  });
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
