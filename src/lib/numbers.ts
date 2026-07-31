/**
 * Aggregates over arrays the data sizes.
 *
 * `Math.max(...values)` passes every element as a separate argument, and an
 * argument list has a ceiling: past roughly 125,000 the engine throws
 * `RangeError: Maximum call stack size exceeded`. A node array, a link array
 * and a column of cells all go past that long before anything else here gives
 * out, and `PARQUET_ROW_LIMIT` alone allows 200,000 rows, so the spread is not
 * a shortcut that gets slow, it is one that stops working.
 *
 * Anything counted per node, per link or per row aggregates through here.
 */

/** Largest value, or `seed` when there are none. */
export function maxOf(values: ArrayLike<number>, seed = -Infinity): number {
  let max = seed;
  for (let i = 0; i < values.length; i++) {
    if (values[i] > max) max = values[i];
  }
  return max;
}

/** Smallest value, or `seed` when there are none. */
export function minOf(values: ArrayLike<number>, seed = Infinity): number {
  let min = seed;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < min) min = values[i];
  }
  return min;
}

/** Both ends in one pass, or null when there is nothing to take them from. */
export function extentOf(values: ArrayLike<number>): { min: number; max: number } | null {
  if (values.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}
