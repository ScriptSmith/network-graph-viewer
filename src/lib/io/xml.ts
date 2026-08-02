import type { CellValue, Column, ColumnType, Row, Table } from "../../types";
import { asNumber } from "../parse";

/**
 * Shared plumbing for the two XML graph formats. Both are read with the
 * platform's own DOMParser and written with XMLSerializer, which is why
 * neither needs a library. The parts that are about tables rather than about
 * XML (`coerce`, `cellToText`, `tableFrom`, `uniqueName`) are DOT's too.
 */

export const SVG_NS = "http://www.w3.org/2000/svg";

export function parseXml(text: string, what: string): Document {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const failure = doc.querySelector("parsererror");
  if (failure) {
    throw new Error(`That ${what} file could not be parsed: ${failure.textContent?.trim()}`);
  }
  return doc;
}

/** Declared attribute types map onto the three column types we keep. */
export function columnTypeFrom(declared: string | null): ColumnType {
  switch ((declared ?? "").toLowerCase()) {
    case "integer":
    case "int":
    case "long":
    case "float":
    case "double":
    case "decimal":
      return "number";
    case "boolean":
    case "bool":
      return "bool";
    default:
      return "text";
  }
}

export function declaredTypeFor(type: ColumnType): string {
  if (type === "number") return "double";
  if (type === "bool") return "boolean";
  return "string";
}

/**
 * Coerce a raw attribute string into the column's type. "yes" counts as true
 * because the type inference behind a DOT column counts it as a boolean; the
 * two XML formats spell their booleans out.
 */
export function coerce(raw: string, type: ColumnType): CellValue {
  if (raw === "") return null;
  if (type === "number") return asNumber(raw);
  if (type === "bool") {
    const word = raw.trim().toLowerCase();
    return word === "true" || word === "yes";
  }
  return raw;
}

export function cellToText(value: CellValue): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * Assemble a table from rows built as loose maps, filling every column on
 * every row so downstream code never has to test for missing keys.
 */
export function tableFrom(name: string, columns: Column[], rows: Row[]): Table {
  const filled = rows.map((row) => {
    const full: Row = {};
    for (const column of columns) full[column.name] = row[column.name] ?? null;
    return full;
  });
  return { name, columns, rows: filled };
}

/** A column name that has not been used yet in this list. */
export function uniqueName(taken: Set<string>, wanted: string): string {
  const base = wanted.trim() === "" ? "Attribute" : wanted.trim();
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base} ${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

export function serialize(doc: Document): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}`;
}
