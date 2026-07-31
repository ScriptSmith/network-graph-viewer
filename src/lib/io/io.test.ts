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
import { parseGexf, writeGexf } from "./gexf";
import { parseGraphml, writeGraphml } from "./graphml";
import { parseWorkspace, writeWorkspace } from "./ngv";
import { detectFormat, extractGistFileHint, extractGistId, matchesFileHint, toCsv } from "./index";

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
  });
  const { workspace, positions } = parseWorkspace(text, "fallback name");

  expect(workspace.style.nodeColor).toBe("metric:degree");
  expect(workspace.chain).toHaveLength(1);
  expect(workspace.layout).toBe("forceatlas2");
  expect(workspace.layoutParams.scaling).toBe(450);
  expect(workspace.preventOverlap).toBe(true);
  expect(summarize(workspace.doc)).toEqual(summarize(doc));
  expect(positions?.size).toBe(graph.nodes.length);
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
  expect(detectFormat("x.ngv.json", "")).toBe("workspace");
  expect(detectFormat("mystery", '<?xml version="1.0"?><gexf version="1.3">')).toBe("gexf");
  expect(detectFormat("mystery", '<graphml xmlns="x">')).toBe("graphml");
  expect(detectFormat("mystery", '{"format":"network-graph-viewer"}')).toBe("workspace");
  expect(detectFormat("mystery", "a,b\n1,2")).toBe("delimited");
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
