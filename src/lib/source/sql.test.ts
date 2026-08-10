import { expect, test } from "vitest";
import { selection } from "./contract";
import {
  approxNodeCount,
  binCounts,
  conditionSql,
  countFromTop,
  countNodesFromTop,
  countRowsSelected,
  createView,
  expandHop,
  ident,
  knownIds,
  readerFor,
  searchScan,
  selectRows,
  walkableSql,
} from "./sql";

/**
 * The SQL is generated rather than run here. An engine that only starts inside
 * a browser is awkward to assert against; the statement it would be handed is
 * a string, and the parts worth getting right (quoting, binding, and a LIMIT
 * on anything that returns rows) are all visible in the string.
 */

const ENDS = { table: "Edges", source: "src", target: "dst" };

test("identifiers survive whatever a file called its columns", () => {
  expect(ident("plain")).toBe('"plain"');
  // A column named with a quote is a column a file can hold, and doubling is
  // what keeps it one identifier rather than a syntax error.
  expect(ident('od")); DROP TABLE x; --')).toBe('"od"")); DROP TABLE x; --"');
  expect(ident("a b")).toBe('"a b"');
});

test("a file's reader is chosen by its extension, and its name is bound", () => {
  expect(readerFor("x.parquet")).toBe("read_parquet");
  expect(readerFor("X.PQ")).toBe("read_parquet");
  expect(readerFor("x.ndjson")).toBe("read_json_auto");
  expect(readerFor("x.csv")).toBe("read_csv_auto");
  expect(readerFor("x.tsv")).toBe("read_csv_auto");

  // DDL is the one statement the engine refuses to prepare, so the file name
  // is inlined here and escaped rather than bound.
  const view = createView("Edges", "graph.parquet");
  expect(view.sql).toContain("read_parquet('graph.parquet')");
  expect(view.params).toEqual([]);
  expect(createView("Edges", "it's.csv").sql).toContain("read_csv_auto('it''s.csv')");
});

test("values never reach the statement, only placeholders do", () => {
  const nasty = "o'brien";
  const search = searchScan(ENDS, nasty, 5);
  expect(search.sql).not.toContain(nasty);
  expect(search.params).toEqual([nasty, 5]);

  const known = knownIds(ENDS, ["a", "b", "c"]);
  expect(known.sql).toContain("IN (?, ?, ?)");
  expect(known.sql.trimEnd().endsWith("LIMIT ?")).toBe(true);
  expect(known.params).toEqual(["a", "b", "c", 3]);
});

test("a condition is the same question the filter chain asks", () => {
  const values = conditionSql("line", { kind: "values", selected: ["rail", "bus"] });
  expect(values?.sql).toContain("IN (?, ?)");
  expect(values?.params).toEqual(["rail", "bus"]);

  // An empty exclusion constrains nothing, so it produces no fragment at all.
  expect(conditionSql("line", { kind: "values", excluded: [] })).toBeNull();
  const excluded = conditionSql("line", { kind: "values", excluded: ["bus"] });
  expect(excluded?.sql).toContain("NOT IN (?)");

  // Selecting nothing keeps nothing, which is a condition rather than an absence.
  expect(conditionSql("line", { kind: "values", selected: [] })?.sql).toBe("false");

  // An unbounded range still drops cells that are not numbers, matching what
  // the compiled condition does in memory.
  const open = conditionSql("w", { kind: "range", min: null, max: null });
  expect(open?.sql).toBe('TRY_CAST("w" AS DOUBLE) IS NOT NULL');
  const bounded = conditionSql("w", { kind: "range", min: 3, max: 9 });
  expect(bounded?.params).toEqual([3, 9]);
});

test("the walk fragment folds the constraint and the predicates together", () => {
  expect(walkableSql(selection())).toBeNull();
  const both = walkableSql(
    selection({
      where: { column: "line", values: ["rail"] },
      predicates: [{ column: "w", op: { kind: "range", min: 2, max: null } }],
    }),
  );
  expect(both?.sql).toContain(" AND ");
  expect(both?.params).toEqual(["rail", 2]);
});

test("a hop is a semi-join against the previous depth, and it is bounded", () => {
  const hop = expandHop(selection({ seeds: ["a"], depth: 2 }), 1);
  expect(hop.sql).toContain("UNION ALL");
  expect(hop.sql).toContain("NOT IN (SELECT id FROM");
  // Nothing that returns rows goes out without a ceiling: there is no spill.
  expect(hop.sql.trimEnd().endsWith("LIMIT ?")).toBe(true);
  expect(hop.params.at(-1)).toBe(1000);

  // Direction picks which arm of the union survives.
  const out = expandHop(selection({ seeds: ["a"], direction: "out" }), 1);
  expect(out.sql).not.toContain("UNION ALL");
  const inward = expandHop(selection({ seeds: ["a"], direction: "in" }), 1);
  expect(inward.sql).not.toContain("UNION ALL");
  expect(out.sql).not.toBe(inward.sql);
});

test("a hop binds its parameters in the order the placeholders are written", () => {
  // The depth being inserted is written first, in the SELECT list, ahead of
  // the previous depth the arms match on. Binding them the other way round
  // fails silently in the worst way: every node still arrives, all of them at
  // one depth, and only something reading the depths afterwards can tell.
  const hop = expandHop(selection({ seeds: ["a"], depth: 3 }), 2);
  expect(hop.params).toEqual([2, 1, 1, 1000]);

  const positions = hop.sql.split("?").length - 1;
  expect(positions).toBe(hop.params.length);

  const constrained = expandHop(
    selection({
      seeds: ["a"],
      depth: 2,
      direction: "out",
      where: { column: "line", values: ["rail"] },
    }),
    1,
  );
  expect(constrained.params).toEqual([1, 0, "rail", 1000]);
  expect(constrained.sql.split("?").length - 1).toBe(constrained.params.length);
});

test("the induced subgraph asks membership of both ends", () => {
  const rows = selectRows(selection({ seeds: ["a"], depth: 1 }), 500);
  expect(rows.sql).toContain('CAST("src" AS VARCHAR) IN (SELECT id FROM');
  expect(rows.sql).toContain('CAST("dst" AS VARCHAR) IN (SELECT id FROM');
  expect(rows.sql.trimEnd().endsWith("LIMIT ?")).toBe(true);
  expect(rows.params.at(-1)).toBe(500);
});

test("the induced select drops the walk constraint and keeps the predicates", () => {
  // The constraint said which edges the walk could follow; among reached
  // nodes, edges of other kinds still come back. A pushed predicate is a row
  // filter and holds everywhere.
  const rows = selectRows(
    selection({
      seeds: ["a"],
      where: { column: "line", values: ["rail"] },
      predicates: [{ column: "w", op: { kind: "range", min: 2, max: null } }],
    }),
    500,
  );
  expect(rows.sql).not.toContain('"line"');
  expect(rows.sql).toContain('"w"');
  expect(rows.params).toEqual([2, 500]);

  // Walked-only keeps it: a row the constraint drops was never walked.
  const walked = selectRows(
    selection({
      seeds: ["a"],
      walkedOnly: true,
      where: { column: "line", values: ["rail"] },
    }),
    500,
  );
  expect(walked.sql).toContain('"line"');
  expect(walked.params).toEqual(["rail", 500]);
});

test("walkedOnly joins the depths instead of testing membership", () => {
  const walked = selectRows(selection({ seeds: ["a"], depth: 2, walkedOnly: true }), 500);
  expect(walked.sql).toContain("a.depth + 1 = b.depth");
  expect(walked.sql).toContain("b.depth + 1 = a.depth");
  // Following the arrows means only one of the two directions is a step.
  const outward = selectRows(
    selection({ seeds: ["a"], depth: 2, walkedOnly: true, direction: "out" }),
    500,
  );
  expect(outward.sql).toContain("a.depth + 1 = b.depth");
  expect(outward.sql).not.toContain("b.depth + 1 = a.depth");
});

test("the budget is checked by counting one past it, never by fetching", () => {
  const count = countRowsSelected(selection({ seeds: ["a"], edgeLimit: 200 }));
  expect(count.sql.startsWith("SELECT count(*) AS n FROM (")).toBe(true);
  // One more than the budget answers "does it fit" without counting further.
  expect(count.params.at(-1)).toBe(201);
});

test("reading from the top counts under the same constraint it reads with", () => {
  const constrained = selection({
    seeds: [],
    where: { column: "line", excluded: ["bus"] },
  });
  const count = countFromTop(constrained);
  expect(count.sql.startsWith("SELECT count(*) AS n FROM")).toBe(true);
  expect(count.sql).toContain('"line"');
  expect(count.params).toEqual(["bus"]);

  // The node count is over exactly the rows the budgeted read would return.
  const nodes = countNodesFromTop(constrained, 200);
  expect(nodes.sql).toContain("count(DISTINCT id)");
  expect(nodes.sql).toContain("WHERE id IS NOT NULL");
  expect(nodes.params).toEqual(["bus", 200]);
});

test("node counts are approximate on purpose, over both endpoint columns", () => {
  const count = approxNodeCount(ENDS);
  expect(count.sql).toContain("approx_count_distinct");
  expect(count.sql).toContain('CAST("src" AS VARCHAR)');
  expect(count.sql).toContain('CAST("dst" AS VARCHAR)');
});

test("bins bucket over a range already found, pinning the top", () => {
  const bins = binCounts("Edges", "w", 0, 10, 5);
  expect(bins.params).toEqual([0, 2, 4]);
  expect(bins.sql).toContain("least(");
  expect(bins.sql).toContain("GROUP BY 1 ORDER BY 1");
});
