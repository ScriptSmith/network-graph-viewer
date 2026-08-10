import { expect, test } from "vitest";
import type { Row, Table } from "../types";
import { storeFrom, storeOf, toTable, type TableStore } from "./store";

/** A column's values, having branched on how it is stored exactly once. */
function cellsOf(store: TableStore, name: string) {
  const column = store.col(name);
  if (column.kind !== "cells") throw new Error(`${name} is ${column.kind}, not cells`);
  return column.values;
}

const rows: Row[] = [
  { id: "a", n: 1, ok: true },
  { id: "b", n: null, ok: false },
  { id: "c", n: 3, ok: true },
];

const table: Table = {
  name: "T",
  columns: [
    { name: "id", type: "text" },
    { name: "n", type: "number" },
    { name: "ok", type: "bool" },
  ],
  rows,
};

test("a column comes back whole, and the same one every time", () => {
  const store = storeFrom(table.columns, rows);
  const column = store.col("n");
  expect(column.kind).toBe("cells");
  expect(cellsOf(store, "n")).toEqual([1, null, 3]);
  // Built once and kept: the second ask must not walk the rows again.
  expect(store.col("n")).toBe(column);

  // A column nothing ever declared reads as absent rather than throwing: the
  // node table is reconciled separately and can lag the edge rows.
  expect(cellsOf(store, "nope")).toEqual([null, null, null]);
});

test("row identity is the table's own, which is what this step promises", () => {
  const store = storeFrom(table.columns, rows);
  // The whole point of the seam being rows-backed: everything that keys on a
  // row object keeps working while consumers migrate one at a time.
  expect(store.row(0)).toBe(rows[0]);
  expect(store.rows()).toBe(rows);
  expect(store.length).toBe(3);
  expect(store.cell(1, "id")).toBe("b");
  expect(store.cell(1, "n")).toBeNull();
  // Off the end is nothing, not a crash.
  expect(store.cell(99, "id")).toBeNull();
});

test("transforms copy on write and leave the original alone", () => {
  const store = storeFrom(table.columns, rows);
  const edited = store.withCell(0, "n", 42);
  expect(edited.cell(0, "n")).toBe(42);
  expect(store.cell(0, "n")).toBe(1);
  // Untouched rows are shared, which is what lets the undo history hold many
  // generations of a large table without holding many copies of it.
  expect(edited.row(1)).toBe(rows[1]);
  expect(edited.row(0)).not.toBe(rows[0]);

  const withNew = store.withColumn("extra", ["x", "y", "z"]);
  expect(withNew.columns.map((c) => c.name)).toEqual(["id", "n", "ok", "extra"]);
  expect(withNew.cell(2, "extra")).toBe("z");
  expect(store.columns).toHaveLength(3);

  // Writing a column that already exists replaces values without adding a
  // second declaration of it.
  const rewritten = store.withColumn("n", [9, 9, 9]);
  expect(rewritten.columns).toHaveLength(3);
  expect(cellsOf(rewritten, "n")).toEqual([9, 9, 9]);

  const picked = store.select([2, 0]);
  expect(picked.length).toBe(2);
  expect(picked.row(0)).toBe(rows[2]);
  expect(picked.row(1)).toBe(rows[0]);

  const grown = store.append([{ id: "d", n: 4, ok: false }]);
  expect(grown.length).toBe(4);
  expect(grown.cell(3, "id")).toBe("d");
  expect(store.length).toBe(3);
});

test("a table's store is held against its rows and its columns", () => {
  const first = storeOf(table);
  expect(storeOf(table)).toBe(first);

  // An edit replaces the rows array, so a changed table simply misses.
  const edited: Table = { ...table, rows: rows.map((r) => ({ ...r })) };
  expect(storeOf(edited)).not.toBe(first);

  // A rename changes the columns without changing the rows, and the store has
  // to notice: it carries the schema too.
  const renamed: Table = { ...table, columns: [...table.columns] };
  expect(storeOf(renamed)).not.toBe(first);

  expect(toTable("T", first).rows).toBe(rows);
});
