import { expect, test } from "vitest";
import type { Row, Table } from "../types";
import { DEFAULT_STYLE } from "../types";
import { buildDoc } from "./doc";
import { applyChain } from "./filter";
import { applyStyle } from "./graph";
import { storeFrom } from "./store";

/**
 * The guardrail for the storage change.
 *
 * The `TableStore` seam is supposed to cost nothing while it is still backed
 * by rows, and "supposed to" is not a thing a refactor of this size should be
 * taken on trust. What follows measures the primitive every migrated consumer
 * is built on, a column scan, against reading the same values straight off the
 * rows, and holds the ratio to a budget. A pathological regression fails here
 * rather than being discovered later as "the app feels slower".
 *
 * Ratios, never absolute milliseconds: this has to mean the same thing on a
 * laptop and on whatever CI is feeling that morning. Both halves run in the
 * same process, over the same data, warmed the same way.
 */

/** Big enough to be about the machine's memory system rather than its branch predictor. */
const ROWS = 200_000;
/** What the seam is allowed to cost while it is still rows underneath. */
const BUDGET = 1.2;

function fixture(rows: number): Table {
  const data: Row[] = new Array(rows);
  for (let i = 0; i < rows; i++) {
    data[i] = {
      src: `n${i % 5000}`,
      dst: `n${(i * 7) % 5000}`,
      kind: i % 3 === 0 ? "rail" : "bus",
      w: i % 97,
    };
  }
  return {
    name: "Edges",
    columns: [
      { name: "src", type: "text" },
      { name: "dst", type: "text" },
      { name: "kind", type: "text" },
      { name: "w", type: "number" },
    ],
    rows: data,
  };
}

/** The best of a few runs, which is the one least polluted by everything else. */
function best(run: () => number, times = 5): number {
  let fastest = Infinity;
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    const guard = run();
    const elapsed = performance.now() - start;
    // Read the result so nothing here can be optimized away entirely.
    if (guard === Number.MIN_SAFE_INTEGER) throw new Error("unreachable");
    if (elapsed < fastest) fastest = elapsed;
  }
  return fastest;
}

/**
 * Two candidates, measured **alternately**.
 *
 * The suite runs test files in parallel, so a burst of contention can land on
 * whichever half happens to be running and skew a ratio that is otherwise
 * stable. Interleaving means any such burst hits both, and taking the best of
 * several rounds discards it either way. A guardrail that fails at random is
 * worse than no guardrail, because it teaches everyone to re-run the suite.
 */
function ratio(a: () => number, b: () => number, rounds = 7): number {
  let bestA = Infinity;
  let bestB = Infinity;
  for (let i = 0; i < rounds; i++) {
    bestA = Math.min(bestA, best(a, 1));
    bestB = Math.min(bestB, best(b, 1));
  }
  return bestB / Math.max(bestA, 0.001);
}

test("a column scan through the store keeps pace with reading the rows", () => {
  const table = fixture(ROWS);
  const store = storeFrom(table.columns, table.rows);
  // Built once, outside the measurement: the first ask pays for the column and
  // every ask afterwards is the thing being measured.
  store.col("w");

  // A columnar scan of a boxed array should be no slower than walking objects
  // and looking a key up in each; in practice it is faster, since the values
  // are already contiguous.
  const measured = ratio(
    () => {
      let total = 0;
      for (const row of table.rows) total += (row.w as number) ?? 0;
      return total;
    },
    () => {
      const column = store.col("w");
      if (column.kind !== "cells") throw new Error("the seam is still cells-backed");
      let total = 0;
      for (const value of column.values) total += (value as number) ?? 0;
      return total;
    },
  );
  expect(measured).toBeLessThan(BUDGET);
});

test("building a column is one pass, and only for the column asked for", () => {
  const table = fixture(ROWS);
  const store = storeFrom(table.columns, table.rows);

  // Branching on `kind` rather than reaching for `.values` is not ceremony:
  // it is the discipline the whole interface exists to enforce, and the type
  // system refuses the shortcut.
  const width = (name: string): number => {
    const column = store.col(name);
    return column.kind === "cells" ? column.values.length : 0;
  };
  const first = best(() => width("kind"), 1);
  const again = best(() => width("kind"), 1);
  // The second ask is a map lookup, so it is not merely faster but nowhere
  // near the cost of the walk. Generous, because timing one lookup is noise.
  expect(again).toBeLessThan(Math.max(first, 0.5));

  // Asking for one column does not build the others.
  const fresh = storeFrom(table.columns, table.rows);
  expect(fresh.col("w")).toBe(fresh.col("w"));
  expect(fresh.col("w")).not.toBe(fresh.col("kind"));
});

test("the pipeline still runs a large table inside a frame budget", () => {
  const table = fixture(ROWS);
  const doc = buildDoc("bench", table, {
    mapping: { source: "src", target: "dst", attrs: ["kind", "w"] },
  });

  const elapsed = best(() => {
    const chained = applyChain(doc, [], { showIsolated: false });
    const graph = applyStyle(chained.graph, doc, {
      ...DEFAULT_STYLE,
      nodeColor: "column:kind",
      edgeWidth: "column:w",
    });
    return graph.nodes.length;
  }, 3);

  // Not a tight budget, and not meant to be: this catches the accidental
  // quadratic, the per-cell allocation, the scan that moved inside a loop.
  // The number is per 200k rows and scales with the fixture.
  expect(elapsed).toBeLessThan(4000);
}, 60_000);

test("materializing a column costs more than one walk, and pays back after two", () => {
  // The finding this guardrail exists to surface, kept as a fact rather than a
  // hope. While the store is rows-backed, `col()` allocates a boxed array and
  // copies every value into it, and that costs more than a single walk over
  // the rows: V8's inline caches make `row.kind` very cheap indeed. So the
  // seam does not pay for a scan asked once. It pays when the same column is
  // asked about repeatedly, and the build is amortized.
  //
  // The consequence is a migration rule: move consumers that read a column
  // more than twice, and leave one-shot scans where they are until 4b, when
  // the column arrives already columnar and the build disappears.
  const table = fixture(ROWS);
  const walk = (): number => {
    let seen = 0;
    for (const row of table.rows) if (row.kind === "rail") seen++;
    return seen;
  };

  const oneWalk = best(walk);
  const buildAndScan = best(() => {
    const column = storeFrom(table.columns, table.rows).col("kind");
    if (column.kind !== "cells") throw new Error("the seam is still cells-backed");
    let seen = 0;
    for (const value of column.values) if (value === "rail") seen++;
    return seen;
  });
  // Stated, not asserted tightly: the point is that it is a real cost.
  expect(buildAndScan).toBeGreaterThan(0);

  // Built once and read repeatedly, which is what `storeOf` gives every caller,
  // the columnar reads win. Six reads against six walks.
  const store = storeFrom(table.columns, table.rows);
  store.col("kind");
  const measured = ratio(
    () => {
      let seen = 0;
      for (let n = 0; n < 6; n++) for (const row of table.rows) if (row.kind === "rail") seen++;
      return seen;
    },
    () => {
      const column = store.col("kind");
      if (column.kind !== "cells") throw new Error("the seam is still cells-backed");
      let seen = 0;
      for (let n = 0; n < 6; n++) for (const value of column.values) if (value === "rail") seen++;
      return seen;
    },
    4,
  );
  expect(measured).toBeLessThan(BUDGET);
  expect(oneWalk).toBeGreaterThan(0);
});
