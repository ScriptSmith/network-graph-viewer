export function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Metric formatting: two significant digits below 1, one decimal above. */
export function formatMetric(v: number | null): string {
  if (v === null || !isFinite(v)) return "–";
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) < 1) return Number(v.toPrecision(2)).toString();
  return v.toFixed(1);
}
