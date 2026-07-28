import type { CellValue, Column } from "../types";

export function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/**
 * A cell as it should read on screen. Computed metrics get rounded, because
 * seventeen digits of PageRank is noise; imported values are shown exactly as
 * they arrived, because those digits are the user's and might mean something.
 */
export function displayCell(column: Column, value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (column.computed && typeof value === "number") return formatMetric(value);
  return String(value);
}

/** Metric formatting: two significant digits below 1, one decimal above. */
export function formatMetric(v: number | null): string {
  if (v === null || !isFinite(v)) return "–";
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) < 1) return Number(v.toPrecision(2)).toString();
  return v.toFixed(1);
}
