import { expect, test } from "vitest";
import { computeBins, numericValues, BIN_COUNT } from "./histogram";

test("an empty column has no bins to draw", () => {
  expect(computeBins([])).toBeNull();
  expect(numericValues([{ a: "word" }, { a: null }], "a")).toEqual([]);
});

test("a single value collapses to one bin holding everything", () => {
  const bins = computeBins([7, 7, 7]);
  expect(bins).toEqual({ counts: [3], min: 7, max: 7, step: 1 });
});

test("counts cover every value and land in order", () => {
  const bins = computeBins([0, 0, 1, 2, 2, 2, 5]);
  expect(bins).not.toBeNull();
  const b = bins as NonNullable<typeof bins>;
  expect(b.counts.reduce((a, c) => a + c, 0)).toBe(7);
  expect(b.min).toBe(0);
  expect(b.max).toBe(5);
  // Integer data: one bin per value, so the shape is exact.
  expect(b.counts).toEqual([2, 1, 3, 0, 0, 1]);
  expect(b.step).toBe(1);
});

test("negative ranges bin from their own floor", () => {
  const bins = computeBins([-10, -5, 0, 5, 10]);
  expect(bins).not.toBeNull();
  const b = bins as NonNullable<typeof bins>;
  expect(b.min).toBe(-10);
  expect(b.max).toBe(10);
  expect(b.counts.reduce((a, c) => a + c, 0)).toBe(5);
  // The maximum lands in the last bin rather than one past it.
  expect(b.counts[b.counts.length - 1]).toBeGreaterThan(0);
});

test("fractional data uses the full bin budget and a fine step", () => {
  const values = Array.from({ length: 200 }, (_, i) => i / 33);
  const bins = computeBins(values);
  expect(bins).not.toBeNull();
  const b = bins as NonNullable<typeof bins>;
  expect(b.counts).toHaveLength(BIN_COUNT);
  expect(b.counts.reduce((a, c) => a + c, 0)).toBe(200);
  expect(b.step).toBeCloseTo((b.max - b.min) / 100, 12);
});

test("numeric strings count, words and blanks do not", () => {
  const rows = [{ v: "3" }, { v: 4 }, { v: "" }, { v: "word" }, { v: null }];
  expect(numericValues(rows, "v")).toEqual([3, 4]);
});
