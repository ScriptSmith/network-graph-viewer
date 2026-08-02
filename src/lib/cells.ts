import type { CellValue, ColumnType } from "../types";

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
 * Read typed text back into a cell, so an edit leaves the column holding what
 * it held before. Text that will not parse stays text: a number column with one
 * stray word in it is better than a hole where the word was.
 */
export function parseCell(type: ColumnType, raw: string): CellValue {
  if (raw.trim() === "") return null;
  if (type === "number") {
    const value = Number(raw);
    return isNaN(value) ? raw : value;
  }
  if (type === "bool") {
    const lowered = raw.trim().toLowerCase();
    if (["true", "yes", "1"].includes(lowered)) return true;
    if (["false", "no", "0"].includes(lowered)) return false;
  }
  return raw;
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

/** A compound key over any parts, joined the same collision-proof way. */
export function compoundKey(...parts: (string | number)[]): string {
  return parts.join(SEP);
}

/** A compound key back into its parts. */
export function splitKey(key: string): string[] {
  return key.split(SEP);
}
