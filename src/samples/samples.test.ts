import { expect, test } from "vitest";
import { SAMPLES } from ".";
import { buildDoc, nodeStyleColumns } from "../lib/doc";
import { buildBaseGraph, applyStyle } from "../lib/graph";
import { guessStyle } from "../lib/parse";
import { isCellStyle, styleColumn, DEFAULT_STYLE } from "../types";
import { cellKey } from "../lib/cells";
import { NEUTRAL } from "../theme";

test("sample ids are unique", () => {
  const ids = SAMPLES.map((s) => s.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test.each(SAMPLES.map((s) => [s.id, s] as const))("%s loads into a graph", (_id, network) => {
  const edges = network.dataset.tables[0];
  const nodes =
    network.nodeTable === undefined ? undefined : network.dataset.tables[network.nodeTable];
  const doc = buildDoc(network.dataset.fileName, edges, { nodes });
  const style = { ...guessStyle(edges, doc.mapping), ...network.style };
  const graph = applyStyle(buildBaseGraph(doc, { showIsolated: true }), doc, style);

  // Nothing dropped for a missing endpoint or a self-loop, and every node
  // is attached: the samples are meant to be clean.
  expect(graph.skippedRows).toBe(0);
  expect(graph.nodes.length).toBe(network.nodeCount);
  expect(graph.links.length).toBeGreaterThan(0);
  expect(graph.nodes.every((n) => n.degree > 0)).toBe(true);

  // A style patch that named a column the document does not have would load
  // looking like the default instead of failing, so check the names here.
  const styleColumns = nodeStyleColumns(doc).map((c) => c.name);
  for (const token of Object.values(network.style ?? {})) {
    const column = typeof token === "string" ? styleColumn(token) : null;
    if (column !== null) expect(styleColumns).toContain(column);
  }

  // Hover details are chosen by name too, and a typo would silently vanish.
  const nodeColumns = doc.nodes.columns.map((c) => c.name);
  for (const attr of network.nodeAttrs ?? []) {
    expect(nodeColumns).toContain(attr);
  }

  // Per-type overrides name a column and its values; both must exist, or the
  // override would load as a no-op instead of failing.
  const typeStyles = network.style?.typeStyles;
  if (typeStyles) {
    expect(styleColumns).toContain(typeStyles.column);
    const values = new Set(doc.nodes.rows.map((r) => cellKey(r[typeStyles.column])));
    for (const key of Object.keys(typeStyles.styles)) {
      expect(values).toContain(key);
    }
  }
  const edgeTypeStyles = network.style?.edgeTypeStyles;
  if (edgeTypeStyles) {
    expect(doc.edges.columns.map((c) => c.name)).toContain(edgeTypeStyles.column);
    const values = new Set(doc.edges.rows.map((r) => cellKey(r[edgeTypeStyles.column])));
    for (const key of Object.keys(edgeTypeStyles.styles)) {
      expect(values).toContain(key);
    }
  }

  // A cell column paints the marks itself, so there is nothing to group; what
  // matters instead is that every cell read as a colour, since one that didn't
  // would quietly come out neutral.
  if (isCellStyle(style.nodeColor)) {
    expect(graph.groups).toEqual([]);
    expect(graph.nodes.every((n) => n.color !== null && n.color !== NEUTRAL)).toBe(true);
  } else if (styleColumn(style.nodeColor) !== null) {
    // Grouping and ranking only mean something if the column separates nodes.
    expect(graph.groups.length).toBeGreaterThan(1);
  }
  if (isCellStyle(style.edgeColor)) {
    expect(graph.edgeGroups).toEqual([]);
    expect(graph.links.every((l) => l.color !== null)).toBe(true);
  } else if (styleColumn(style.edgeColor) !== null) {
    expect(graph.edgeGroups.length).toBeGreaterThan(1);
  }
});

test.each(SAMPLES.filter((s) => s.nodeTable !== undefined).map((s) => [s.id, s] as const))(
  "%s node table names exactly the nodes its edges name",
  (_id, network) => {
    const edges = network.dataset.tables[0];
    const nodes = network.dataset.tables[network.nodeTable as number];
    const doc = buildDoc(network.dataset.fileName, edges, { nodes });

    const declared = nodes.rows.map((r) => cellKey(r[doc.nodeIdColumn]));
    expect(new Set(declared).size).toBe(declared.length);

    const endpoints = new Set<string>();
    for (const row of edges.rows) {
      endpoints.add(cellKey(row[doc.mapping.source]));
      endpoints.add(cellKey(row[doc.mapping.target]));
    }
    // reconcileNodes silently adds a row for any endpoint the node table
    // misses, so a typo on either side shows up as a mismatch here.
    expect([...endpoints].sort()).toEqual([...declared].sort());
  },
);

test("the citation network is generated the same way every time", () => {
  const citations = SAMPLES.find((s) => s.id === "citations");
  const edges = citations?.dataset.tables[0];
  expect(edges?.rows.length).toMatchSnapshot();
  expect(edges?.rows.slice(0, 5)).toMatchSnapshot();
});

test("the social network is generated the same way every time", () => {
  const social = SAMPLES.find((s) => s.id === "social");
  const edges = social?.dataset.tables[0];
  expect(edges?.rows.length).toMatchSnapshot();
  expect(edges?.rows.slice(0, 5)).toMatchSnapshot();
});

test("every sample survives the default style", () => {
  for (const network of SAMPLES) {
    const doc = buildDoc(network.dataset.fileName, network.dataset.tables[0]);
    expect(() => applyStyle(buildBaseGraph(doc), doc, DEFAULT_STYLE)).not.toThrow();
  }
});
