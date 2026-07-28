import type { CellValue } from "../types";

/** A cell as a node id: trimmed, with blanks becoming null. */
export function cellToId(v: CellValue): string | null {
  if (v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Stable string key for a cell value; blanks collapse to "". */
export function cellKey(v: CellValue): string {
  return v === null ? "" : String(v).trim();
}

/**
 * Compound keys join their parts with a unit separator, which cannot appear in
 * a spreadsheet cell, so ids containing spaces or punctuation can't collide.
 */
const SEP = String.fromCharCode(31);

/** Stable key for a directed edge between two node ids. */
export function edgeKey(source: string, target: string): string {
  return `${source}${SEP}${target}`;
}
