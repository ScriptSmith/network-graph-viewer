export function formatNumber(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
