import { expect, test } from "vitest";
import type { Table } from "../../types";
import { edgeKey } from "../cells";
import { buildDoc } from "../doc";
import { buildBaseGraph } from "../graph";
import { interpretResult, normalizeEdgeKeys, toScriptGraph } from "./payload";

const table: Table = {
  name: "Edges",
  columns: [
    { name: "Source", type: "text" },
    { name: "Target", type: "text" },
    { name: "Weight", type: "number" },
  ],
  rows: [
    { Source: "A", Target: "B", Weight: 3 },
    { Source: "B", Target: "C", Weight: 1 },
  ],
};
const doc = buildDoc("test", table, {
  mapping: { source: "Source", target: "Target", attrs: ["Weight"] },
});

test("the script payload carries ids, degrees, attributes and neighbours", () => {
  const payload = toScriptGraph(buildBaseGraph(doc), doc);
  expect(payload.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "C"]);
  expect(payload.nodes.find((n) => n.id === "B")?.degree).toBe(2);
  expect(payload.neighbors.B.sort()).toEqual(["A", "C"]);
  expect(payload.edges[0]).toMatchObject({ source: "A", target: "B", Weight: 3 });
  // Structural columns are already the source/target fields, not attributes.
  expect(payload.edges[0]).not.toHaveProperty("Source");
});

test("a metric result must be an object of scalars", () => {
  expect(interpretResult("node", { A: 1, B: "x", C: null }).values).toEqual({
    A: 1,
    B: "x",
    C: null,
  });
  expect(() => interpretResult("node", [1, 2])).toThrow(/must return an object/);
  expect(() => interpretResult("node", null)).toThrow(/must return an object/);
  expect(() => interpretResult("node", {})).toThrow(/empty object/);
  expect(() => interpretResult("node", { A: { nested: true } })).toThrow(/must be a number/);
});

test("a layout result must be an object of finite points", () => {
  expect(interpretResult("layout", { A: { x: 1, y: 2 } }).positions).toEqual({
    A: { x: 1, y: 2 },
  });
  expect(() => interpretResult("layout", { A: { x: 1 } })).toThrow(/numeric x and y/);
  expect(() => interpretResult("layout", { A: { x: NaN, y: 0 } })).toThrow(/numeric x and y/);
  expect(() => interpretResult("layout", { A: 5 })).toThrow(/numeric x and y/);
});

test("edge scripts may key results with the friendlier arrow form", () => {
  expect(normalizeEdgeKeys({ "A->B": 2 })).toEqual({ [edgeKey("A", "B")]: 2 });
  // Ids containing an arrow still resolve, since only the first one splits.
  expect(normalizeEdgeKeys({ "A->B->C": 1 })).toEqual({ [edgeKey("A", "B->C")]: 1 });
  // Anything without an arrow is assumed to already be an internal key.
  expect(normalizeEdgeKeys({ plain: 3 })).toEqual({ plain: 3 });
});
