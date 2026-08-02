import { expect, test } from "vitest";
import type { GraphDoc, Row, Table } from "../types";
import { buildDoc } from "./doc";
import { projectBipartite, projectionPairBound } from "./project";

/** Dishes naming their ingredients, with attributes on the dish nodes. */
function kitchenDoc(): GraphDoc {
  const rows: Row[] = [
    { Dish: "soup", Ingredient: "onion" },
    { Dish: "soup", Ingredient: "stock" },
    { Dish: "stew", Ingredient: "onion" },
    { Dish: "stew", Ingredient: "stock" },
    { Dish: "stew", Ingredient: "beef" },
    { Dish: "salad", Ingredient: "onion" },
  ];
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "Dish", type: "text" },
      { name: "Ingredient", type: "text" },
    ],
    rows,
  };
  const nodes: Table = {
    name: "Nodes",
    columns: [
      { name: "Id", type: "text" },
      { name: "Course", type: "text" },
    ],
    rows: [
      { Id: "soup", Course: "starter" },
      { Id: "stew", Course: "main" },
      { Id: "salad", Course: "side" },
      { Id: "onion", Course: "" },
      { Id: "stock", Course: "" },
      { Id: "beef", Course: "" },
    ],
  };
  return buildDoc("kitchen", edges, {
    nodes,
    mapping: { source: "Dish", target: "Ingredient", attrs: [] },
  });
}

const linkSet = (doc: GraphDoc) =>
  Object.fromEntries(
    doc.edges.rows.map((r) => [`${String(r.Source)}~${String(r.Target)}`, r["Shared count"]]),
  );

test("projection onto sources links dishes by shared ingredients, weighted exactly", () => {
  const { doc, report } = projectBipartite(kitchenDoc(), "source");

  // soup-stew share onion and stock; salad shares only onion with each.
  expect(linkSet(doc)).toEqual({
    "soup~stew": 2,
    "soup~salad": 1,
    "stew~salad": 1,
  });
  expect(report.edges).toBe(3);
  expect(report.nodes).toBe(3);
  expect(report.counterparts).toEqual({ used: 3, total: 3 });

  // Kept-side attributes survive; the other side's rows are gone.
  expect(doc.nodes.rows.map((r) => r.Id).sort()).toEqual(["salad", "soup", "stew"]);
  expect(doc.nodes.rows.find((r) => r.Id === "stew")?.Course).toBe("main");
  expect(doc.mapping).toEqual({ source: "Source", target: "Target", attrs: ["Shared count"] });
  expect(doc.nodesDeclared).toBe(true);
});

test("projection onto targets links ingredients by shared dishes", () => {
  const { doc } = projectBipartite(kitchenDoc(), "target");
  expect(linkSet(doc)).toEqual({
    "onion~stock": 2,
    "onion~beef": 1,
    "stock~beef": 1,
  });
});

test("the transform is pure: the original document is untouched", () => {
  const original = kitchenDoc();
  const before = JSON.stringify(original);
  projectBipartite(original, "source");
  expect(JSON.stringify(original)).toBe(before);
});

test("duplicate edge rows do not inflate the shared count", () => {
  const base = kitchenDoc();
  const doubled: GraphDoc = {
    ...base,
    edges: { ...base.edges, rows: [...base.edges.rows, ...base.edges.rows] },
  };
  expect(linkSet(projectBipartite(doubled, "source").doc)["soup~stew"]).toBe(2);
});

test("the pair bound counts what a hub would generate", () => {
  // One ingredient in ten dishes: 45 pairs from it alone.
  const rows: Row[] = Array.from({ length: 10 }, (_, i) => ({
    Dish: `d${i}`,
    Ingredient: "salt",
  }));
  const edges: Table = {
    name: "Edges",
    columns: [
      { name: "Dish", type: "text" },
      { name: "Ingredient", type: "text" },
    ],
    rows,
  };
  const doc = buildDoc("salty", edges, {
    mapping: { source: "Dish", target: "Ingredient", attrs: [] },
  });
  expect(projectionPairBound(doc, "source")).toBe(45);
});

test("past the cap the projection stops at a counterpart boundary and says so", () => {
  const doc = kitchenDoc();
  // Budget of 3 pairs: onion (3 dishes -> 3 pairs) fits, stock does not.
  const { doc: projected, report } = projectBipartite(doc, "source", 3);
  expect(report.counterparts.used).toBeLessThan(report.counterparts.total);
  // Every written weight is exact for the counterparts that were folded in.
  expect(linkSet(projected)).toEqual({
    "soup~stew": 1,
    "soup~salad": 1,
    "stew~salad": 1,
  });
});
