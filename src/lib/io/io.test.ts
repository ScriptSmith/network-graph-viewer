/**
 * @vitest-environment jsdom
 *
 * The XML formats are read and written with the platform's own DOMParser
 * and XMLSerializer, so these tests need a DOM. Only this file pays for it.
 */
import { expect, test } from "vitest";
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
