import { expect, test } from "vitest";
import type { GraphDoc, Row, Table } from "../types";
import { buildDoc } from "./doc";
import { buildBaseGraph } from "./graph";
import { docIncidence, incidenceOf, nodeIndex } from "./graphIndex";

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

/** One node's neighbours in the order the index holds them. */
function neighboursOf(
  incidence: ReturnType<typeof incidenceOf>,
  ids: string[],
  id: string,
): string[] {
  const v = ids.indexOf(id);
  const out: string[] = [];
  for (let p = incidence.offsets[v]; p < incidence.offsets[v + 1]; p++) {
    out.push(ids[incidence.neighbor[p]]);
  }
  return out;
}

test("a node's entries are in link order, which is what keeps results still", () => {
  // X is the source of link 0, the target of link 1 and the source of link 2.
  // Anything that walked the links and appended to both endpoints produced
  // A, B, C in that order, and Louvain, the golden snapshot and a script
  // reading `graph.neighbors` all depend on it staying that way.
  const base = buildBaseGraph(
    docOf([
      ["X", "A"],
      ["B", "X"],
      ["X", "C"],
    ]),
  );
  const { ids } = nodeIndex(base);
  expect(neighboursOf(incidenceOf(base), ids, "X")).toEqual(["A", "B", "C"]);
});

test("direction is a flag on the entry, not a second structure", () => {
  const base = buildBaseGraph(
    docOf([
      ["X", "A"],
      ["B", "X"],
    ]),
  );
  const { ids } = nodeIndex(base);
  const { offsets, neighbor, forward } = incidenceOf(base);
  const v = ids.indexOf("X");
  const out: string[] = [];
  const inn: string[] = [];
  for (let p = offsets[v]; p < offsets[v + 1]; p++) {
    (forward[p] === 1 ? out : inn).push(ids[neighbor[p]]);
  }
  expect(out).toEqual(["A"]);
  expect(inn).toEqual(["B"]);
});

test("a self-loop is two document entries, and no graph entries at all", () => {
  const doc = docOf([
    ["X", "X"],
    ["X", "A"],
  ]);
  // `buildBaseGraph` drops a self-loop row, so the graph's index never sees
  // one: X's only link is the one to A.
  const base = buildBaseGraph(doc);
  const { ids } = nodeIndex(base);
  expect(neighboursOf(incidenceOf(base), ids, "X")).toEqual(["A"]);

  // The document's index is over the rows themselves and keeps it, once from
  // each end, the way anything walking the rows would meet it twice.
  const { index, offsets, neighbor, ids: docIds } = docIncidence(doc);
  const v = index.get("X") as number;
  const out: string[] = [];
  for (let p = offsets[v]; p < offsets[v + 1]; p++) out.push(docIds[neighbor[p]]);
  expect(out).toEqual(["X", "X", "A"]);
});

test("parallel links each keep their own entry", () => {
  const base = buildBaseGraph(
    docOf([
      ["X", "A"],
      ["X", "A"],
    ]),
  );
  const { ids } = nodeIndex(base);
  // The graph merges the pair into one link, so the incidence has one entry
  // per merged link rather than per row.
  expect(base.links).toHaveLength(1);
  expect(neighboursOf(incidenceOf(base), ids, "X")).toEqual(["A"]);
});

test("an index is built once and handed back", () => {
  const base = buildBaseGraph(docOf([["X", "A"]]));
  expect(incidenceOf(base)).toBe(incidenceOf(base));
  expect(nodeIndex(base)).toBe(nodeIndex(base));

  // A different graph is a different index, even over the same document.
  const other = buildBaseGraph(docOf([["X", "A"]]));
  expect(incidenceOf(other)).not.toBe(incidenceOf(base));
});

test("the document index reaches endpoints the node table never declared", () => {
  const nodes: Table = {
    name: "Nodes",
    columns: [{ name: "Id", type: "text" }],
    rows: [{ Id: "X" }],
  };
  const doc = docOf([["X", "stranger"]], nodes);
  // Declared nodes are interned first, in node-table order; an endpoint nobody
  // declared is appended rather than dropped.
  const { ids, index, offsets, neighbor } = docIncidence(doc);
  expect(ids[0]).toBe("X");
  expect(index.has("stranger")).toBe(true);
  const v = index.get("X") as number;
  expect(ids[neighbor[offsets[v]]]).toBe("stranger");
});

test("the document index tracks its rows and its mapping, not just one of them", () => {
  const doc = docOf([
    ["A", "B"],
    ["B", "C"],
  ]);
  const first = docIncidence(doc);
  expect(docIncidence(doc)).toBe(first);

  // Same node table, different edge rows: the incidence must not be reused.
  const edited = { ...doc, edges: { ...doc.edges, rows: [{ Source: "A", Target: "C" }] } };
  expect(docIncidence(edited)).not.toBe(first);

  // Same rows, swapped endpoints: the entries mean the other thing now.
  const swapped = { ...doc, mapping: { ...doc.mapping, source: "Target", target: "Source" } };
  const after = docIncidence(swapped);
  expect(after).not.toBe(first);
  const v = after.index.get("A") as number;
  expect(after.forward[after.offsets[v]]).toBe(0);
});

test("the link column points at the row that made the entry", () => {
  const doc = docOf([
    ["A", "B"],
    ["B", "C"],
    ["C", "A"],
  ]);
  const { index, offsets, neighbor, link, ids } = docIncidence(doc);
  const v = index.get("B") as number;
  const seen: { other: string; row: number }[] = [];
  for (let p = offsets[v]; p < offsets[v + 1]; p++) {
    seen.push({ other: ids[neighbor[p]], row: link[p] });
  }
  expect(seen).toEqual([
    { other: "A", row: 0 },
    { other: "C", row: 1 },
  ]);
});
