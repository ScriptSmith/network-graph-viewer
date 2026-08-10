import { expect, test } from "vitest";
import type { Row } from "../types";
import { distinctValues } from "./graph";
import { distinctsOf, groupable, numericBinsOf, rangeOf, timeBinsOf } from "./stats";

const rows: Row[] = [
  { team: "red", n: 1, t: "2020-01-01" },
  { team: "red", n: 5, t: "2021-06-01" },
  { team: "blue", n: null, t: null },
  { team: null, n: 3, t: "2022-03-01" },
];

test("a column is read once per version of a table", () => {
  const first = distinctsOf(rows, "team");
  expect(first).toEqual(distinctValues(rows, "team"));
  // The same array back, not an equal one: the whole point is that the second
  // caller does not walk the rows again.
  expect(distinctsOf(rows, "team")).toBe(first);
  expect(distinctsOf(rows, "n")).not.toBe(first);

  // An edit replaces the array, which is what makes invalidation something
  // nobody has to remember.
  const edited = rows.map((r) => ({ ...r }));
  expect(distinctsOf(edited, "team")).not.toBe(first);
  expect(distinctsOf(edited, "team")).toEqual(first);
});

test("null is an answer, not a cache miss", () => {
  const text = rangeOf(rows, "team");
  expect(text).toBeNull();
  expect(rangeOf(rows, "team")).toBeNull();
  expect(rangeOf(rows, "n")).toEqual({ min: 1, max: 5 });

  const bins = numericBinsOf(rows, "n");
  expect(bins).not.toBeNull();
  expect(numericBinsOf(rows, "n")).toBe(bins);
  expect(timeBinsOf(rows, "t")).not.toBeNull();
  expect(numericBinsOf(rows, "team")).toBeNull();
});

test("groupable answers what the distinct list would, from either path", () => {
  const check = (column: string, limit: number) =>
    expect(groupable(rows, column, limit)).toBe(distinctsOf(rows, column).length <= limit);

  // Cold, so it takes the counting path and can exit early.
  const cold: Row[] = rows.map((r) => ({ ...r }));
  expect(groupable(cold, "team", 2)).toBe(false);
  expect(groupable(cold, "team", 3)).toBe(true);

  // Warm, so it reads the list it already has. Same answers.
  check("team", 2);
  check("team", 3);
  check("n", 1);
  check("n", 10);
});

test("a high-cardinality column is refused without interning every value", () => {
  const many: Row[] = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}` }));
  expect(groupable(many, "id", 40)).toBe(false);
  // Nothing was cached by the refusal, so the list is still there to be built
  // if something genuinely wants it.
  expect(distinctsOf(many, "id")).toHaveLength(5000);
});
