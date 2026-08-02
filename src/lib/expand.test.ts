import { expect, test } from "vitest";
import type { GraphDoc, Row, Table } from "../types";
import { buildDoc } from "./doc";
import { expansionPreview } from "./expand";

/** A typed supply web: the centre orders from suppliers and ships to depots. */
function typedDoc(): GraphDoc {
  const rows: Row[] = [
    { From: "hub", To: "s1", Line: "orders" },
    { From: "hub", To: "s2", Line: "orders" },
    { From: "d1", To: "hub", Line: "ships" },
    { From: "hub", To: "d2", Line: "ships" },
    // Already-visible neighbour, and an edge that misses the centre entirely.
    { From: "hub", To: "seen", Line: "orders" },
    { From: "s1", To: "s2", Line: "orders" },
  ];
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "From", type: "text" },
      { name: "To", type: "text" },
      { name: "Line", type: "text" },
    ],
    rows,
  };
  const nodes: Table = {
    name: "Nodes",
    columns: [
      { name: "Id", type: "text" },
      { name: "Kind", type: "text" },
    ],
    rows: [
      { Id: "hub", Kind: "hub" },
      { Id: "s1", Kind: "supplier" },
      { Id: "s2", Kind: "supplier" },
      { Id: "d1", Kind: "depot" },
      { Id: "d2", Kind: "depot" },
      { Id: "seen", Kind: "depot" },
    ],
  };
  return buildDoc("supply", edges, {
    nodes,
    mapping: { source: "From", target: "To", attrs: ["Line"] },
  });
}

test("the preview counts only what is not on screen yet, by both kinds", () => {
  const doc = typedDoc();
  const visible = new Set(["hub", "seen"]);
  const preview = expansionPreview(doc, visible, "hub", "Kind", "Line");

  expect(preview.total).toBe(4);
  expect(preview.byNodeType).toEqual([
    { kind: "depot", count: 2 },
    { kind: "supplier", count: 2 },
  ]);
  // Edge counts, so a node reachable along two lines shows up under both.
  expect(preview.byEdgeType).toEqual([
    { kind: "orders", count: 2 },
    { kind: "ships", count: 2 },
  ]);
});

test("direction never gates the preview, and self-rows never count", () => {
  const doc = typedDoc();
  // d1 points at the hub rather than the other way round; it still arrives.
  const preview = expansionPreview(doc, new Set(["hub"]), "hub", null, null);
  expect(preview.total).toBe(5);
  expect(preview.byNodeType).toEqual([]);
  expect(preview.byEdgeType).toEqual([]);
});

test("without a node table column the type comes off the edge row", () => {
  const rows: Row[] = [
    { From: "hub", To: "a", Line: "orders" },
    { From: "hub", To: "b", Line: "ships" },
  ];
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "From", type: "text" },
      { name: "To", type: "text" },
      { name: "Line", type: "text" },
    ],
    rows,
  };
  const doc = buildDoc("bare", edges, {
    mapping: { source: "From", target: "To", attrs: ["Line"] },
  });
  const preview = expansionPreview(doc, new Set(["hub"]), "hub", "Line", null);
  expect(preview.byNodeType).toEqual([
    { kind: "orders", count: 1 },
    { kind: "ships", count: 1 },
  ]);
});

test("a fully expanded neighbourhood previews as nothing new", () => {
  const doc = typedDoc();
  const everyone = new Set(["hub", "s1", "s2", "d1", "d2", "seen"]);
  const preview = expansionPreview(doc, everyone, "hub", "Kind", "Line");
  expect(preview.total).toBe(0);
  expect(preview.byNodeType).toEqual([]);
  expect(preview.byEdgeType).toEqual([]);
});
