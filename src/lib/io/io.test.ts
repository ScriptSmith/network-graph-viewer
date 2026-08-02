/**
 * @vitest-environment jsdom
 *
 * The XML formats are read and written with the platform's own DOMParser
 * and XMLSerializer, so these tests need a DOM. Only this file pays for it.
 */
import { describe, expect, test } from "vitest";
import { SAMPLE_DATASET } from "../../samples";
import { DEFAULT_STYLE, type Graph, type GraphDoc, type Column, type Row } from "../../types";
import { buildDoc } from "../doc";
import { applyStyle, buildBaseGraph } from "../graph";
import { groupColorMap } from "../../theme";
import { guessStyle } from "../parse";
import { parseDot, writeDot } from "./dot";
import { parseGexf, writeGexf } from "./gexf";
import { parseGraphml, writeGraphml } from "./graphml";
import { parseWorkspace, writeWorkspace } from "./ngv";
import { detectFormat, extractGistFileHint, extractGistId, matchesFileHint, toCsv } from "./index";
import { compoundKey } from "../cells";
import { overlayFromJson } from "../overlay";

const table = SAMPLE_DATASET.tables[0];
const doc = buildDoc("sample", table);
const style = guessStyle(table, doc.mapping);

function styled(source: GraphDoc): Graph {
  const graph = applyStyle(buildBaseGraph(source), source, style);
  // Positions normally come from the simulation; fake them so the exporter has
  // something to write.
  graph.nodes.forEach((node, i) => {
    node.x = i * 10;
    node.y = i * -5;
  });
  return graph;
}

const summarize = (source: GraphDoc) => {
  const graph = buildBaseGraph(source, { showIsolated: true });
  return {
    nodes: graph.nodes.map((n) => n.id).sort(),
    links: graph.links.map((l) => `${l.source as string}->${l.target as string}`).sort(),
  };
};

test("GEXF survives a round trip with its attributes intact", () => {
  const graph = styled(doc);
  const text = writeGexf({ doc, graph, style, colors: groupColorMap(graph.groups) });
  const { doc: back, positions } = parseGexf(text, "round-trip");

  expect(summarize(back)).toEqual(summarize(doc));
  expect(back.nodes.rows).toHaveLength(doc.nodes.rows.length);
  expect(back.edges.rows).toHaveLength(doc.edges.rows.length);

  // Edge attributes come back on the right edges.
  const original = doc.edges.rows[0];
  const roundTripped = back.edges.rows.find(
    (r: Row) =>
      r.Source === original[doc.mapping.source] && r.Target === original[doc.mapping.target],
  );
  expect(roundTripped?.Department).toBe(original.Department);
  expect(roundTripped?.["Meetings per month"]).toBe(original["Meetings per month"]);

  // Positions travel too, with the y axis flipped back the way it came.
  expect(positions?.get("Alex Rivera")).toBeDefined();
  const alex = graph.nodes.find((n) => n.id === "Alex Rivera");
  expect(positions?.get("Alex Rivera")?.x).toBeCloseTo(alex?.x ?? 0, 1);
});

test("GEXF numeric attributes come back as numbers, not strings", () => {
  const graph = styled(doc);
  const text = writeGexf({ doc, graph, style, colors: groupColorMap(graph.groups) });
  const { doc: back } = parseGexf(text, "round-trip");
  const column = back.edges.columns.find((c: Column) => c.name === "Meetings per month");
  expect(column?.type).toBe("number");
  expect(typeof back.edges.rows[0]["Meetings per month"]).toBe("number");
});

test("GraphML survives a round trip", () => {
  const text = writeGraphml(doc);
  const { doc: back } = parseGraphml(text, "round-trip");
  expect(summarize(back)).toEqual(summarize(doc));
  expect(back.edges.rows[0].Department).toBe(doc.edges.rows[0].Department);
  expect(back.edges.columns.find((c: Column) => c.name === "Years together")?.type).toBe("number");
});

test("DOT survives a round trip, positions and all", () => {
  const graph = styled(doc);
  const text = writeDot({ doc, graph, style, colors: groupColorMap(graph.groups) });
  const { doc: back, positions } = parseDot(text, "round-trip");

  expect(text.startsWith("digraph ")).toBe(true);
  expect(summarize(back)).toEqual(summarize(doc));

  const original = doc.edges.rows[0];
  const roundTripped = back.edges.rows.find(
    (r: Row) =>
      r.Source === original[doc.mapping.source] && r.Target === original[doc.mapping.target],
  );
  expect(roundTripped?.Department).toBe(original.Department);
  expect(roundTripped?.["Meetings per month"]).toBe(original["Meetings per month"]);

  const alex = graph.nodes.find((n) => n.id === "Alex Rivera");
  expect(positions?.get("Alex Rivera")?.x).toBeCloseTo(alex?.x ?? 0, 1);
  expect(positions?.get("Alex Rivera")?.y).toBeCloseTo(alex?.y ?? 0, 1);
});

/**
 * `pos` defaults to the origin, and every node pinned to the origin is one
 * pile, so a graph that has not been laid out has to leave both the pins and
 * the engine that honours them out and let Graphviz place it.
 */
test("DOT leaves out the pins when the graph has no positions", () => {
  const graph = applyStyle(buildBaseGraph(doc), doc, style);
  const text = writeDot({ doc, graph, style, colors: groupColorMap(graph.groups) });
  expect(text).not.toContain("pos=");
  expect(text).not.toContain("neato");
  expect(parseDot(text, "x").positions).toBeUndefined();
});

/**
 * Everything the language does that two tables cannot hold: defaults standing
 * in front of the rows they apply to, a chain that is really its pairs, an
 * endpoint that is really a set of them, a cluster, a port, and the three
 * kinds of comment.
 */
const DOT_SOURCE = `
/* A team, drawn. */
digraph teams {
  node [type="person"];
  edge [via="email"];
  a [label="Alex", pos="10,20!"];
  b;
  a -> b -> c [weight=2];   // the chain is its pairs
  subgraph cluster_ops {
    label = "Operations";
    d; e;
  }
  { d e } -> f;
  a:port:se -> f;
# a line the preprocessor left behind
  g;
}
`;

test("DOT flattens what the two tables cannot hold", () => {
  const { doc: back, positions, style: stated } = parseDot(DOT_SOURCE, "teams.dot");

  expect(back.nodes.rows.map((r: Row) => r.Id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  expect(back.edges.rows.map((r: Row) => `${r.Source}->${r.Target}`)).toEqual([
    "a->b",
    "b->c",
    "d->f",
    "e->f",
    "a->f",
  ]);
  // The id a DOT file writes is a name already, so it stays the id and the
  // label becomes what the nodes are called on screen.
  expect(stated).toEqual({ nodeLabel: "column:label" });
  expect(back.nodes.rows[0].label).toBe("Alex");

  // A default block reaches every row declared after it.
  expect(back.nodes.rows.every((r: Row) => r.type === "person")).toBe(true);
  expect(back.edges.rows.every((r: Row) => r.via === "email")).toBe(true);
  // One attribute list at the end of a chain applies to every pair in it.
  expect(back.edges.rows.slice(0, 2).map((r: Row) => r.weight)).toEqual([2, 2]);
  expect(back.edges.columns.find((c: Column) => c.name === "weight")?.type).toBe("number");

  // A cluster is a grouping rather than a shared setting, so it lands as one.
  const cluster = (id: string) => back.nodes.rows.find((r: Row) => r.Id === id)?.Cluster;
  expect([cluster("d"), cluster("e"), cluster("a")]).toEqual(["Operations", "Operations", null]);

  // `pos` is geometry, not data: it becomes a position and not a column.
  expect(positions?.get("a")).toEqual({ x: 10, y: -20 });
  expect(back.nodes.columns.map((c: Column) => c.name)).not.toContain("pos");
});

test("an undirected DOT graph arrives without arrowheads", () => {
  const { doc: back, style: stated } = parseDot("strict graph { a -- b -- c }", "x");
  expect(stated).toEqual({ arrows: false });
  expect(back.edges.rows).toHaveLength(2);
});

test("DOT names survive quoting, escapes, joining and HTML", () => {
  const { doc: back } = parseDot(
    'digraph { "a \\"quoted\\" name" -> "one " + "long name"; c [label=<<b>Bold</b> &amp; plain>]; }',
    "x",
  );
  const ids = back.nodes.rows.map((r: Row) => r.Id);
  expect(ids).toEqual(['a "quoted" name', "one long name", "c"]);
  // Markup has nowhere to go in a table, so an HTML label arrives as its text.
  expect(back.nodes.rows[2].label).toBe("Bold & plain");
});

/**
 * A record's label is its field layout rather than its name, which is why the
 * ids here are left alone: promoting labels to ids the way the GEXF and
 * GraphML readers do would name every node after a pile of pipes and braces.
 */
test("DOT keeps the ids a record label would have replaced", () => {
  const { doc: back } = parseDot(
    'digraph structs { node [shape=record]; s1 [label="<f0> left|<f1> right"]; ' +
      's2 [label="<f0> one|<f1> two"]; s1:f1 -> s2:f0; }',
    "x",
  );
  expect(back.nodes.rows.map((r: Row) => r.Id)).toEqual(["s1", "s2"]);
  expect(back.edges.rows).toEqual([{ Source: "s1", Target: "s2" }]);
});

/**
 * DOT arrives from a dropped file, a gist and a shared link alike, so a
 * truncated or nonsense one has to reach a sentence the reader can act on
 * rather than a missing property, and it has to get there at all: a parser
 * that stops consuming tokens without stopping is a hung tab.
 */
test("malformed DOT says so instead of spinning or throwing at random", () => {
  const bad = [
    "",
    "digraph",
    "digraph {",
    "digraph { a -> ",
    "digraph { a [",
    "digraph { a [x=",
    "digraph { , }",
    'digraph { "unclosed }',
    "digraph { <unclosed }",
    "graph { subgraph cluster_a { b }",
    "not a graph at all",
  ];
  for (const text of bad) {
    expect(() => parseDot(text, "x"), text).toThrow(/^That DOT file/);
  }
});

test("a workspace round trip restores the whole session", () => {
  const graph = styled(doc);
  const text = writeWorkspace({
    doc,
    graph,
    style: { ...DEFAULT_STYLE, nodeColor: "metric:degree" },
    chain: [
      {
        id: "a",
        enabled: true,
        kind: "degree",
        mode: "all",
        min: 2,
        max: null,
      },
    ],
    layout: "forceatlas2",
    layoutParams: { scaling: 450, linLog: true },
    showIsolated: true,
    preventOverlap: true,
    pinned: ["a"],
  });
  const { workspace, positions } = parseWorkspace(text, "fallback name");

  expect(workspace.style.nodeColor).toBe("metric:degree");
  expect(workspace.chain).toHaveLength(1);
  expect(workspace.layout).toBe("forceatlas2");
  expect(workspace.layoutParams.scaling).toBe(450);
  expect(workspace.preventOverlap).toBe(true);
  expect(workspace.pinned).toEqual(["a"]);
  expect(summarize(workspace.doc)).toEqual(summarize(doc));
  expect(positions?.size).toBe(graph.nodes.length);
});

test("the geographic layout and its columns survive the workspace round trip", () => {
  const text = writeWorkspace({
    doc,
    graph: null,
    style: DEFAULT_STYLE,
    chain: [],
    layout: "geo",
    layoutParams: { latColumn: "Lat", lonColumn: "Lon" },
    showIsolated: false,
    preventOverlap: false,
  });
  const { workspace } = parseWorkspace(text, "x");
  expect(workspace.layout).toBe("geo");
  expect(workspace.layoutParams).toEqual({ latColumn: "Lat", lonColumn: "Lon" });
});

test("style curves round-trip when valid and are dropped when not", () => {
  const written = JSON.parse(
    writeWorkspace({
      doc,
      graph: null,
      style: { ...DEFAULT_STYLE, nodeSizeCurve: "log", edgeWidthCurve: "linear" },
      chain: [],
      layout: "force",
      layoutParams: {},
      showIsolated: false,
      preventOverlap: false,
    }),
  );
  const { workspace } = parseWorkspace(JSON.stringify(written), "x");
  expect(workspace.style.nodeSizeCurve).toBe("log");
  expect(workspace.style.edgeWidthCurve).toBe("linear");
  expect(workspace.style.nodeColorCurve).toBeUndefined();

  written.style.nodeSizeCurve = "cubic"; // not a curve the app knows
  const cleaned = parseWorkspace(JSON.stringify(written), "x").workspace.style;
  expect(cleaned.nodeSizeCurve).toBeUndefined();
  expect(cleaned.edgeWidthCurve).toBe("linear");
});

test("type blocks keep their shape-checked parts and drop the junk", () => {
  const written = JSON.parse(
    writeWorkspace({
      doc,
      graph: null,
      style: {
        ...DEFAULT_STYLE,
        typeStyles: {
          column: "Kind",
          styles: { A: { color: "#112233", size: 5, labelColumn: "Alias", attrs: ["x"] } },
        },
        edgeTypeStyles: {
          column: "Tie",
          styles: { strong: { color: "#445566", width: 3, attrs: ["w"] } },
        },
      },
      chain: [],
      layout: "force",
      layoutParams: {},
      showIsolated: false,
      preventOverlap: false,
    }),
  );
  written.style.typeStyles.styles.A.color = "orange"; // not #rrggbb
  written.style.edgeTypeStyles.styles.strong.width = "fat"; // not a number

  const { workspace } = parseWorkspace(JSON.stringify(written), "x");
  expect(workspace.style.typeStyles).toEqual({
    column: "Kind",
    styles: { A: { size: 5, labelColumn: "Alias", attrs: ["x"] } },
  });
  expect(workspace.style.edgeTypeStyles).toEqual({
    column: "Tie",
    styles: { strong: { color: "#445566", attrs: ["w"] } },
  });

  // A block with a column and no overrides yet is a choice worth keeping.
  written.style.typeStyles = { column: "Kind", styles: {} };
  delete written.style.edgeTypeStyles;
  const kept = parseWorkspace(JSON.stringify(written), "x").workspace.style;
  expect(kept.typeStyles).toEqual({ column: "Kind", styles: {} });
  expect(kept.edgeTypeStyles).toBeUndefined();
});

test("a role the app does not know is dropped rather than trusted", () => {
  const damaged = JSON.parse(
    writeWorkspace({
      doc,
      graph: null,
      style: DEFAULT_STYLE,
      chain: [],
      layout: "force",
      layoutParams: {},
      showIsolated: false,
      preventOverlap: false,
    }),
  );
  damaged.doc.edges.columns[0].role = "sneaky";
  damaged.doc.nodes.columns[0].role = "color";
  const parsed = parseWorkspace(JSON.stringify(damaged), "x");
  expect(parsed.doc.edges.columns[0].role).toBeUndefined();
  expect(parsed.doc.nodes.columns[0].role).toBe("color");
});

test("a workspace from a newer version is refused rather than half-read", () => {
  const text = JSON.stringify({ format: "network-graph-viewer", version: 99, doc });
  expect(() => parseWorkspace(text, "x")).toThrow(/newer version/);
});

test("non-workspace JSON is rejected with a useful message", () => {
  expect(() => parseWorkspace('{"nodes":[]}', "x")).toThrow(/not a Network Graph Viewer/);
});

/**
 * A workspace can arrive from a `#data=` link, which is to say from anyone. The
 * document goes onto the render path, where a missing table throws out of a
 * `useMemo` and takes the whole app down with it, so every one of these has to
 * be refused here rather than repaired downstream.
 */
describe("a damaged workspace is refused at the door", () => {
  const wrap = (docPatch: unknown) =>
    JSON.stringify({ format: "network-graph-viewer", version: 1, doc: docPatch });

  const good = {
    name: "g",
    edges: {
      name: "E",
      columns: [
        { name: "a", type: "text" },
        { name: "b", type: "text" },
      ],
      rows: [{ a: "1", b: "2" }],
    },
    nodes: { name: "N", columns: [{ name: "Id", type: "text" }], rows: [{ Id: "1" }] },
    nodeIdColumn: "Id",
    mapping: { source: "a", target: "b", attrs: [] },
    nodesDeclared: true,
  };

  test.each([
    ["no tables at all", { name: "x" }],
    ["no edge table", { ...good, edges: undefined }],
    ["no node table", { ...good, nodes: undefined }],
    ["no mapping", { ...good, mapping: undefined }],
    ["a mapping naming no columns", { ...good, mapping: { attrs: [] } }],
    ["a node id column that is not a name", { ...good, nodeIdColumn: 7 }],
    ["a table whose rows are not rows", { ...good, edges: { ...good.edges, rows: [null] } }],
    ["a table with no columns array", { ...good, edges: { name: "E", rows: [] } }],
  ])("%s", (_label, damaged) => {
    expect(() => parseWorkspace(wrap(damaged), "x")).toThrow(/damaged/);
  });

  test("a good document still opens", () => {
    expect(() => parseWorkspace(wrap(good), "x")).not.toThrow();
  });
});

/**
 * Everything outside the document is a view of it, so a value the app does not
 * recognise is dropped and the graph still opens. Each of these would otherwise
 * reach code that assumes it is the shape it claims to be.
 */
test("unrecognised chain steps, layouts, styles and positions are dropped, not obeyed", () => {
  const text = JSON.stringify({
    format: "network-graph-viewer",
    version: 1,
    doc,
    chain: [
      { id: "a", enabled: true, kind: "not-a-filter" },
      { id: "b", enabled: true, kind: "degree" }, // right kind, missing its fields
      { id: "c", enabled: true, kind: "kcore", k: 2 }, // the only real one
    ],
    layout: "definitely-not-a-layout",
    layoutParams: "not an object",
    style: { nodeColor: 42, spacing: "wide", arrows: "yes" },
    positions: { a: { x: 1, y: 2 }, b: { x: "no", y: 2 }, c: null },
  });
  const { workspace, positions } = parseWorkspace(text, "x");

  expect(workspace.chain.map((s) => s.id)).toEqual(["c"]);
  expect(workspace.layout).toBe("force");
  expect(workspace.layoutParams).toEqual({});
  // A token the app calls startsWith on has to be a string or nothing draws.
  expect(workspace.style.nodeColor).toBe(DEFAULT_STYLE.nodeColor);
  expect(workspace.style.spacing).toBe(DEFAULT_STYLE.spacing);
  expect(workspace.style.arrows).toBe(DEFAULT_STYLE.arrows);
  expect([...(positions ?? [])]).toEqual([["a", { x: 1, y: 2 }]]);
});

test("formats are detected from the name or, failing that, the content", () => {
  expect(detectFormat("x.gexf", "")).toBe("gexf");
  expect(detectFormat("x.graphml", "")).toBe("graphml");
  expect(detectFormat("x.dot", "")).toBe("dot");
  expect(detectFormat("x.gv", "")).toBe("dot");
  expect(detectFormat("x.ngv.json", "")).toBe("workspace");
  expect(detectFormat("mystery", '<?xml version="1.0"?><gexf version="1.3">')).toBe("gexf");
  expect(detectFormat("mystery", '<graphml xmlns="x">')).toBe("graphml");
  expect(detectFormat("mystery", '{"format":"network-graph-viewer"}')).toBe("workspace");
  expect(detectFormat("mystery", "// a graph\nstrict digraph G {\n  a -> b\n}")).toBe("dot");
  expect(detectFormat("mystery", "a,b\n1,2")).toBe("delimited");
  // A header that opens with the word is still a spreadsheet, not a drawing.
  expect(detectFormat("mystery", "graph,nodes\n1,2")).toBe("delimited");
});

test("gist ids are recovered from every URL shape GitHub hands out", () => {
  const id = "aa11bb22cc33dd44ee55ff66aa77bb88";
  expect(extractGistId(id)).toBe(id);
  expect(extractGistId(`https://gist.github.com/someone/${id}`)).toBe(id);
  expect(extractGistId(`https://gist.github.com/${id}`)).toBe(id);
  expect(extractGistId(`https://api.github.com/gists/${id}`)).toBe(id);
  expect(extractGistId(`https://gist.githubusercontent.com/someone/${id}/raw/x/data.csv`)).toBe(id);
  expect(extractGistId(`https://gist.github.com/someone/${id}#file-data-csv`)).toBe(id);
  expect(extractGistId("https://example.com/not-a-gist")).toBeNull();
  expect(extractGistId("nonsense")).toBeNull();
});

test("a file fragment picks a file out of a multi-file gist", () => {
  expect(extractGistFileHint("https://gist.github.com/a/b#file-my-data-csv")).toBe("my-data-csv");
  expect(extractGistFileHint("https://gist.github.com/a/b")).toBeNull();
  expect(matchesFileHint("my data.csv", "my-data-csv")).toBe(true);
  expect(matchesFileHint("other.csv", "my-data-csv")).toBe(false);
});

test("CSV quotes anything that would otherwise break a row", () => {
  const csv = toCsv(
    ["a", "b"],
    [
      { a: 'say "hi"', b: "x,y" },
      { a: "line\nbreak", b: null },
    ],
  );
  expect(csv).toBe('a,b\n"say ""hi""","x,y"\n"line\nbreak",');
});

/**
 * A cell can have arrived from a spreadsheet somebody else wrote or from a
 * shared link anyone can write, and this file is going straight back into a
 * spreadsheet. Quoting keeps the row parseable; it does nothing about the row
 * being executed.
 */
test("CSV defuses cells a spreadsheet would run as a formula", () => {
  const csv = toCsv(
    ["a"],
    [
      { a: '=HYPERLINK("http://evil.example","click")' },
      { a: "+1+1" },
      { a: "-2+3" },
      { a: "@SUM(A1:A9)" },
      { a: "\t=1+1" },
    ],
  );
  const cells = csv.split("\n").slice(1);
  expect(cells.every((c) => /^'|^"'/.test(c))).toBe(true);
  expect(cells[0]).toContain("'=HYPERLINK");
});

test("CSV leaves plain numbers alone, sign and all", () => {
  const csv = toCsv(["a"], [{ a: -5 }, { a: "-5" }, { a: 12.5 }, { a: "+3" }, { a: "1e6" }]);
  expect(csv).toBe("a\n-5\n-5\n12.5\n+3\n1e6");
});

test("the compute recipe rides the workspace, unknown metric ids dropped", () => {
  const written = JSON.parse(
    writeWorkspace({
      doc,
      graph: null,
      style: DEFAULT_STYLE,
      chain: [],
      layout: "force",
      layoutParams: {},
      showIsolated: false,
      preventOverlap: false,
      computed: [
        { metrics: ["degree", "louvain"], options: { weightColumn: null, resolution: 1.4 } },
      ],
    }),
  );
  const { workspace } = parseWorkspace(JSON.stringify(written), "x");
  expect(workspace.computed).toEqual([
    { metrics: ["degree", "louvain"], options: { weightColumn: null, resolution: 1.4 } },
  ]);

  written.computed[0].metrics.push("astrology");
  written.computed.push({ metrics: ["astrology"], options: {} });
  const cleaned = parseWorkspace(JSON.stringify(written), "x").workspace;
  expect(cleaned.computed).toHaveLength(1);
  expect(cleaned.computed?.[0].metrics).toEqual(["degree", "louvain"]);
});

test("the edits overlay rides the workspace and validates on the way back", () => {
  const dirty = compoundKey("nodes", "Alex Rivera", "Department");
  const written = JSON.parse(
    writeWorkspace({
      doc,
      graph: null,
      style: DEFAULT_STYLE,
      chain: [],
      layout: "force",
      layoutParams: {},
      showIsolated: false,
      preventOverlap: false,
      edits: {
        dirtyCells: new Set([dirty]),
        tombstones: new Set<string>(),
        addedRows: new Set<string>(),
        idRenames: [{ from: "Old", to: "New" }],
        columnOps: [{ op: "add", table: "nodes", name: "Notes", type: "text" }],
      },
    }),
  );
  const { workspace } = parseWorkspace(JSON.stringify(written), "x");
  expect(workspace.edits?.dirtyCells).toEqual([dirty]);
  expect(workspace.edits?.idRenames).toEqual([{ from: "Old", to: "New" }]);

  written.edits.columnOps.push({ op: "detonate", table: "nodes" });
  const cleaned = parseWorkspace(JSON.stringify(written), "x").workspace;
  const back = overlayFromJson(cleaned.edits);
  expect(back.columnOps).toEqual([{ op: "add", table: "nodes", name: "Notes", type: "text" }]);
  expect(back.dirtyCells.has(dirty)).toBe(true);

  // A workspace with no edits carries no block at all.
  const plain = JSON.parse(
    writeWorkspace({
      doc,
      graph: null,
      style: DEFAULT_STYLE,
      chain: [],
      layout: "force",
      layoutParams: {},
      showIsolated: false,
      preventOverlap: false,
    }),
  );
  expect(plain.edits).toBeUndefined();
  expect(plain.computed).toBeUndefined();
});

test("a timewindow step survives the workspace round trip", () => {
  const text = writeWorkspace({
    doc,
    graph: null,
    style: DEFAULT_STYLE,
    chain: [
      {
        id: "t1",
        enabled: true,
        kind: "timewindow",
        table: "edges",
        column: "When",
        min: 100,
        max: null,
      },
    ],
    layout: "force",
    layoutParams: {},
    showIsolated: false,
    preventOverlap: false,
  });
  const { workspace } = parseWorkspace(text, "x");
  expect(workspace.chain).toHaveLength(1);
  expect(workspace.chain[0]).toMatchObject({ kind: "timewindow", column: "When", min: 100 });
});
