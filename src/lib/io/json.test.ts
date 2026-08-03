/**
 * JSON and line-delimited JSON. The two readings are the point: a file that is
 * a table of records is read the way a CSV is, and a file that is node-link
 * arrives as two tables with the node attributes already on the nodes. Types
 * come from the values rather than from a sample, which is what a text id made
 * of digits depends on.
 */
import { expect, test } from "vitest";
import { buildBaseGraph } from "../graph";
import { detectFormat, parseText } from "./index";
import { parseJson } from "./json";

const columnType = (columns: { name: string; type: string }[], name: string) =>
  columns.find((c) => c.name === name)?.type;

test("an array of records is an edge table", () => {
  const { doc, dataset } = parseJson(
    JSON.stringify([
      { source: "a", target: "b", weight: 3 },
      { source: "b", target: "c", weight: 1 },
    ]),
    "links.json",
  );

  expect(doc.mapping).toMatchObject({ source: "source", target: "target", attrs: ["weight"] });
  expect(doc.edges.rows).toHaveLength(2);
  expect(columnType(doc.edges.columns, "weight")).toBe("number");
  expect(doc.nodesDeclared).toBe(false);
  // A dataset as well, so the columns are re-pickable the way a sheet's are.
  expect(dataset?.tables.map((t) => t.name)).toEqual(["links"]);
});

test("a lone object is one record, which is what one line on its own parses as", () => {
  const { doc, dataset } = parseJson('{"source":"a","target":"b","weight":2}\n', "edge.jsonl");
  expect(dataset?.tables[0].rows).toEqual([{ source: "a", target: "b", weight: 2 }]);
  expect(doc.mapping).toMatchObject({ source: "source", target: "target" });
});

test("one record per line reads the same as one array", () => {
  const lines = '{"from":"a","to":"b"}\n\n{"from":"b","to":"c"}\n';
  const { doc } = parseJson(lines, "edges.ndjson");
  expect(doc.mapping).toMatchObject({ source: "from", target: "to" });
  expect(doc.edges.rows).toEqual([
    { from: "a", to: "b" },
    { from: "b", to: "c" },
  ]);
});

test("the file states the type, so a zero-padded id stays text", () => {
  const { doc } = parseJson(
    JSON.stringify([
      { from: "007", to: "010", rank: 1 },
      { from: "010", to: "007", rank: 2 },
    ]),
    "codes.json",
  );
  expect(columnType(doc.edges.columns, "from")).toBe("text");
  expect(doc.edges.rows[0].from).toBe("007");
  expect(columnType(doc.edges.columns, "rank")).toBe("number");
});

test("a value deeper than a cell keeps its JSON rather than going missing", () => {
  const { doc } = parseJson(
    JSON.stringify([{ source: "a", target: "b", tags: ["x", "y"], meta: { note: "hi" } }]),
    "links.json",
  );
  expect(doc.edges.rows[0].tags).toBe('["x","y"]');
  expect(doc.edges.rows[0].meta).toBe('{"note":"hi"}');
  expect(columnType(doc.edges.columns, "tags")).toBe("text");
});

test("records with different keys line up, missing ones reading empty", () => {
  const { doc } = parseJson(
    JSON.stringify([
      { source: "a", target: "b", weight: 2 },
      { source: "b", target: "c", note: "later" },
    ]),
    "links.json",
  );
  expect(doc.edges.columns.map((c) => c.name)).toEqual(["source", "target", "weight", "note"]);
  expect(doc.edges.rows[1]).toEqual({ source: "b", target: "c", weight: null, note: "later" });
});

test("node-link arrives as two tables, the node attributes on the nodes", () => {
  const { doc, style } = parseJson(
    JSON.stringify({
      directed: false,
      nodes: [
        { id: "a", group: "left", size: 4 },
        { id: "b", group: "right", size: 9 },
      ],
      links: [{ source: "a", target: "b", value: 2 }],
    }),
    "graph.json",
  );

  expect(doc.nodeIdColumn).toBe("id");
  expect(doc.nodesDeclared).toBe(true);
  expect(doc.nodes.columns.map((c) => c.name)).toEqual(["id", "group", "size"]);
  expect(doc.nodes.rows).toHaveLength(2);
  expect(doc.mapping).toMatchObject({ source: "source", target: "target", attrs: ["value"] });
  expect(columnType(doc.nodes.columns, "size")).toBe("number");
  // An arrowhead on an undirected edge would say something the file did not.
  expect(style?.arrows).toBe(false);
});

test("a node-link graph that says nothing about direction keeps its arrows", () => {
  const { style } = parseJson(
    JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }], edges: [{ source: "a", target: "b" }] }),
    "graph.json",
  );
  expect(style).toBeUndefined();
});

test("endpoints written as positions in the nodes array resolve to ids", () => {
  const { doc } = parseJson(
    JSON.stringify({
      nodes: [{ id: "Valjean" }, { id: "Javert" }, { id: "Cosette" }],
      links: [
        { source: 0, target: 1 },
        { source: 1, target: 2 },
      ],
    }),
    "miserables.json",
  );
  expect(doc.edges.rows).toEqual([
    { source: "Valjean", target: "Javert" },
    { source: "Javert", target: "Cosette" },
  ]);
});

test("a graph whose nodes really are numbered keeps its own numbering", () => {
  const { doc } = parseJson(
    JSON.stringify({
      nodes: [{ id: 0 }, { id: 1 }, { id: 2 }],
      links: [{ source: 2, target: 0 }],
    }),
    "numbered.json",
  );
  expect(doc.edges.rows).toEqual([{ source: 2, target: 0 }]);
  const graph = buildBaseGraph(doc, { showIsolated: true });
  expect(graph.links.map((l) => `${l.source as string}->${l.target as string}`)).toEqual(["2->0"]);
});

test("endpoints left as whole nodes by a simulation come back as ids", () => {
  const { doc } = parseJson(
    JSON.stringify({
      nodes: [{ id: "a" }, { id: "b" }],
      links: [{ source: { id: "a", x: 1.5 }, target: { id: "b", x: 9 } }],
    }),
    "settled.json",
  );
  expect(doc.edges.rows).toEqual([{ source: "a", target: "b" }]);
});

test("an edge naming a node the nodes array left out still gets one", () => {
  const { doc } = parseJson(
    JSON.stringify({ nodes: [{ id: "a", team: "x" }], links: [{ source: "a", target: "z" }] }),
    "partial.json",
  );
  expect(doc.nodes.rows).toEqual([{ id: "a", team: "x" }, { id: "z" }]);
});

test("nodes can be bare ids rather than records", () => {
  const { doc } = parseJson(
    JSON.stringify({ nodes: ["a", "b"], links: [{ source: "a", target: "b" }] }),
    "bare.json",
  );
  expect(doc.nodeIdColumn).toBe("Id");
  expect(doc.nodes.rows).toEqual([{ Id: "a" }, { Id: "b" }]);
});

test("an object of arrays opens as a workbook, one table per array", () => {
  const { dataset } = parseJson(
    JSON.stringify({
      title: "ignored, not an array",
      trips: [{ from: "a", to: "b" }],
      people: [{ name: "a", team: "x" }],
      tags: ["not", "records"],
    }),
    "book.json",
  );
  expect(dataset?.tables.map((t) => t.name)).toEqual(["trips", "people"]);
});

test("a file with nothing table-shaped in it says so", () => {
  expect(() => parseJson(JSON.stringify([1, 2, 3]), "counts.json")).toThrow(/No usable table/);
  expect(() => parseJson(JSON.stringify([{ only: "one field" }]), "thin.json")).toThrow(
    /No usable table/,
  );
});

test("broken JSON is reported as JSON, and a broken line as its line", () => {
  expect(() => parseJson('{"nodes": [', "cut.json")).toThrow(/"cut.json" is not valid JSON/);
  expect(() => parseJson('{"a":1,"b":2}\n{"a":3,"b"\n', "half.jsonl")).toThrow(
    /Line 2 of "half.jsonl"/,
  );
});

test("the format is told from the name, or from the way the text opens", () => {
  const records = '[{"source":"a","target":"b"}]';
  expect(detectFormat("links.json", records)).toBe("json");
  expect(detectFormat("links.jsonl", '{"source":"a","target":"b"}')).toBe("json");
  expect(detectFormat("links.ndjson", '{"source":"a","target":"b"}')).toBe("json");
  expect(detectFormat("dump.txt", records)).toBe("json");
  expect(detectFormat("Pasted data", records)).toBe("json");
  // A workspace is JSON too, and stays the app's own file whatever it is called.
  expect(detectFormat("saved.json", '{"format":"network-graph-viewer","version":1}')).toBe(
    "workspace",
  );
  expect(detectFormat("links.csv", "source,target\na,b\n")).toBe("delimited");
});

test("a dropped file reaches the reader through the same door the rest do", async () => {
  const graph = await parseText(
    JSON.stringify({ nodes: [{ id: "a" }, { id: "b" }], links: [{ source: "a", target: "b" }] }),
    "graph.json",
  );
  expect(graph.doc.nodes.rows).toHaveLength(2);
  expect(graph.dataset).toBeUndefined();

  const records = await parseText('{"source":"a","target":"b"}\n', "edges.jsonl");
  expect(records.dataset?.tables[0].rows).toEqual([{ source: "a", target: "b" }]);
});
