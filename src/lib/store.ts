import type { CellValue, Column, Row, Table } from "../types";

/**
 * A table's data behind an interface whose unit of polymorphism is the
 * **column**, never the cell.
 *
 * That distinction is the whole design. A virtual `get(row, column)` on the
 * hot path costs a dispatch, a string lookup and a boxed allocation for every
 * cell the app touches, and `applyChain` touches all of them on every
 * keystroke of an edit; it would be a ten-to-a-hundred-times regression
 * dressed as an abstraction. Asking for a column instead means a caller
 * branches once on how that column is stored and then runs a monomorphic loop
 * over a concrete array, which is how Arrow, Arquero and DuckDB's own vectors
 * all work.
 *
 * This step is the **seam only**. Every column comes back as `"cells"`, and
 * the store is backed by exactly the `Row[]` the app has always held, so
 * `row(i)` returns the identical object and nothing observable changes. Row
 * identity is load-bearing across the app (selections are `Set<Row>`, the
 * overlay diffs by reference, `GraphNode.row` points into the table while the
 * simulation mutates the node), and moving that to indices is its own step
 * afterwards. Doing both at once would mean calling an app-wide behavioural
 * change "zero risk" because the representation had not moved yet.
 *
 * What arrives later is the representation: numbers into `Float64Array`,
 * strings dictionary-encoded, bools into bytes, mixed columns staying
 * `"cells"` because a text column holding one stray number has to. Callers
 * written against this interface do not change when that happens.
 *
 * **When to move a consumer onto this, measured rather than assumed.** While
 * the store is rows-backed, `col()` allocates a boxed array and copies every
 * value into it, and that costs *more* than one walk over the rows: hidden
 * classes and inline caches make `row.name` about as fast as an array index.
 * `store.bench.test.ts` holds the numbers. So the rule is:
 *
 * - A column read **once** should stay on the rows. Routing it through here
 *   is a measured pessimization today and buys nothing until 4b.
 * - A column read **repeatedly off a stable array** should move, because the
 *   build is paid once and every read after it is contiguous.
 *
 * Most of the app already sits in the first case, because it caches its
 * answers rather than its inputs: the column statistics, the incidence index
 * and the chain's own memo each compute once and keep the result. That is why
 * this step is the seam and not a sweep. When 4b lands, `col()` stops walking
 * anything at all, the first case disappears, and the rest of the migration
 * becomes free.
 */

export type ColumnData =
  | { kind: "num"; values: Float64Array; nulls?: Uint8Array }
  | { kind: "dict"; codes: Uint32Array; labels: string[] }
  | { kind: "bool"; values: Uint8Array }
  /** Today's data, columnized. Also the permanent home of mixed columns. */
  | { kind: "cells"; values: CellValue[] };

export interface TableStore {
  readonly length: number;
  readonly columns: Column[];
  /** A whole column, for the loops that matter. O(1) after the first ask. */
  col(name: string): ColumnData;
  /** One cell. Cold path: tooltips, the inspector, an edit, the script payload. */
  cell(index: number, name: string): CellValue;
  /** One row. Cold path, and for now the very object the table holds. */
  row(index: number): Row;
  /**
   * Every row, as the app has always seen them.
   *
   * The migration's escape hatch, and honest about being one: while the store
   * is `Row[]`-backed this is free, and it is what lets consumers move one at
   * a time instead of in a single commit. It cannot survive the representation
   * flip, so anything still calling it then is a consumer that never moved.
   */
  rows(): Row[];

  // Copy-on-write. Each returns a new store and leaves this one alone, which
  // is what lets the undo history share everything that did not change.
  withCell(index: number, name: string, value: CellValue): TableStore;
  withColumn(name: string, values: CellValue[], column?: Column): TableStore;
  select(indices: ArrayLike<number>): TableStore;
  append(rows: Row[]): TableStore;
}

/**
 * The `Row[]`-backed store.
 *
 * `col()` walks the rows once per column and keeps the answer, which is the
 * one cost this step adds: a column asked for repeatedly is paid for once, and
 * a column nobody asks for is never built. Cached per store instance rather
 * than per rows array, because a store is immutable and every transform makes
 * a new one, so instance identity *is* the invalidation.
 */
class RowStore implements TableStore {
  readonly columns: Column[];
  private readonly data: Row[];
  private readonly views = new Map<string, ColumnData>();

  constructor(columns: Column[], rows: Row[]) {
    this.columns = columns;
    this.data = rows;
  }

  get length(): number {
    return this.data.length;
  }

  col(name: string): ColumnData {
    const cached = this.views.get(name);
    if (cached !== undefined) return cached;
    const values = new Array<CellValue>(this.data.length);
    for (let i = 0; i < this.data.length; i++) values[i] = this.data[i][name] ?? null;
    const view: ColumnData = { kind: "cells", values };
    this.views.set(name, view);
    return view;
  }

  cell(index: number, name: string): CellValue {
    return this.data[index]?.[name] ?? null;
  }

  row(index: number): Row {
    return this.data[index];
  }

  rows(): Row[] {
    return this.data;
  }

  withCell(index: number, name: string, value: CellValue): TableStore {
    const next = this.data.slice();
    next[index] = { ...next[index], [name]: value };
    return new RowStore(this.columns, next);
  }

  withColumn(name: string, values: CellValue[], column?: Column): TableStore {
    const next = this.data.map((row, i) => ({ ...row, [name]: values[i] ?? null }));
    const existing = this.columns.some((c) => c.name === name);
    const columns = existing
      ? this.columns
      : [...this.columns, column ?? { name, type: "text" as const }];
    return new RowStore(columns, next);
  }

  select(indices: ArrayLike<number>): TableStore {
    const next = new Array<Row>(indices.length);
    for (let i = 0; i < indices.length; i++) next[i] = this.data[indices[i]];
    return new RowStore(this.columns, next);
  }

  append(rows: Row[]): TableStore {
    return new RowStore(this.columns, [...this.data, ...rows]);
  }
}

export function storeFrom(columns: Column[], rows: Row[]): TableStore {
  return new RowStore(columns, rows);
}

/**
 * A table's store, held against the rows it describes.
 *
 * Keyed the way the column statistics are, and for the same reason: every edit
 * builds a new rows array, so a changed table simply misses and nobody has to
 * remember to invalidate anything. This is what lets a consumer ask for a
 * store without the table having to carry one yet.
 */
const stores = new WeakMap<Row[], { columns: Column[]; store: TableStore }>();

const looseStores = new WeakMap<Row[], TableStore>();

/**
 * A store over rows whose schema is not to hand.
 *
 * Plenty of the app holds a bare `Row[]`: the chain's output, the rows
 * entering one step, a filtered view. Reading a column does not need a schema,
 * only a name, so those callers get a store too. What they do not get is the
 * transforms that add a column, which is the half that would need one.
 */
export function storeOfRows(rows: Row[]): TableStore {
  let store = looseStores.get(rows);
  if (store === undefined) {
    store = storeFrom([], rows);
    looseStores.set(rows, store);
  }
  return store;
}

export function storeOf(table: Table): TableStore {
  const cached = stores.get(table.rows);
  // The columns can change without the rows changing: a rename is metadata.
  if (cached !== undefined && cached.columns === table.columns) return cached.store;
  const store = storeFrom(table.columns, table.rows);
  stores.set(table.rows, { columns: table.columns, store });
  return store;
}

/** A store back as an ordinary table, for everything not yet migrated. */
export function toTable(name: string, store: TableStore): Table {
  return { name, columns: store.columns, rows: store.rows() };
}
