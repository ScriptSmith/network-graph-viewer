import type { Row } from "../types";
import { asNumber } from "./parse";
import { extentOf } from "./numbers";

/**
 * Binning for the little histograms behind range brackets: a filter step's
 * editor and the timeline both draw one. Pure so it can be tested, and cheap
 * enough to run when an editor opens, which is the only time it runs; nothing
 * here belongs in the render path of `applyChain`.
 */

export interface Bins {
  counts: number[];
  min: number;
  max: number;
  /** Increment for the brackets: 1 on integer data, else a fine slice. */
  step: number;
}

export const BIN_COUNT = 24;

/** The numeric cells of one column, in row order, non-numbers dropped. */
export function numericValues(rows: Row[], column: string): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const v = asNumber(row[column]);
    if (v !== null) out.push(v);
  }
  return out;
}

export function computeBins(values: ArrayLike<number>, binCount = BIN_COUNT): Bins | null {
  const extent = extentOf(values);
  if (extent === null) return null;
  const { min, max } = extent;
  if (min === max) return { counts: [values.length], min, max, step: 1 };

  let integers = true;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isInteger(values[i])) {
      integers = false;
      break;
    }
  }

  const span = max - min;
  // Integer data never gets more bins than it has distinct values to fill.
  const count = integers ? Math.min(binCount, span + 1) : binCount;
  const width = span / count;
  const counts = new Array<number>(count).fill(0);
  for (let i = 0; i < values.length; i++) {
    const at = Math.min(count - 1, Math.floor((values[i] - min) / width));
    counts[at]++;
  }
  // Integer data steps by whole numbers, but never by less than a hundredth
  // of the range: date epochs are integers too, and a bracket that moves one
  // millisecond per key press is not adjustable.
  const step = integers && span >= 1 ? Math.max(1, Math.round(span / 100)) : span / 100;
  return { counts, min, max, step };
}
