import type { Row } from "../types";
import { cellKey } from "./cells";
import { columnRange, distinctValues } from "./graph";
import { computeBins, numericValues, type Bins } from "./histogram";
import { timeValues } from "./timeline";

/**
 * What a column looks like, worked out once per column per version of a table.
 *
 * Every one of these answers costs a full pass over the rows, and the UI asks
 * for them constantly: a popover opening, a legend rendering, the statistics
 * panel deciding which columns are groupable (which asks per column, so the
 * uncached shape was rows x columns to draw one panel). None of it is on the
 * `applyChain` render path, but all of it is on the path between a click and
 * something appearing.
 *
 * The cache is keyed on the rows array's identity, which is what makes
 * invalidation something nobody has to remember: every edit builds a new array
 * (that is what the copy-on-write transforms in edit.ts and bulk.ts do), so a
 * changed table simply misses. A `WeakMap` means the entries for a table go
 * when the table does, including the undo history's old generations.
 *
 * Nothing here changes an answer. These are the same functions from graph.ts
 * and histogram.ts, asked at most once.
 */

interface ColumnStats {
  distincts?: { key: string; count: number }[];
  range?: { min: number; max: number } | null;
  numericBins?: Bins | null;
  timeBins?: Bins | null;
}

const tables = new WeakMap<Row[], Map<string, ColumnStats>>();

function statsFor(rows: Row[], column: string): ColumnStats {
  let columns = tables.get(rows);
  if (!columns) {
    columns = new Map();
    tables.set(rows, columns);
  }
  let stats = columns.get(column);
  if (!stats) {
    stats = {};
    columns.set(column, stats);
  }
  return stats;
}

/** Distinct values of a column with row counts, most frequent first. */
export function distinctsOf(rows: Row[], column: string): { key: string; count: number }[] {
  const stats = statsFor(rows, column);
  stats.distincts ??= distinctValues(rows, column);
  return stats.distincts;
}

/** Range of a numeric column, ignoring non-numeric cells. */
export function rangeOf(rows: Row[], column: string): { min: number; max: number } | null {
  const stats = statsFor(rows, column);
  // Written rather than `??=`: null is an answer here, not a miss.
  if (!("range" in stats)) stats.range = columnRange(rows, column);
  return stats.range ?? null;
}

/** Histogram bins over a column read as numbers. */
export function numericBinsOf(rows: Row[], column: string): Bins | null {
  const stats = statsFor(rows, column);
  if (!("numericBins" in stats)) stats.numericBins = computeBins(numericValues(rows, column));
  return stats.numericBins ?? null;
}

/** Histogram bins over a column read as a time axis. */
export function timeBinsOf(rows: Row[], column: string): Bins | null {
  const stats = statsFor(rows, column);
  if (!("timeBins" in stats)) stats.timeBins = computeBins(timeValues(rows, column));
  return stats.timeBins ?? null;
}

/**
 * Whether a column has few enough distinct values to group by, without
 * building the list when the answer is already no. The statistics panel asks
 * this of every column, and a high-cardinality one would otherwise intern a
 * string per row to be told it is unusable.
 */
export function groupable(rows: Row[], column: string, limit: number): boolean {
  const stats = statsFor(rows, column);
  if (stats.distincts !== undefined) return stats.distincts.length <= limit;
  // Counted the way `distinctValues` counts, or the early exit would answer
  // about a different set than the cached path does.
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(cellKey(row[column]));
    if (seen.size > limit) return false;
  }
  return true;
}
